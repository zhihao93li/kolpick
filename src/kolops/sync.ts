import { cellTime, day, emailsIn, onOrAfter, option, text } from "./base.js";
import type { Ctx } from "./ctx.js";
import { displayName, loadSnapshot, type Snapshot } from "./data.js";
import { addressOf, type MailSummary } from "./mail.js";
import { BOUNCE_MARK, RUN_TITLES, stamp } from "./ops.js";
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
  /** Mail from addresses not in any 档案: an agent, a manager or a new address may be a KOL answering. */
  unknownSenders: { mailbox: string; from: string; subject: string; date: string }[];
  alreadySynced: number;
  warnings: string[];
}

/**
 * `kol sync`: reads each mailbox's inbox since the last finished sync (a day of overlap, deduplicated by
 * Message ID), files mail from known KOLs into 接触记录 and flips their followup to 轮到我们.
 * Mail from addresses not in the base is listed for a person to look at, not filed.
 */
export async function syncInbox(ctx: Ctx, opts: { days?: number; dryRun: boolean }): Promise<SyncReport> {
  const t = ctx.cfg.tables;
  const since = opts.days ? Date.now() - opts.days * 86_400_000 : await lastSync(ctx);
  const sinceIso = new Date(since).toISOString().replace("Z", "+00:00");
  const s = await loadSnapshot(ctx.base, ctx.cfg);
  const known = await ctx.base.records(t.contacts, {
    filter: { logic: "and", conditions: [onOrAfter("日期", day(since - 86_400_000, ctx.cfg.timezone))] },
    fields: ["Message ID"],
  });
  const seen = new Set(known.map((r) => text(r["Message ID"])).filter(Boolean));

  const report: SyncReport = {
    since: stamp(since, ctx.cfg.timezone), mailboxes: [], newReplies: [], autoReplies: [], bounces: [],
    unknownSenders: [], alreadySynced: 0, warnings: [],
  };
  const contacts: Record<string, unknown>[] = [];
  const followupChanges: Record<string, Record<string, unknown>> = {};
  const ours = new Set(ctx.cfg.mailboxes.map((m) => m.address.toLowerCase()));

  for (const mb of ctx.cfg.mailboxes) {
    const mails = await ctx.mail.list(mb.address, { folder: "INBOX", time_range: { start_time: sinceIso } }, MAX_PER_MAILBOX);
    report.mailboxes.push(`${mb.address}：${mails.length} 封`);
    if (mails.length >= MAX_PER_MAILBOX) {
      report.warnings.push(`${mb.address} 从 ${report.since} 起超过 ${MAX_PER_MAILBOX} 封，只读了一部分。请用 --days 1 分几次补同步`);
    }
    for (const m of mails) {
      if (seen.has(m.message_id)) {
        report.alreadySynced++;
        continue;
      }
      seen.add(m.message_id);
      const from = addressOf(m.from);
      const when = Number.isNaN(Date.parse(m.date)) ? Date.now() : Date.parse(m.date);
      if (BOUNCE_SENDER.test(from)) {
        await handleBounce(ctx, s, mb, m, when, report, followupChanges, contacts);
        continue;
      }
      const fids = s.followupsByEmail.get(from);
      if (!fids?.length) {
        if (!ours.has(from) && !NOT_A_PERSON.test(from)) {
          report.unknownSenders.push({ mailbox: mb.address, from, subject: m.subject, date: m.date });
        }
        continue;
      }
      const fid = pickFollowup(s, fids);
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
      followupChanges[fid] = {
        ...followupChanges[fid],
        最后来信日期: stamp(when, ctx.cfg.timezone),
        当前轮到谁: ["我们"],
        ...(stage === "已邀约" ? { 阶段: ["已回复"] } : {}),
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
  }
  return report;
}

/**
 * Where to start reading: the start of the last sync that finished (sync runs on its own and inside remind),
 * minus a day of overlap. Read from 运行记录 so it holds whichever computer ran it.
 */
async function lastSync(ctx: Ctx): Promise<number> {
  const now = Date.now();
  const runs = await ctx.base.records(ctx.cfg.tables.runs, {
    filter: { logic: "and", conditions: [["结果", "intersects", ["完成", "部分完成"]]] },
    fields: ["运行", "开始时间", "结果"],
  });
  const starts = runs
    .filter((r) => [RUN_TITLES.sync, RUN_TITLES.remind].some((title) => text(r["运行"]).startsWith(title)))
    .map((r) => cellTime(r["开始时间"], ctx.cfg.timezone))
    .filter((ms): ms is number => ms != null && ms <= now);
  if (!starts.length) return now - DEFAULT_DAYS * 86_400_000;
  return Math.max(Math.max(...starts) - 86_400_000, now - MAX_DAYS * 86_400_000);
}

/** Several followups can share an address; prefer one that is still open. */
function pickFollowup(s: Snapshot, ids: string[]): string {
  return ids.find((id) => !["结案"].includes(option(s.followups.get(id)?.["阶段"]))) ?? ids[0];
}

/**
 * Closes the followups whose address bounced and files the bounce in 接触记录 as 「[退信] 地址」: that row is
 * what the per-mailbox bounce-rate gate counts, and its Message ID keeps the bounce from being read twice.
 */
async function handleBounce(ctx: Ctx, s: Snapshot, mb: Mailbox, m: MailSummary, when: number, report: SyncReport,
                            changes: Record<string, Record<string, unknown>>, contacts: Record<string, unknown>[]): Promise<void> {
  // The bounce names the failed address in its body, not its headers.
  const data = await ctx.base.lark.json(["mail", "+messages", "--mailbox", mb.address, "--message-ids", m.message_id,
    "--html=false", "--as", "user"]).catch(() => null);
  const body = JSON.stringify(data ?? "");
  const failed = [...new Set(emailsIn(body))].filter((addr) => addr !== mb.address && !BOUNCE_SENDER.test(addr) && s.followupsByEmail.has(addr));
  contacts.push({
    方向: ["收到"], 渠道: [mb.channel], "Message ID": m.message_id, 日期: stamp(when, ctx.cfg.timezone), 待处理: false,
    摘要: `${BOUNCE_MARK} ${failed.join(", ") || "（没认出是哪个地址）"}`.slice(0, 200),
    ...(failed.length ? { KOL: [{ id: s.followupsByEmail.get(failed[0])![0] }] } : {}),
  });
  for (const addr of failed) {
    for (const fid of s.followupsByEmail.get(addr) ?? []) {
      const f = s.followups.get(fid)!;
      if (option(f["阶段"]) === "结案") continue;
      changes[fid] = { ...changes[fid], 阶段: ["结案"], 结案原因: ["退信或邮箱无效"], 当前轮到谁: ["无需动作"],
        下一步: `${stamp(when, ctx.cfg.timezone).slice(0, 10)} 发往 ${addr} 的信被退回` };
      report.bounces.push({ name: displayName(s, f), address: addr });
    }
  }
}
