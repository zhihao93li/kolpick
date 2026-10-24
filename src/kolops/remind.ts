import { addDays, day, linkIds, option, text } from "./base.js";
import { mailboxFor, type Config } from "./config.js";
import type { Ctx } from "./ctx.js";
import { displayName, loadSnapshot, profileEmails, profileOf, type Snapshot } from "./data.js";
import type { Row } from "./lark.js";
import { today } from "./ops.js";
import { deliver, type Outgoing, type SendReport, type Skipped } from "./send.js";
import { syncInbox, type SyncReport } from "./sync.js";
import { loadTemplates, MissingValue, pickTemplate, render } from "./templates.js";

export const REMIND_PURPOSES = ["催信 1", "催信 2"];

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
  const templates = await loadTemplates(ctx.base, cfg);
  const missing = REMIND_PURPOSES.filter((purpose) => !pickTemplate(templates, purpose));
  if (missing.length) throw new Error(`「模板」表里还没有已批准的${missing.map((m) => `「${m}」`).join("")}模板，批准后才能自动催`);

  const sync = await syncInbox(ctx, { dryRun: o.dryRun });
  const s = await loadSnapshot(ctx.base, cfg);
  const counts = await reminderCounts(ctx, s);
  const todayStr = today(cfg);

  const items: Outgoing[] = [];
  const closes: Record<string, Record<string, unknown>> = {};
  const report: RemindReport = { sync, send: { sent: [], skipped: [], failed: [], dryRun: o.dryRun }, closed: [], notChased: [], waiting: 0 };

  for (const f of s.followups.values()) {
    if (option(f["阶段"]) !== "已邀约") continue;
    const name = displayName(s, f);
    const step = nextStep(cfg, f, counts.get(f.record_id) ?? 0, todayStr);
    if (step.kind === "wait") report.waiting++;
    if (step.kind === "skip") {
      if (!step.reason.includes("之前邀约")) report.notChased.push({ key: f.record_id, name, reason: step.reason });
      continue;
    }
    if (step.kind === "close") {
      closes[f.record_id] = { 阶段: ["结案"], 结案原因: ["无回应"], 当前轮到谁: ["无需动作"], 下一步: `${todayStr} 催了 2 次都没回，自动结案` };
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
    let mail;
    try {
      mail = render(pickTemplate(templates, `催信 ${step.n}`, text(p?.["語言"]))!, { 稱呼: text(p?.["称呼"]) || name, 称呼: text(p?.["称呼"]) || name, 账号名称: name });
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
    filter: { logic: "and", conditions: [["方向", "intersects", ["发出"]], ["日期", ">=", `ExactDate(${ctx.cfg.followup.onlyInvitedOnOrAfter})`]] },
    fields: ["摘要", "KOL", "方向", "日期"],
  });
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!text(r["摘要"]).startsWith("[催信]")) continue;
    for (const id of linkIds(r["KOL"])) if (s.followups.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
