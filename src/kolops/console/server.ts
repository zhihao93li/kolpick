import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Ctx } from "../ctx.js";
import { today } from "../ops.js";
import { PAGE } from "./page.js";
import { activityLog, cardMails, ConsoleData, decisionCards, peopleView, personDetail, runStatus, VIEWS, viewCounts, type MailText, type ViewKey } from "./state.js";

/** How often the console re-reads what changed in the base while it is open. */
const REFRESH_MS = 5 * 60_000;

/**
 * `kol console`: a page on this computer only (127.0.0.1) showing what waits on the user, every KOL by stage,
 * one KOL's history, and what the background did. This first version only reads.
 */
export async function startConsole(ctx: Ctx, o: { port?: number; openBrowser: boolean }): Promise<{ url: string; server: Server }> {
  const data = new ConsoleData(ctx);
  let loading: Promise<void> | null = null;
  let mails: { at: number; map: Map<string, MailText> } = { at: -1, map: new Map() };
  const refresh = () => (loading ??= data.refresh().finally(() => (loading = null)));
  await refresh();
  const timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
  timer.unref();

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
    if (req.method === "POST" && url.pathname === "/api/refresh") {
      await refresh();
      return send(res, 200, { loadedAt: data.loadedAt });
    }
    if (req.method !== "GET") return send(res, 405, { error: "这一版只读" });
    if (url.pathname === "/api/overview") {
      if (mails.at !== data.loadedAt) mails = { at: data.loadedAt, map: await cardMails(ctx, data) };
      const { cards, waitingClaude } = decisionCards(data, ctx.cfg, day, mails.map);
      return send(res, 200, {
        project: ctx.cfg.project, me: ctx.me.name, loadedAt: data.loadedAt, today: day,
        cards, waitingClaude, status: await runStatus(ctx, data),
        views: Object.entries(VIEWS).map(([key, v]) => ({ key, label: v.label })), counts: viewCounts(data, ctx.cfg, day),
      });
    }
    if (url.pathname === "/api/people") {
      const view = (url.searchParams.get("view") ?? "wait") as ViewKey;
      if (!(view in VIEWS)) return send(res, 400, { error: `没有这个视图：${view}` });
      const { rows, total } = peopleView(data, ctx.cfg, view, day, url.searchParams.get("q") ?? "");
      return send(res, 200, { view, ...VIEWS[view], rows, total });
    }
    if (url.pathname === "/api/person") {
      const detail = await personDetail(ctx, data, url.searchParams.get("id") ?? "");
      return detail ? send(res, 200, detail) : send(res, 404, { error: "找不到这位 KOL 的跟进记录" });
    }
    if (url.pathname === "/api/log") return send(res, 200, await activityLog(ctx));
    return send(res, 404, { error: "没有这个地址" });
  }

  const url = await listen(server, o.port);
  if (o.openBrowser) openInBrowser(url);
  return { url, server };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Listens on the given port, or the first free one from 4173. */
async function listen(server: Server, port?: number): Promise<string> {
  const tries = port ? [port] : Array.from({ length: 20 }, (_, i) => 4173 + i);
  for (const p of tries) {
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(p, "127.0.0.1", () => resolve(true));
    });
    if (ok) return `http://127.0.0.1:${p}/`;
  }
  throw new Error(port ? `端口 ${port} 被占用了，换一个 --port 试试` : "4173 到 4192 的端口都被占用了，用 --port 指定一个");
}

function openInBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
