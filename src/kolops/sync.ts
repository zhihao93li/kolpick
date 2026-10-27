import { cellTime, day, emailsIn, isoSeconds, onOrAfter, option, text } from "./base.js";
import type { Ctx } from "./ctx.js";
import { blockedReason, displayName, loadSnapshot, type Snapshot } from "./data.js";
import { addressOf, type MailSummary } from "./mail.js";
import { BOUNCE_MARK, RUN_TITLES, stamp, today } from "./ops.js";
import { closedFrom, reopenChanges } from "./reopen.js";
import type { Mailbox } from "./config.js";

const BOUNCE_SENDER = /mailer-daemon|postmaster|mail-noreply.*bounce|delivery-?status/i;
/** Out-of-office and "we got your mail" answers: filed, but not a reply that stops the 催信. */
const AUTO_REPLY = /自動回覆|自动回复|自動回復|auto[- ]?reply|automatic reply|out of (the )?office|不在辦公室|不在办公室|休假中|已收到您的來信|已收到您的来信/i;
/** Senders that are never a person answering us; left out of the unknown-sender list. */
const NOT_A_PERSON = /no-?reply|notifications?@|newsletter|mailer@|marketing@/i;
/** How far back to read when there is no earlier sync to start from, and the most to read in any case. */
const DEFAULT_DAYS = 3;
const MAX_DAYS = 30;
const MAX_PER_MAILBOX = 400;

export interface SyncReport {
  since: string;
  mailboxes: string[];
  newReplies: { name: string; from: string; subject: string; date: string }[];
  autoReplies: { name: string; subject: string }[];
  bounces: { name: string; address: string }[];
  /** Bounces for KOLs who have written to us before: not closed, left 待处理 for someone to fix the address (R-04). */
  bouncesToCheck: { name: string; address: string }[];
  /** Mail from an address several open KOLs share: left for someone to say whose it is (E-11). */
  ambiguous: { mailbox: string; from: string; subject: string; date: string; kols: string[] }[];
  /** False when a mailbox had more mail than one read takes: the automatic rules wait for a full read (G-3). */
  complete: boolean;
  /** Mail from addresses not in any 档案: an agent, a manager or a new address may be a KOL answering. */
  unknownSenders: { mailbox: string; from: string; subject: string; date: string }[];
  alreadySynced: number;
  warnings: string[];
}

/**
 * `kol sync`: reads each mailbox's inbox since the last finished sync (a day of overlap, deduplicated by
 * Message ID), files mail from known KOLs into 接触记录 and flips their followup to 轮到我们.
 * Mail from addresses not in the base is filed without a KOL and left 待处理, for a person to say whose it is.
 */
