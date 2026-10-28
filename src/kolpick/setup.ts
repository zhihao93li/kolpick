/**
 * Setting up this computer from the console (docs/design.md 安装和第一次设置): which values are filled in (never the
 * values themselves), whether lark-cli, claude and codex are ready, and saving what the operator types in.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanEnv } from "./agent.js";
import { saveConfig, type LocalConfig } from "./config.js";
import { connect, migrate } from "./db/db.js";

/** What sending, reading and watching the project's mail needs from the Feishu login. */
export const MAIL_SCOPES = ["mail:user_mailbox:readonly", "mail:user_mailbox.message:readonly", "mail:user_mailbox.message.address:read",
  "mail:user_mailbox.message.subject:read", "mail:user_mailbox.message.body:read", "mail:user_mailbox.message:modify", "mail:user_mailbox.message:send", "mail:event", "mail:user_mailbox.event.mail_address:read"].join(" ");

export interface Check {
  ok: boolean;
  /** What the operator sees: what is ready, or what is missing. */
  note: string;
  /** A command to paste into the terminal when the page can't do it. */
  fix?: string;
}

const lark = () => process.env.KOLPICK_LARK_CLI || "lark-cli";

function run(bin: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ out: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: "utf8", timeout: 15_000, env }, (err: any, stdout, stderr) =>
      resolve({ out: `${stdout ?? ""}${stderr ?? ""}`, missing: err?.code === "ENOENT" }));
  });
}

