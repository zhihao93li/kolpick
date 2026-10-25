import { Base, day, emailsIn, linkIds, option, text } from "./base.js";
import type { Config } from "./config.js";
import { cachedRecords } from "./cache.js";
import type { Row } from "./lark.js";

/** The parts of the base that most commands need, read once per run. */
export interface Snapshot {
  profiles: Map<string, Row>;
  followups: Map<string, Row>;
  /** Every address belonging to a 永不联系 profile, so a duplicate profile can't slip past. */
  doNotContact: Set<string>;
  /** Lower-cased address -> followup record ids that list it. */
  followupsByEmail: Map<string, string[]>;
}

export const PROFILE_FIELDS = ["账号", "账号名称", "称呼", "主页链接", "公开邮箱", "其他邮箱", "联系许可", "联系许可原因",
  "粉丝数", "主要平台", "内容类型", "市场", "入库批次", "跟进记录"];
export const FOLLOWUP_FIELDS = ["账号名称", "档案", "阶段", "当前轮到谁", "级别", "对方要求", "联系渠道", "邀约批次",
  "首次邀约日期", "下次跟进日期", "最近联系日期", "最后来信日期", "下一步", "结案原因",
  "体验码", "体验码上限", "体验码已用", "体验码到期", "体验码最近使用", "活动码", "约定发布日期"];

export async function loadSnapshot(base: Base, cfg: Config): Promise<Snapshot> {
  const t = cfg.tables;
  const [profiles, followups] = await Promise.all([
    cachedRecords(base, t.profiles, PROFILE_FIELDS, cfg.timezone),
    cachedRecords(base, t.followups, FOLLOWUP_FIELDS, cfg.timezone),
  ]);
  return buildSnapshot(profiles, followups);
}

export function buildSnapshot(profiles: Row[], followups: Row[]): Snapshot {
  const s: Snapshot = {
    profiles: new Map(profiles.map((r) => [r.record_id, r])),
    followups: new Map(followups.map((r) => [r.record_id, r])),
    doNotContact: new Set(),
    followupsByEmail: new Map(),
  };
  for (const p of profiles) {
    if (option(p["联系许可"]) === "永不联系") for (const e of profileEmails(p)) s.doNotContact.add(e);
  }
  for (const f of followups) {
    for (const e of followupEmails(s, f)) {
      const list = s.followupsByEmail.get(e) ?? [];
      list.push(f.record_id);
      s.followupsByEmail.set(e, list);
    }
  }
  return s;
}

export function profileEmails(p: Row | undefined): string[] {
  if (!p) return [];
  return [...new Set([...emailsIn(p["公开邮箱"]), ...emailsIn(p["其他邮箱"])])];
}

export function profileOf(s: Snapshot, f: Row | undefined): Row | undefined {
  return f ? s.profiles.get(linkIds(f["档案"])[0] ?? "") : undefined;
}

export function followupEmails(s: Snapshot, f: Row): string[] {
  return profileEmails(profileOf(s, f));
}

/** Why this followup must not be emailed at all, or "" when it may be. */
export function blockedReason(s: Snapshot, f: Row, recipient: string): string {
  const p = profileOf(s, f);
  if (!p) return "跟进记录没有关联档案";
  if (option(p["联系许可"]) === "永不联系") return `永不联系（${text(p["联系许可原因"]) || "未写原因"}）`;
  if (s.doNotContact.has(recipient.toLowerCase())) return "这个邮箱属于一位永不联系的 KOL";
  return "";
}

export function displayName(s: Snapshot, f: Row): string {
  const p = profileOf(s, f);
  return text(f["账号名称"]) || text(p?.["账号名称"]) || text(p?.["账号"]) || f.record_id;
}

export function ownerIds(f: Row): string[] {
  return Array.isArray(f["负责人"]) ? f["负责人"].map((u: any) => String(u.id)) : [];
}

export { day };
