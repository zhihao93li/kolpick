import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Base, cellTime, dayOf, linkIds, option, type Fields } from "./base.js";
import type { Config } from "./config.js";
import { authHint, REQUIRED_SCOPES, type Lark } from "./lark.js";

export function dataDir(): string {
  const dir = process.env.KOL_DATA_DIR || join(homedir(), ".kol-ops");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** "YYYY-MM-DD HH:mm" in the base's offset, the format Base accepts for date and datetime cells. */
export function stamp(ms = Date.now(), tz = "+08:00"): string {
  const sign = tz.startsWith("-") ? -1 : 1;
  const [h, m] = tz.slice(1).split(":").map(Number);
  return new Date(ms + sign * (h * 60 + (m || 0)) * 60_000).toISOString().slice(0, 16).replace("T", " ");
}

export function today(cfg: Config, ms = Date.now()): string {
  return dayOf(ms, cfg.timezone);
}

/** The 运行 names of commands that write. 运行记录 rows start with these, which sync and the send lock rely on. */
export const RUN_TITLES = { sync: "收信同步", send: "发出已批准的信", invite: "发邀约", remind: "催信和结案", find: "找 KOL", classify: "补全档案" } as const;
const SENDING_RUNS: string[] = [RUN_TITLES.send, RUN_TITLES.invite, RUN_TITLES.remind];
/** A sending run older than this is treated as dead, so a crash can't block sending for good. */
const LOCK_MINUTES = 30;

/**
 * Another run that is sending mail right now, whoever's computer it is on. Each run writes its 运行记录
 * row before it sends, so two runs started together both see each other and both stand down.
 */
export async function otherSendingRun(base: Base, cfg: Config, selfId: string): Promise<string> {
  const rows = await base.records(cfg.tables.runs, {
    filter: { logic: "and", conditions: [["结果", "intersects", ["进行中"]]] },
    fields: ["运行", "开始时间", "结果"],
  });
  const cutoff = Date.now() - LOCK_MINUTES * 60_000;
  const busy = rows.find((r) => r.record_id !== selfId
    && SENDING_RUNS.some((title) => String(r["运行"] ?? "").startsWith(title))
    && (cellTime(r["开始时间"], cfg.timezone) ?? 0) >= cutoff);
  return busy ? `「${busy["运行"]}」从 ${stamp(cellTime(busy["开始时间"], cfg.timezone)!, cfg.timezone)} 起正在发信，等它跑完再发（超过 ${LOCK_MINUTES} 分钟还没结束的会自动放行）` : "";
}

/** How 接触记录 marks a bounce; sync writes it and the bounce-rate gate counts it. */
export const BOUNCE_MARK = "[退信]";
/** The bounce-rate gate looks at this many days, and only once a mailbox has sent at least this many mails. */
const BOUNCE_WINDOW_DAYS = 14;
const BOUNCE_MIN_SENT = 20;

/** Per mailbox channel: mails sent and bounces filed in the last two weeks. */
export async function bounceStats(base: Base, cfg: Config): Promise<Map<string, { sent: number; bounced: number }>> {
  const since = dayOf(Date.now() - BOUNCE_WINDOW_DAYS * 86_400_000, cfg.timezone);
  const rows = await base.records(cfg.tables.contacts, {
    filter: { logic: "and", conditions: [["日期", ">=", `ExactDate(${since})`]] },
    fields: ["方向", "渠道", "摘要", "日期"],
  });
  const stats = new Map<string, { sent: number; bounced: number }>();
  for (const r of rows) {
    const ch = option(r["渠道"]);
    const s = stats.get(ch) ?? { sent: 0, bounced: 0 };
    if (option(r["方向"]) === "发出") s.sent++;
    else if (String(r["摘要"] ?? "").startsWith(BOUNCE_MARK)) s.bounced++;
    stats.set(ch, s);
  }
  return stats;
}

/** Why a mailbox must stop sending because too much of its mail bounced, or "". */
export function bouncePaused(mb: { address: string; channel: string; bouncePause: number }, stats: Map<string, { sent: number; bounced: number }>): string {
  const s = stats.get(mb.channel);
  if (!s || s.sent < BOUNCE_MIN_SENT || mb.bouncePause <= 0) return "";
  const rate = (s.bounced / s.sent) * 100;
  if (rate < mb.bouncePause) return "";
  return `${mb.address} 最近 ${BOUNCE_WINDOW_DAYS} 天退信率 ${rate.toFixed(1)}%（发 ${s.sent} 封退 ${s.bounced} 封），`
    + `到了暂停线 ${mb.bouncePause}%，先停发。请检查退信的邮箱，确认没问题后可在「发信邮箱」里调高这个邮箱的暂停线`;
}

export interface Me {
  id: string;
  name: string;
}

export async function whoami(lark: Lark): Promise<Me> {
  const data = await lark.json(["contact", "+get-user", "--as", "user", "--format", "json"]);
  const u = data?.user ?? data;
  return { id: String(u?.open_id ?? u?.user_id ?? ""), name: String(u?.name ?? u?.en_name ?? "") };
}

/** `kol check`: whether lark-cli is logged in with every scope the commands need. Needs no scope itself. */
export async function checkAuth(lark: Lark) {
  const status = await lark.json(["auth", "status"]);
  const user = status?.identities?.user;
  const granted = new Set(String(user?.scope ?? "").split(/\s+/).filter(Boolean));
  const missing = REQUIRED_SCOPES.filter((s) => !granted.has(s));
  return {
    飞书账号: user?.userName ?? "（没有登录）",
    权限齐全: Boolean(user) && missing.length === 0,
    ...(missing.length ? { 缺少的权限: missing, 怎么补: authHint(missing) } : {}),
  };
}

/**
 * A local record of every send, written before the mail goes out. If a run dies between sending and
 * writing back to the base, the next run finds the "sending" entry and stops instead of sending again.
 */
export class Journal {
  private file = join(dataDir(), "sends.jsonl");
  private entries = new Map<string, { state: string; messageId?: string }>();

  constructor() {
    if (!existsSync(this.file)) return;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      this.entries.set(e.key, e);
    }
  }

  get(key: string) {
    return this.entries.get(key);
  }

  mark(key: string, state: "sending" | "sent" | "recorded" | "failed", messageId?: string): void {
    const e = { key, state, messageId, at: new Date().toISOString() };
    this.entries.set(key, e);
    appendFileSync(this.file, JSON.stringify(e) + "\n");
  }
}