export async function syncInbox(ctx: Ctx, opts: { days?: number; dryRun: boolean }): Promise<SyncReport> {
  const t = ctx.cfg.tables;
  const since = opts.days ? Date.now() - opts.days * 86_400_000 : await lastSync(ctx);
  const sinceIso = isoSeconds(since, ctx.cfg.timezone);
  const s = await loadSnapshot(ctx.base, ctx.cfg);
  const known = await ctx.base.records(t.contacts, {
    filter: { logic: "and", conditions: [onOrAfter("日期", day(since - 86_400_000, ctx.cfg.timezone))] },
    fields: ["Message ID"],
  });
  const seen = new Set(known.map((r) => text(r["Message ID"])).filter(Boolean));

  const report: SyncReport = {
    since: stamp(since, ctx.cfg.timezone), mailboxes: [], newReplies: [], autoReplies: [], bounces: [], bouncesToCheck: [],
    unknownSenders: [], ambiguous: [], alreadySynced: 0, warnings: [], complete: true,
  };
  const contacts: Record<string, unknown>[] = [];
  const followupChanges: Record<string, Record<string, unknown>> = {};
  const ours = new Set(ctx.cfg.mailboxes.map((m) => m.address.toLowerCase()));

  for (const mb of ctx.cfg.mailboxes) {
    const mails = await ctx.mail.list(mb.address, { folder: "INBOX", time_range: { start_time: sinceIso } }, MAX_PER_MAILBOX);
    report.mailboxes.push(`${mb.address}：${mails.length} 封`);
    if (mails.length >= MAX_PER_MAILBOX) {
      report.complete = false;
      report.warnings.push(`${mb.address} 从 ${report.since} 起超过 ${MAX_PER_MAILBOX} 封，只读了一部分。请用 --days 1 分几次补同步`);
    }
    for (const m of mails) {
      if (seen.has(m.message_id)) {
        report.alreadySynced++;
        continue;
      }
      seen.add(m.message_id);
      const from = addressOf(m.from);
      // Search results carry ISO dates, plain listings "YYYY-MM-DD HH:mm" in the mailbox's zone; cellTime reads both.
      const when = cellTime(m.date, ctx.cfg.timezone) ?? Date.now();
      if (BOUNCE_SENDER.test(from)) {
        await handleBounce(ctx, s, mb, m, when, report, followupChanges, contacts);
        continue;
      }
      const fids = s.followupsByEmail.get(from);
      if (!fids?.length) {
        if (!ours.has(from) && !NOT_A_PERSON.test(from) && !AUTO_REPLY.test(m.subject)) {
          report.unknownSenders.push({ mailbox: mb.address, from, subject: m.subject, date: m.date });
          // Filed without a KOL, so the decision console can show it and someone can say whose it is.
          contacts.push({
            方向: ["收到"], 渠道: [mb.channel], "Message ID": m.message_id, 摘要: m.subject.slice(0, 200),
            内容: `发件人：${from}`, 日期: stamp(when, ctx.cfg.timezone), 待处理: true,
          });
        }
        continue;
      }
      const fid = pickFollowup(s, fids);
      if (!fid) {
        // Several KOLs still being followed share this address: whose mail it is, a person says (E-11).
        if (AUTO_REPLY.test(m.subject)) continue;
        const kols = fids.map((id) => displayName(s, s.followups.get(id)!));
        report.ambiguous.push({ mailbox: mb.address, from, subject: m.subject, date: m.date, kols });
        contacts.push({
          方向: ["收到"], 渠道: [mb.channel], "Message ID": m.message_id, 摘要: m.subject.slice(0, 200),
          内容: `发件人：${from}（${kols.join("、")} 都用这个邮箱）`, 日期: stamp(when, ctx.cfg.timezone), 待处理: true,
        });
        continue;
      }
      const f = s.followups.get(fid)!;
      if (AUTO_REPLY.test(m.subject)) {
        contacts.push({
          方向: ["收到"], 渠道: [mb.channel], "Message ID": m.message_id, 摘要: `[自动回复] ${m.subject}`.slice(0, 200),
          日期: stamp(when, ctx.cfg.timezone), 待处理: false, KOL: [{ id: fid }],
        });
        report.autoReplies.push({ name: displayName(s, f), subject: m.subject });
        continue;
      }
      contacts.push({
        方向: ["收到"], 渠道: [mb.channel], "Message ID": m.message_id, 摘要: m.subject.slice(0, 200),
        日期: stamp(when, ctx.cfg.timezone), 待处理: true, KOL: [{ id: fid }],
      });
      const stage = option(f["阶段"]);
      const closed = stage === "结案";
      // A closed followup opens again when she writes (R-05), unless she is 永不联系: then the mail is kept and
      // nothing else moves, so the followup stays closed with nobody's turn (T-1, P-6).
      const neverAgain = closed && Boolean(blockedReason(s, f, from));
      followupChanges[fid] = {
        ...followupChanges[fid],
        最后来信日期: stamp(when, ctx.cfg.timezone),
        ...(neverAgain ? {} : { 当前轮到谁: ["我们"] }),
        ...(stage === "已邀约" ? { 阶段: ["已回复"] } : {}),
        ...(closed && !neverAgain ? reopenChanges(f, today(ctx.cfg)) : {}),
      };
      report.newReplies.push({ name: displayName(s, f), from, subject: m.subject, date: m.date });
    }
  }

  ctx.run.counts.处理来信 = report.newReplies.length;
  if (!opts.dryRun) {
    if (contacts.length) await ctx.base.create(t.contacts, contacts);
    if (Object.keys(followupChanges).length) await ctx.base.update(t.followups, followupChanges);
    for (const r of report.newReplies) ctx.run.op({ type: "来信处理", result: "完成", action: `收到来信：${r.name}`, detail: r.subject });
    for (const r of report.autoReplies) ctx.run.op({ type: "来信处理", result: "完成", action: `自动回复（不算回信）：${r.name}`, detail: r.subject });
    for (const b of report.bounces) ctx.run.op({ type: "来信处理", result: "退信", action: `退信结案：${b.name}`, detail: b.address });
    for (const b of report.bouncesToCheck) ctx.run.op({ type: "来信处理", result: "退信", action: `退信，没结案，要换邮箱：${b.name}`, detail: b.address });
  }
  return report;
}