function json(s: string): any {
  try {
    return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
}

/** lark-cli: installed, has the company's Feishu app, and is signed in with the mail permissions. */
async function larkChecks(): Promise<{ cli: Check; app: Check; auth: Check }> {
  const st = await run(lark(), ["auth", "status"]);
  if (st.missing) {
    const no = { ok: false, note: "先装好 lark-cli" };
    return { cli: { ok: false, note: "没装 lark-cli", fix: "npm install -g @larksuite/cli" }, app: no, auth: no };
  }
  const cli = { ok: true, note: "已安装" };
  const s = json(st.out);
  if (!s?.appId) return { cli, app: { ok: false, note: "还没配飞书应用：填管理员给的 App ID 和 App Secret" }, auth: { ok: false, note: "先配好飞书应用" } };
  const app = { ok: true, note: `飞书应用 ${s.appId}` };
  if (loginRun?.state === "waiting") return { cli, app, auth: { ok: false, note: "等你在飞书授权页点同意…" } };
  const c = json((await run(lark(), ["auth", "check", "--scope", MAIL_SCOPES])).out);
  if (c?.ok) return { cli, app, auth: { ok: true, note: `已授权${s.identities?.user?.userName ? `：${s.identities.user.userName}` : ""}` } };
  const failed = loginRun?.state === "failed" ? `（上次授权没成：${loginRun.note}）` : "";
  return { cli, app, auth: { ok: false, note: `收发信的飞书权限不齐，点「去飞书授权」${failed}` } };
}

async function claudeCheck(): Promise<Check> {
  const r = await run("claude", ["auth", "status"], cleanEnv());
  if (r.missing) return { ok: false, note: "没装 Claude Code", fix: "npm install -g @anthropic-ai/claude-code" };
  const s = json(r.out);
  // auth status can't skip personal settings the way the agent does, so an API key there doesn't count against it.
  if (s?.loggedIn && /claude\.ai|oauth/.test(String(s.authMethod))) return { ok: true, note: `已用订阅登录${s.email ? `：${s.email}` : ""}` };
  return { ok: false, note: s?.loggedIn ? "登录的不是 Claude 订阅" : "还没登录", fix: "claude auth login --claudeai" };
}

async function codexCheck(): Promise<Check> {
  const r = await run("codex", ["login", "status"]);
  if (r.missing) return { ok: false, note: "没装 Codex（可选）", fix: "npm install -g @openai/codex" };
  if (/logged in/i.test(r.out) && !/not logged in/i.test(r.out)) return { ok: true, note: "已登录" };
  return { ok: false, note: "还没登录", fix: "codex login" };
}

/** Old kol-ops left its keys on this computer: take the ones still missing. Nothing depends on it being there. */
export function fromKolOps(cfg: LocalConfig): void {
  const old = join(homedir(), ".kol-ops", "projects.json");
  if (existsSync(old)) {
    const o = JSON.parse(readFileSync(old, "utf8"));
    for (const [name, v] of Object.entries<any>(o.projects ?? {})) {
      if (name.endsWith("-test")) continue;
      const k = (cfg.keys[name] ??= {});
      k.dataApi ??= v.dataApiKey;
      k.trial ??= v.trialKey;
      k.partner ??= v.partnerKey;
    }
  }
  const token = join(homedir(), ".kol-ops", "apify-token");
  if (!cfg.apifyToken && existsSync(token)) cfg.apifyToken = readFileSync(token, "utf8").trim() || undefined;
}

export const ready = (cfg: LocalConfig) => !!(process.env.KOLPICK_DATABASE_URL || cfg.databases[cfg.env]);

/** What the setup page and「这台电脑」show. */
export async function setupStatus(cfg: LocalConfig) {
  const keys = cfg.keys[cfg.project] ?? {};
  const [l, claude, codex] = await Promise.all([larkChecks(), claudeCheck(), codexCheck()]);
  return {
    ready: ready(cfg), env: cfg.env, project: cfg.project, agent: cfg.agent.kind,
    filled: { testDb: !!cfg.databases.test, prodDb: !!cfg.databases.prod, dataApi: !!keys.dataApi, trial: !!keys.trial, partner: !!keys.partner, apify: !!cfg.apifyToken },
    checks: { lark: l.cli, larkApp: l.app, larkAuth: l.auth, claude, codex },
  };
}

async function tryDb(url: string, current: boolean, projectName: string): Promise<void> {
  const db = connect(url);
  try {
    await db.query("select 1");
    if (current) {
      await migrate(db);
      if (!(await db.query("select 1 from projects where name = $1", [projectName])).length) throw new Error(`这个库里没有项目「${projectName}」`);
    }
  } catch (err: any) {
    throw new Error(`连不上这个数据库：${String(err?.message ?? err).slice(0, 200)}`);
  } finally {
    await db.end().catch(() => {});
  }
}

/**
 * Saves what the operator typed; empty fields keep what is there. `env` picks the database to use. Database URLs are
 * tried first. In the running service (`live` false) the database in use doesn't change until kolpick opens again,
 * so the service keeps reporting the one it is connected to; dbChanged says a reopen is needed.
 */
export async function saveSetup(cfg: LocalConfig, b: Record<string, unknown>, live = true): Promise<{ dbChanged: boolean }> {
  const val = (k: string) => (typeof b[k] === "string" && (b[k] as string).trim() ? (b[k] as string).trim() : undefined);
  const env = b.env === "prod" || b.env === "test" ? b.env : cfg.env;
  const dbs = { test: val("testDb"), prod: val("prodDb") };
  if (!dbs[env] && !cfg.databases[env] && !process.env.KOLPICK_DATABASE_URL) throw new Error(`先填${env === "prod" ? "正式" : "测试"}库的连接串`);
  for (const e of ["test", "prod"] as const) if (dbs[e]) await tryDb(dbs[e]!, e === env, cfg.project);
  // Switching to a database saved earlier: it has to work too.
  if (env !== cfg.env && !dbs[env] && cfg.databases[env]) await tryDb(cfg.databases[env]!, true, cfg.project);
  const dbChanged = env !== cfg.env || (!!dbs[env] && dbs[env] !== cfg.databases[env]);
  for (const e of ["test", "prod"] as const) if (dbs[e]) cfg.databases[e] = dbs[e];
  const keys = (cfg.keys[cfg.project] ??= {});
  if (val("dataApi")) keys.dataApi = val("dataApi");
  if (val("trial")) keys.trial = val("trial");
  if (val("partner")) keys.partner = val("partner");
  if (val("apify")) cfg.apifyToken = val("apify");
  if (live) cfg.env = env;
  saveConfig({ ...cfg, env });
  return { dbChanged };
}

/** Points lark-cli at the company's Feishu app; the secret goes through stdin, never the process list. */
export function larkApp(appId: string, secret: string): Promise<void> {
  if (!/^cli_\w+$/.test(appId.trim()) || !secret.trim()) return Promise.reject(new Error("App ID 是 cli_ 开头的一串，App Secret 不能空"));
  return new Promise((resolve, reject) => {
    const child = spawn(lark(), ["config", "init", "--app-id", appId.trim(), "--app-secret-stdin", "--brand", "feishu", "--lang", "zh_cn"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => reject(new Error(`启动 lark-cli 失败：${e.message}`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`配置飞书应用失败：${out.trim().slice(0, 300)}`))));
    child.stdin.end(secret.trim() + "\n");
  });
}

/** The Feishu sign-in in progress: started from the page, finished when the operator agrees in the browser. */
let loginRun: { state: "waiting" | "done" | "failed"; note: string; child?: ChildProcess } | undefined;

/** Starts the Feishu sign-in for the mail permissions; returns the page the operator opens to agree. */
export async function larkLogin(): Promise<{ url: string }> {
  loginRun?.child?.kill();
  const r = json((await run(lark(), ["auth", "login", "--scope", MAIL_SCOPES, "--no-wait", "--json"])).out);
  if (!r?.verification_url || !r.device_code) throw new Error("飞书没给出授权链接，稍后再试");
  const child = spawn(lark(), ["auth", "login", "--device-code", r.device_code], { stdio: ["ignore", "pipe", "pipe"] });
  const run_ = (loginRun = { state: "waiting", note: "", child });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => {
    if (loginRun !== run_) return;
    loginRun = code === 0 ? { state: "done", note: "" } : { state: "failed", note: out.trim().split("\n").pop()?.slice(0, 200) ?? "" };
  });
  return { url: r.verification_url };
}