/** Today's outbound counts from 接触记录, shared by everyone's runs because they all write there. */
export interface SendCounts {
  byChannel: Map<string, Set<string>>;
  all: Set<string>;
}

export async function todaysSends(base: Base, cfg: Config): Promise<SendCounts> {
  const rows = await base.records(cfg.tables.contacts, {
    filter: { logic: "and", conditions: [["方向", "intersects", ["发出"]], ["日期", "==", `ExactDate(${today(cfg)})`]] },
    fields: ["渠道", "KOL", "方向", "日期"],
  });
  const counts: SendCounts = { byChannel: new Map(), all: new Set() };
  for (const r of rows) {
    const who = linkIds(r["KOL"])[0] ?? r.record_id;
    const ch = option(r["渠道"]);
    if (!counts.byChannel.has(ch)) counts.byChannel.set(ch, new Set());
    counts.byChannel.get(ch)!.add(who);
    counts.all.add(who);
  }
  return counts;
}

/** One 运行记录 row per command run, with its 操作日志 rows linked to it. */
export class Run {
  id = "";
  counts = { 处理来信: 0, 发出邮件: 0, 新增待审: 0 };
  notes: string[] = [];
  private ops: Fields[] = [];

  constructor(private base: Base, private cfg: Config, private title: string, private me: Me, private scheduled: boolean) {}

  async start(): Promise<void> {
    [this.id] = await this.base.create(this.cfg.tables.runs, [{
      运行: `${this.title}（${this.me.name || "未知"}）`,
      方式: [this.scheduled ? "定时任务" : "对话中手动"],
      结果: ["进行中"],
      开始时间: stamp(Date.now(), this.cfg.timezone),
    }]);
  }

  op(o: { type: string; result: string; action: string; detail?: string; followup?: string; recipients?: string; body?: string; sent?: number }): void {
    this.ops.push({
      类型: [o.type],
      结果: [o.result],
      操作: o.action,
      说明: `${o.detail ?? ""}${o.detail ? "\n" : ""}执行人：${this.me.name || this.me.id}`,
      ...(o.recipients ? { 收件人明细: o.recipients } : {}),
      ...(o.body ? { 邮件正文: o.body.slice(0, 5000) } : {}),
      ...(o.sent != null ? { 发送数: o.sent } : {}),
      时间: stamp(Date.now(), this.cfg.timezone),
      ...(o.followup ? { KOL: [{ id: o.followup }] } : {}),
      ...(this.id ? { 所属运行: [{ id: this.id }] } : {}),
    });
  }

  /** Writes queued 操作日志 rows; called after each batch so a crash loses little. */
  async flush(): Promise<void> {
    if (!this.ops.length) return;
    const batch = this.ops.splice(0);
    await this.base.create(this.cfg.tables.oplog, batch);
  }

  async finish(result: "完成" | "部分完成" | "失败"): Promise<void> {
    await this.flush();
    if (!this.id) return;
    await this.base.update(this.cfg.tables.runs, {
      [this.id]: {
        结果: [result],
        结束时间: stamp(Date.now(), this.cfg.timezone),
        处理来信: this.counts.处理来信,
        发出邮件: this.counts.发出邮件,
        新增待审: this.counts.新增待审,
        ...(this.notes.length ? { 问题与备注: this.notes.join("\n").slice(0, 5000) } : {}),
      },
    });
  }
}
