import { loadConfig, type LocalConfig } from "./config.js";
import { type Db, one } from "./db/db.js";
import { LarkCli, type Lark } from "./lark.js";
import { Mail } from "./mail.js";
import { withDefaults, type Settings } from "./settings.js";
import { TafuApi } from "./tafu.js";

export interface Project {
  id: number;
  name: string;
  settings: Settings;
  paused: boolean;
}

/** What every tool works with. Tests build one with fakes. */
export interface Ctx {
  db: Db;
  cfg: LocalConfig;
  lark: Lark;
  mail: Mail;
  tafu: (p: Project) => TafuApi;
  now: () => number;
  /** Waits between sends; tests make it instant. */
  sleep: (ms: number) => Promise<void>;
}

export function makeCtx(db: Db, over: Partial<Ctx> = {}): Ctx {
  const cfg = over.cfg ?? loadConfig();
  const lark = over.lark ?? new LarkCli();
  return {
    db,
    cfg,
    lark,
    mail: over.mail ?? new Mail(lark),
    tafu: over.tafu ?? ((p) => new TafuApi(p.settings.dataApiUrl, cfg.keys[p.name] ?? {})),
    now: over.now ?? Date.now,
    sleep: over.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

export async function project(ctx: Ctx, name?: string): Promise<Project> {
  const row = await one<any>(ctx.db, "select id, name, settings, paused from projects where name = $1", [name ?? ctx.cfg.project]);
  if (!row) throw new Error(`数据库里没有项目「${name ?? ctx.cfg.project}」`);
  return { id: row.id, name: row.name, settings: withDefaults(row.settings), paused: row.paused };
}

export async function addLog(ctx: Ctx, p: Project, e: { kind: string; summary: string; who?: string; kolId?: number | null; proposalId?: number | null; detail?: unknown }): Promise<void> {
  await ctx.db.query("insert into log (project_id, at, kind, who, kol_id, proposal_id, summary, detail) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [p.id, new Date(ctx.now()).toISOString(), e.kind, e.who ?? "operator", e.kolId ?? null, e.proposalId ?? null, e.summary, e.detail == null ? null : JSON.stringify(e.detail)]);
}

/** The project's day (its timezone) that a moment falls on: "YYYY-MM-DD". */
export function dayOf(ms: number, tz: string): string {
  const sign = tz.startsWith("-") ? -1 : 1;
  const [h, m] = tz.slice(1).split(":").map(Number);
  return new Date(ms + sign * (h * 60 + m) * 60_000).toISOString().slice(0, 10);
}

/** Start of the project's day as an ISO moment. */
export function dayStart(ms: number, tz: string): string {
  return new Date(`${dayOf(ms, tz)}T00:00:00${tz}`).toISOString();
}
