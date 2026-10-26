import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Ctx } from "../ctx.js";
import { today } from "../ops.js";
import { approve, closeFollowup, drop, todoDone, findOptions, isPaused, Jobs, logPost, mailDone, manualSent, mailLink, mailNever, problemDone, revise, setPaused, startFind, updateFollowup, writeMail } from "./actions.js";
import { PAGE } from "./page.js";
import { backup, hasBackupToday } from "../store/db.js";
import { StoreLark } from "../store/pg.js";
import { activityLog, cardMails, ConsoleData, decisionCards, newsSince, peopleView, personDetail, runStatus, VIEWS, viewCounts, type MailText, type ViewKey } from "./state.js";

/** How often the console re-reads what changed in the base while it is open. */
const REFRESH_MS = 5 * 60_000;
/** Every write from the page carries this header; a form on another website can't send it without a preflight we never answer. */
const WRITE_HEADER = "x-kol-console";

/**
 * `kol console`: a page on this computer only (127.0.0.1) showing what waits on the user, every KOL by stage,
 * one KOL's history and what the background did. Decisions made here are written to the base at once; sending,
 * codes and finding people are queued for the executor.
 */
export async function startConsole(ctx: Ctx, o: { port?: number; openBrowser: boolean }): Promise<{ url: string; server: Server; jobs: Jobs }> {
  const data = new ConsoleData(ctx);
  let loading: Promise<void> | null = null;
  let mails: { at: number; map: Map<string, MailText> } = { at: -1, map: new Map() };
  const refresh = () => (loading ??= data.refresh().finally(() => (loading = null)));
  const refreshSoon = () => void refresh().catch(() => {});
  const jobs = new Jobs(ctx, refreshSoon);
  // Decisions write 同意来源 and friends; a base that hasn't been given them yet can be looked at but not changed.
  let setupNeeded: string[] = [];
  // The page opens at once and waits on this: the first read of a large base takes a minute or two.
  const ready = Promise.all([
    refresh(),
    Promise.all([ctx.base.fieldNames(ctx.cfg.tables.reviews), ctx.base.fieldNames(ctx.cfg.tables.settings)]).then(([reviewFields, settingFields]) => {
      setupNeeded = [
        ...["同意来源", "同意人", "同意时间", "内容指纹"].filter((f) => !reviewFields?.includes(f)).map((f) => `审核队列.${f}`),
        ...["执行电脑", "只认决策台的同意"].filter((f) => !settingFields?.includes(f)).map((f) => `设置.${f}`),
      ];
    }),
  ]);
  ready.catch((err) => console.error(`出错：读飞书数据失败：${err?.message ?? err}`));
  const timer = setInterval(refreshSoon, REFRESH_MS);
  timer.unref();
  // A project kept in Postgres is backed up once a day while the console is open.
  const store = ctx.base.lark instanceof StoreLark ? ctx.base.lark.storeFor(ctx.cfg.baseToken) : null;
  if (store) {
    const daily = () => {
      if (!hasBackupToday(store.project)) backup(store.sql, store.project).catch((err) => console.error(`出错：数据库备份失败：${err?.message ?? err}`));
    };
    daily();
    setInterval(daily, 3600_000).unref();
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { error: String(err?.message ?? err) }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const host = String(req.headers.host ?? "");
    // Only this computer's browser: refuse requests addressed to any other name (DNS rebinding).
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: "只能在这台电脑上用 127.0.0.1 打开" });
    const url = new URL(req.url ?? "/", `http://${host}`);
    const day = today(ctx.cfg);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(PAGE);
    }
    await ready;
    if (req.method === "GET") {
      if (url.pathname === "/api/overview") {
        if (mails.at !== data.loadedAt) mails = { at: data.loadedAt, map: await cardMails(ctx, data) };
        const { cards, waitingClaude } = decisionCards(data, ctx.cfg, day, mails.map);
        return send(res, 200, {
          project: ctx.cfg.project, me: ctx.me.name, loadedAt: data.loadedAt, today: day, paused: await isPaused(ctx), setupNeeded,
          cards, waitingClaude, status: await runStatus(ctx, data), jobs: jobs.list,
          views: Object.entries(VIEWS).map(([key, v]) => ({ key, label: v.label })), counts: viewCounts(data, ctx.cfg, day),
        });
      }
      if (url.pathname === "/api/jobs") return send(res, 200, { jobs: jobs.list });
      if (url.pathname === "/api/people") {
        const view = (url.searchParams.get("view") ?? "wait") as ViewKey;
        if (!(view in VIEWS)) return send(res, 400, { error: `没有这个视图：${view}` });
        const { rows, total } = peopleView(data, ctx.cfg, view, day, url.searchParams.get("q") ?? "");
        return send(res, 200, { view, ...VIEWS[view], rows, total });
      }
      if (url.pathname === "/api/person") {
        const detail = await personDetail(ctx, data, url.searchParams.get("id") ?? "", url.searchParams.get("all") === "1");
        return detail ? send(res, 200, detail) : send(res, 404, { error: "找不到这位 KOL 的跟进记录" });
      }
      if (url.pathname === "/api/log") return send(res, 200, await activityLog(ctx));
      if (url.pathname === "/api/news") return send(res, 200, await newsSince(ctx, data, Number(url.searchParams.get("since")) || Date.now() - 86_400_000));
      if (url.pathname === "/api/find-options") return send(res, 200, { batches: await findOptions(ctx) });
      return send(res, 404, { error: "没有这个地址" });
    }

    if (req.method !== "POST") return send(res, 405, { error: "不支持这个请求" });
    if (req.headers[WRITE_HEADER] !== "1" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      return send(res, 403, { error: "只接受决策台页面自己发出的操作" });
    }
    if (url.pathname === "/api/refresh") {
      await refresh();
      return send(res, 200, { loadedAt: data.loadedAt });
    }
    if (setupNeeded.length) {
      return send(res, 409, { error: `这个项目的飞书表还缺 ${setupNeeded.join("、")}，决策台现在只能看。请在执行电脑上运行 kol setup-base（先加 --dry-run 看会加什么），然后重新打开决策台` });
    }
    const b = await body(req);
    const done = (extra: Record<string, unknown> = {}) => {
      refreshSoon();
      return send(res, 200, { ok: true, ...extra });
    };
    switch (url.pathname) {
      case "/api/approve": return done({ job: await approve(ctx, data, jobs, String(b.id), b.edits ?? {}) });
      case "/api/sent-by-hand": await manualSent(ctx, data, String(b.id), b.edits ?? {}); return done();
      case "/api/revise": await revise(ctx, String(b.id), String(b.note ?? "")); return done();
      case "/api/drop": await drop(ctx, String(b.id), String(b.note ?? "")); return done();
      case "/api/problem-done": await problemDone(ctx, String(b.id)); return done();
      case "/api/todo-done": await todoDone(ctx, String(b.id)); return done();
      case "/api/mail-done": await mailDone(ctx, ids(b.id)); return done();
      case "/api/mail-never": await mailNever(ctx, data, ids(b.id)); return done();
      case "/api/mail-link": await mailLink(ctx, data, ids(b.id), String(b.followup ?? "")); return done();
      case "/api/post": await logPost(ctx, data, String(b.id), String(b.link ?? "")); return done();
      case "/api/followup": await updateFollowup(ctx, data, String(b.id), b.fields ?? {}); return done();
      case "/api/close": await closeFollowup(ctx, data, String(b.id), { never: Boolean(b.never), reason: b.reason }); return done();
      case "/api/write": return done({ job: await writeMail(ctx, data, jobs, String(b.id), String(b.subject ?? ""), String(b.body ?? "")) });
      case "/api/find": return done({ job: startFind(jobs, b) });
      case "/api/pause": return done({ paused: await setPaused(ctx, Boolean(b.on)) });
      default: return send(res, 404, { error: "没有这个操作" });
    }
  }

  const url = await listen(server, o.port);
  if (o.openBrowser) openInBrowser(url);
  return { url, server, jobs };
}

/** One id or several, comma-separated. */
function ids(v: unknown): string[] {
  const list = String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!list.length) throw new Error("没有说是哪一条");
  return list;
}

async function body(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("请求太大");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("请求的内容不是 JSON");
  }
}

function send(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

/** Listens on the given port (0 for any free one), or the first free one from 4173. */
async function listen(server: Server, port?: number): Promise<string> {
  const tries = port != null ? [port] : Array.from({ length: 20 }, (_, i) => 4173 + i);
  for (const p of tries) {
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(p, "127.0.0.1", () => resolve(true));
    });
    // Port 0 asks the system for any free port; read back which one it gave.
    if (ok) return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  }
  throw new Error(port ? `端口 ${port} 被占用了，换一个 --port 试试` : "4173 到 4192 的端口都被占用了，用 --port 指定一个");
}

function openInBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
