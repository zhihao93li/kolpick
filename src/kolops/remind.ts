import { addDays, day, linkIds, onOrAfter, option, text } from "./base.js";
import { mailboxFor, type Config } from "./config.js";
import type { Ctx } from "./ctx.js";
import { displayName, loadSnapshot, profileEmails, profileOf, type Snapshot } from "./data.js";
import type { Row } from "./lark.js";
import { BOUNCE_MARK, today } from "./ops.js";
import { closedFrom } from "./reopen.js";
import { openMailItems } from "./reviews.js";
import { deliver, type Outgoing, type SendReport, type Skipped } from "./send.js";
import { syncInbox, type SyncReport } from "./sync.js";
import { loadTemplates, MissingValue, pickTemplate, render } from "./templates.js";

export type Step = { kind: "remind"; n: 1 | 2 } | { kind: "close" } | { kind: "skip"; reason: string } | { kind: "wait" };

/**
 * What the follow-up rules say to do with one followup today. `reminders` is how many 催信 the plugin
 * has already sent; `lastIn` is the day of the KOL's last mail, if any.
 */
export function nextStep(cfg: Config, f: Row, reminders: number, todayStr: string): Step {
  const r = cfg.followup;
  if (option(f["阶段"]) !== "已邀约") return { kind: "skip", reason: "不在「已邀约」阶段" };
  if (!r.onlyInvitedOnOrAfter) return { kind: "skip", reason: "「设置」里没填自动催信起始日，不自动催" };
  const invited = day(f["首次邀约日期"], cfg.timezone);
  if (!invited || invited < r.onlyInvitedOnOrAfter) return { kind: "skip", reason: `${r.onlyInvitedOnOrAfter} 之前邀约的不自动催` };
  const lastIn = day(f["最后来信日期"], cfg.timezone);
  if (lastIn && lastIn >= invited) return { kind: "skip", reason: "对方回过信" };
  if (option(f["当前轮到谁"]) !== "KOL") return { kind: "skip", reason: "不是在等 KOL 回信" };
  if (r.skipLevels.includes(option(f["级别"]))) return { kind: "skip", reason: `${option(f["级别"])} 级不自动催` };
  if (r.skipDemands.includes(option(f["对方要求"]))) return { kind: "skip", reason: "要固定费的不自动催" };
  if (r.skipChannels.includes(option(f["联系渠道"]))) return { kind: "skip", reason: `${option(f["联系渠道"])} 联系的不自动催` };
  const due = day(f["下次跟进日期"], cfg.timezone);
  if (due && due > todayStr) return { kind: "wait" };
  if (reminders >= 2) return { kind: "close" };
  return { kind: "remind", n: (reminders + 1) as 1 | 2 };
}

export interface RemindReport {
  sync: SyncReport;
  /** Why no one was chased or closed today (G-2, G-3), or absent when the rules ran. */
  held?: string;
  send: SendReport;
  closed: string[];
  notChased: Skipped[];
  waiting: number;
}

/**
 * `kol remind`: syncs the inbox first (so nobody who just replied gets chased), then sends the 1st or
 * 2nd 催信, or closes as 无回应 once both went unanswered for the configured days.
 */
