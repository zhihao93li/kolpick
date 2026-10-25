import { cellTime, dayOf, option, text } from "./base.js";
import type { Lark, Row } from "./lark.js";
import { SETTING_DEFAULTS, TABLES } from "./schema.js";

export interface Mailbox {
  address: string;
  /** The option name this mailbox has in the 渠道 / 联系渠道 / 发送渠道 selects. */
  channel: string;
  dailyExternal: number;
  /** Bounce rate (percent) at which this mailbox stops sending. */
  bouncePause: number;
}

/** One project's settings, read from its base's 设置 and 发信邮箱 tables at the start of each command. */
export interface Config {
  project: string;
  baseToken: string;
  timezone: string;
  tables: typeof TABLES;
  mailboxes: Mailbox[];
  companyDailyExternal: number;
  perMinute: number;
  followup: {
    firstAfterDays: number;
    secondAfterDays: number;
    closeAfterDays: number;
    /** Only invitations sent on or after this day are chased automatically; "" chases none. */
    onlyInvitedOnOrAfter: string;
    skipLevels: string[];
    skipDemands: string[];
    skipChannels: string[];
  };
  /** Skip inviting an address another project contacted within this many days. */
  crossProjectCooldownDays: number;
  discovery: { country: string; language: string };
  /** Defaults for a trial code when the 审核队列 item leaves 体验次数 / 体验天数 empty. */
  trial: { maxUses: number; days: number };
  /** After how many days 体验跟进 nudges an unused or stalled trial, and how close to expiry it asks about extending. */
  trialNudge: { unusedDays: number; stalledDays: number; expiringDays: number };
  /** Partner campaigns: the default fan discount, and profile 市场 → sales market pairs from 活动码市场. */
  partner: { percentOff: number; markets: [string, string][] };
  webhook: string;
  dataApi: string;
}

// Not on spaces: option names such as 「IG 私信」 contain them.
const listOf = (v: unknown) => text(v).split(/[,，、;；\n]+/).map((s) => s.trim()).filter(Boolean);

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(text(v));
  return text(v) === "" || Number.isNaN(n) ? fallback : n;
}

export async function loadConfig(lark: Lark, project: string, baseToken: string): Promise<Config> {
  let settings: Row[], mailboxes: Row[];
  try {
    [settings, mailboxes] = await Promise.all([
      lark.records(TABLES.settings, { baseToken }),
      lark.records(TABLES.mailboxes, { baseToken }),
    ]);
  } catch (err: any) {
    if (/auth|授权|权限/i.test(String(err?.message))) throw err;
    throw new Error(`读不到项目「${project}」飞书表里的「${TABLES.settings}」或「${TABLES.mailboxes}」表。`
      + `这张表还没升级的话，先运行 kol setup-base（会先试跑）。原始错误：${err?.message ?? err}`);
  }
  if (!settings.length) throw new Error(`项目「${project}」的「${TABLES.settings}」表是空的。运行 kol setup-base 会写入一行默认设置`);
  return configFrom(project, baseToken, settings[0], mailboxes);
}

/** Pure: the settings row and mailbox rows as a Config, with defaults for empty cells. */
export function configFrom(project: string, baseToken: string, s: Row, mailboxRows: Row[]): Config {
  const timezone = text(s["时区"]) || SETTING_DEFAULTS.时区;
  const pause = num(s["退信率暂停线"], SETTING_DEFAULTS.退信率暂停线);
  const startAt = cellTime(s["自动催信起始日"], timezone);
  return {
    project, baseToken, timezone, tables: TABLES,
    mailboxes: mailboxRows
      .filter((m) => m["启用"] === true && text(m["邮箱"]))
      .map((m) => ({
        address: text(m["邮箱"]).toLowerCase(),
        channel: text(m["渠道名"]) || text(m["邮箱"]).toLowerCase(),
        dailyExternal: num(m["每日上限"], 50),
        bouncePause: num(m["退信率暂停线"], pause),
      })),
    companyDailyExternal: num(s["全公司每日上限"], SETTING_DEFAULTS.全公司每日上限),
    perMinute: num(s["每分钟上限"], SETTING_DEFAULTS.每分钟上限),
    followup: {
      firstAfterDays: num(s["第一次催信天数"], SETTING_DEFAULTS.第一次催信天数),
      secondAfterDays: num(s["第二次催信天数"], SETTING_DEFAULTS.第二次催信天数),
      closeAfterDays: num(s["结案天数"], SETTING_DEFAULTS.结案天数),
      onlyInvitedOnOrAfter: startAt == null ? "" : dayOf(startAt, timezone),
      skipLevels: listOf(s["不催级别"]),
      skipDemands: listOf(s["不催的对方要求"]),
      skipChannels: listOf(s["不催渠道"]),
    },
    crossProjectCooldownDays: num(s["跨项目冷却天数"], SETTING_DEFAULTS.跨项目冷却天数),
    discovery: { country: text(s["找人国家"]), language: text(s["找人语言"]) },
    trial: { maxUses: num(s["体验码默认次数"], SETTING_DEFAULTS.体验码默认次数), days: num(s["体验码默认天数"], SETTING_DEFAULTS.体验码默认天数) },
    trialNudge: {
      unusedDays: num(s["体验未用提醒天数"], SETTING_DEFAULTS.体验未用提醒天数),
      stalledDays: num(s["体验停滞提醒天数"], SETTING_DEFAULTS.体验停滞提醒天数),
      expiringDays: num(s["体验到期提醒天数"], SETTING_DEFAULTS.体验到期提醒天数),
    },
    partner: {
      percentOff: num(s["活动码粉丝折扣"], SETTING_DEFAULTS.活动码粉丝折扣),
      markets: listOf(s["活动码市场"]).map((pair) => pair.split(/[=＝]/).map((x) => x.trim()) as [string, string]).filter(([a, b]) => a && b),
    },
    webhook: text(s["飞书群机器人"]),
    dataApi: text(s["业务数据接口"]),
  };
}

export function mailboxFor(cfg: Config, channel: string): Mailbox | undefined {
  const c = channel.trim().toLowerCase();
  return cfg.mailboxes.find((m) => m.channel.toLowerCase() === c || m.address === c);
}

/** Whether 暂停所有发送 is ticked right now; read fresh before sending, not from the Config. */
export async function sendingPaused(lark: Lark, baseToken: string): Promise<boolean> {
  const rows = await lark.records(TABLES.settings, { baseToken, fields: ["暂停所有发送"] });
  return rows.some((r) => r["暂停所有发送"] === true || option(r["暂停所有发送"]) === "true");
}