/**
 * Where to start reading: the start of the last sync that finished in full (sync runs on its own and inside
 * remind), minus a day of overlap. A 部分完成 run may have left mail unread, so it doesn't count. Read from
 * 运行记录 so it holds whichever computer ran it.
 */
async function lastSync(ctx: Ctx): Promise<number> {
  const now = Date.now();
  const runs = await ctx.base.records(ctx.cfg.tables.runs, {
    filter: { logic: "and", conditions: [["结果", "intersects", ["完成"]]] },
    fields: ["运行", "开始时间", "结果"],
  });
  const starts = runs
    .filter((r) => [RUN_TITLES.sync, RUN_TITLES.remind].some((title) => text(r["运行"]).startsWith(title)))
    .map((r) => cellTime(r["开始时间"], ctx.cfg.timezone))
    .filter((ms): ms is number => ms != null && ms <= now);
  if (!starts.length) return now - DEFAULT_DAYS * 86_400_000;
  return Math.max(Math.max(...starts) - 86_400_000, now - MAX_DAYS * 86_400_000);
}

/**
 * Whose mail it is when several followups share the address (E-10): the one still open when only one is, or the
 * only one there is. Two or more open ones, or several closed ones and none open, is for a person to say: "".
 */
export function pickFollowup(s: Snapshot, ids: string[]): string {
  const open = ids.filter((id) => option(s.followups.get(id)?.["阶段"]) !== "结案");
  if (open.length === 1) return open[0];
  if (!open.length && ids.length === 1) return ids[0];
  return "";
}

/**
 * Files the bounce in 接触记录 as 「[退信] 地址」 (the row the per-mailbox bounce-rate gate counts; its Message ID
 * keeps it from being read twice) and applies R-04: a KOL who was invited and never wrote back is closed; anyone
 * further along stays open and the bounce stays 待处理, for someone to find her another address. A bounce whose
 * address isn't recognised stays 待处理 too, and moves nobody.
 */
async function handleBounce(ctx: Ctx, s: Snapshot, mb: Mailbox, m: MailSummary, when: number, report: SyncReport,
                            changes: Record<string, Record<string, unknown>>, contacts: Record<string, unknown>[]): Promise<void> {
  // The bounce names the failed address in its body, not its headers.
  const data = await ctx.base.lark.json(["mail", "+messages", "--mailbox", mb.address, "--message-ids", m.message_id,
    "--html=false", "--as", "user"]).catch(() => null);
  const body = JSON.stringify(data ?? "");
  const failed = [...new Set(emailsIn(body))].filter((addr) => addr !== mb.address && !BOUNCE_SENDER.test(addr) && s.followupsByEmail.has(addr));
  let toCheck = "";
  for (const addr of failed) {
    for (const fid of s.followupsByEmail.get(addr) ?? []) {
      const f = s.followups.get(fid)!;
      const stage = option(f["阶段"]);
      if (stage === "结案") continue;
      if (stage === "已邀约" && !text(f["最后来信日期"])) {
        changes[fid] = { ...changes[fid], 阶段: ["结案"], 结案原因: ["退信或邮箱无效"], 当前轮到谁: ["无需动作"],
          下一步: `${stamp(when, ctx.cfg.timezone).slice(0, 10)} 发往 ${addr} 的信被退回${closedFrom(f)}` };
        report.bounces.push({ name: displayName(s, f), address: addr });
      } else {
        toCheck ||= fid;
        report.bouncesToCheck.push({ name: displayName(s, f), address: addr });
      }
    }
  }
  const linked = toCheck || (failed.length ? s.followupsByEmail.get(failed[0])![0] : "");
  contacts.push({
    方向: ["收到"], 渠道: [mb.channel], "Message ID": m.message_id, 日期: stamp(when, ctx.cfg.timezone),
    待处理: !failed.length || Boolean(toCheck),
    摘要: `${BOUNCE_MARK} ${failed.join(", ") || "（没认出是哪个地址）"}`.slice(0, 200),
    ...(linked ? { KOL: [{ id: linked }] } : {}),
  });
}