export async function remind(ctx: Ctx, o: { dryRun: boolean }): Promise<RemindReport> {
  const cfg = ctx.cfg;
  const t = cfg.tables;
  if (!cfg.followup.onlyInvitedOnOrAfter) throw new Error("「设置」表里没填「自动催信起始日」，所以不自动催。填上之后，这天及以后发出的邀约才会自动催");
  // A missing template only stops that reminder: the inbox is still read, and people chased twice are still closed.
  const templates = await loadTemplates(ctx.base, cfg);

  const sync = await syncInbox(ctx, { dryRun: o.dryRun });
  const empty: RemindReport = { sync, send: { sent: [], skipped: [], failed: [], dryRun: o.dryRun }, closed: [], notChased: [], waiting: 0 };
  // Reading only part of a mailbox could miss the very answer that would stop a reminder (G-3).
  if (!sync.complete) return { ...empty, held: "有邮箱这次没把信收全（超过一次能读的数量），今天先不催、不结案。补收全以后再跑" };
  // A mail nobody has matched to a KOL yet may be one of them answering from a new address (G-2).
  const unclaimed = await unclaimedMail(ctx);
  if (unclaimed) return { ...empty, held: `有 ${unclaimed} 封来信还对不上 KOL，可能是有人换了邮箱回信。今天先不催、不结案；在决策台关联或标成跟 KOL 无关以后再跑` };

  const [s, open] = await Promise.all([loadSnapshot(ctx.base, cfg), openMailItems(ctx)]);
  const counts = await reminderCounts(ctx, s);
  const todayStr = today(cfg);

  const items: Outgoing[] = [];
  const closes: Record<string, Record<string, unknown>> = {};
  const report: RemindReport = empty;

  for (const f of s.followups.values()) {
    if (option(f["阶段"]) !== "已邀约") continue;
    const name = displayName(s, f);
    if (open.has(f.record_id)) {
      // Her one place for a mail is taken (I-1): that mail goes first, and nothing closes her under it.
      report.notChased.push({ key: f.record_id, name, reason: "已经有一封待发或没发成的信，先处理那一封" });
      continue;
    }
    const step = nextStep(cfg, f, counts.get(f.record_id) ?? 0, todayStr);
    if (step.kind === "wait") report.waiting++;
    if (step.kind === "skip") {
      if (!step.reason.includes("之前邀约")) report.notChased.push({ key: f.record_id, name, reason: step.reason });
      continue;
    }
    if (step.kind === "close") {
      closes[f.record_id] = { 阶段: ["结案"], 结案原因: ["无回应"], 当前轮到谁: ["无需动作"], 下一步: `${todayStr} 催了 2 次都没回，自动结案${closedFrom(f)}` };
      report.closed.push(name);
      continue;
    }
    if (step.kind !== "remind") continue;
    const mailbox = mailboxFor(cfg, option(f["联系渠道"]));
    const email = profileEmails(profileOf(s, f))[0];
    if (!mailbox || !email) {
      report.notChased.push({ key: f.record_id, name, reason: !mailbox ? "联系渠道不是插件的飞书邮箱" : "档案里没有邮箱" });
      continue;
    }
    const p = profileOf(s, f);
    const tpl = pickTemplate(templates, `催信 ${step.n}`, text(p?.["語言"]));
    if (!tpl) {
      report.notChased.push({ key: f.record_id, name, reason: `「模板」表里还没有已批准的「催信 ${step.n}」模板` });
      continue;
    }
    let mail;
    try {
      mail = render(tpl, { 稱呼: text(p?.["称呼"]) || name, 称呼: text(p?.["称呼"]) || name, 账号名称: name });
    } catch (err) {
      if (!(err instanceof MissingValue)) throw err;
      report.notChased.push({ key: f.record_id, name, reason: err.message });
      continue;
    }
    const next = addDays(todayStr, step.n === 1 ? cfg.followup.secondAfterDays : cfg.followup.closeAfterDays);
    items.push({
      key: `remind:${f.record_id}:${step.n}`, followupId: f.record_id, name, recipient: email, mailbox,
      // The template's own subject: a reminder that isn't threaded under the invitation shouldn't pose as a "Re:".
      subject: mail.subject, body: mail.body, oncePerDay: true, kind: "催信",
      after: { followup: { 下次跟进日期: `${next} 10:00`, 下一步: `${todayStr} 发了第 ${step.n} 次催信，${next} ${step.n === 1 ? "再催一次" : "还没回就结案"}` } },
    });
  }

  report.send = await deliver(ctx, items, s, o.dryRun);
  if (!o.dryRun && Object.keys(closes).length) {
    await ctx.base.update(t.followups, closes);
    for (const name of report.closed) ctx.run.op({ type: "飞书变更", result: "完成", action: `结案（无回应）：${name}` });
  }
  return report;
}

/** 催信 the plugin already sent, per followup, read from 接触记录 so every colleague's runs count. */
async function reminderCounts(ctx: Ctx, s: Snapshot): Promise<Map<string, number>> {
  const rows = await ctx.base.records(ctx.cfg.tables.contacts, {
    filter: { logic: "and", conditions: [["方向", "intersects", ["发出"]], onOrAfter("日期", ctx.cfg.followup.onlyInvitedOnOrAfter)] },
    fields: ["摘要", "KOL", "方向", "日期"],
  });
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!text(r["摘要"]).startsWith("[催信]") || day(r["日期"], ctx.cfg.timezone) < ctx.cfg.followup.onlyInvitedOnOrAfter) continue;
    for (const id of linkIds(r["KOL"])) if (s.followups.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Inbound mail still 待处理 that no KOL is linked to: someone's mail waiting to be claimed. Bounces aren't anyone
 * writing to us, so they don't count.
 */
async function unclaimedMail(ctx: Ctx): Promise<number> {
  const rows = await ctx.base.records(ctx.cfg.tables.contacts, {
    filter: { logic: "and", conditions: [["待处理", "==", true], ["方向", "intersects", ["收到"]]] },
    fields: ["KOL", "摘要", "待处理", "方向"],
  });
  return rows.filter((r) => !linkIds(r["KOL"]).length && !text(r["摘要"]).startsWith(BOUNCE_MARK)).length;
}
