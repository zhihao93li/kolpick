import { addDays, cellTime, emailsIn, linkIds, option, text } from "./base.js";
import { mailboxFor, sendingPaused, type Mailbox } from "./config.js";
import type { Ctx } from "./ctx.js";
import { blockedReason, displayName, followupEmails, loadSnapshot, profileOf, type Snapshot } from "./data.js";
import { fillTrial, missingPlaceholder, prepareTrial, trialNote, trialPlan } from "./trial.js";
import { partnerNote, preparePartner } from "./partner.js";
import { LarkError, type Row } from "./lark.js";
import { MailBlocked, replySubject, splitDraft, STATUS_NAMES, toHtml } from "./mail.js";
import { BOUNCE_MARK, bounceStats, bouncePaused, otherSendingRun, stamp, today, todaysSends, type SendCounts } from "./ops.js";
import { closeChanges } from "./inbox.js";
import { reopenAfterWriting } from "./reopen.js";
import { undeliverable } from "./mx.js";
import { approvalProblem, CHECK_IN_MARK, closeDeclined, fingerprint, isApproved, sendBack } from "./reviews.js";
import { machine, machineLabel } from "./executor.js";

export const SENDING_TYPES = ["回复邮件", "协议"];
/** Days to wait for her answer after asking about a missing post. */
const CHECK_IN_WAIT_DAYS = 3;

export { isApproved };

export interface Outgoing {
  key: string;
  followupId: string;
  name: string;
  recipient: string;
  mailbox: Mailbox;
  subject: string;
  body: string;
  /** Reply in the KOL's latest thread when there is one. */
  replyTo?: string;
  /** Invitations and reminders: at most one per person per day. */
  oncePerDay: boolean;
  kind: "回复" | "邀约" | "催信";
  /** Base updates to make once the mail is out. */
  after?: { review?: string; followup?: Record<string, unknown>; createFollowup?: Record<string, unknown>; profile?: [string, Record<string, unknown>] };
  /**
   * A step that must succeed right before this mail goes out (creating or extending a trial code). It returns the
   * placeholder values to fill into the subject and body, and more followup changes; if it throws, the mail is not sent.
   */
  prepare?: () => Promise<{ values: Record<string, string>; followup: Record<string, unknown> }>;
  /** What `prepare` will do, for the dry run. */
  prepareNote?: string;
  /** For an approved review: the fingerprint of the content this mail was built from, and when it was approved. */
  approved?: { fingerprint: string; at: string };
}

/** What a sent mail still has to write back, kept in the journal until it is all written. */
interface Unrecorded {
  project: string;
  name: string;
  recipient: string;
  mailbox: { address: string; channel: string };
  subject: string;
  body: string;
  kind: Outgoing["kind"];
  followupId: string;
  after?: Outgoing["after"];
  /** When the mail went out; a catch-up records that time, not its own. */
  sentAt: number;
  /** Steps already done, so a catch-up never repeats them. */
  followupCreated?: boolean;
  contactWritten?: boolean;
}

export interface Skipped {
  key: string;
  name: string;
  reason: string;
}

/** Everything that must hold before one mail may go out. Returns the reason it may not, or "". */
export function checkOne(o: Outgoing, s: Snapshot, counts: SendCounts, knownSenders: Set<string>): string {
  const f = s.followups.get(o.followupId);
  if (!f) return "找不到对应的跟进记录";
  if (!o.recipient) return "没有收件人邮箱";
  const blocked = blockedReason(s, f, o.recipient);
  if (blocked) return blocked;
  const known = followupEmails(s, f);
  if (!known.includes(o.recipient) && !knownSenders.has(o.recipient)) return `收件人 ${o.recipient} 不是这位 KOL 档案里的邮箱，也没有给我们来过信`;
  if (!o.body.trim()) return "邮件正文是空的";
  if (!o.replyTo && !o.subject) return "是一封新邮件，但没有主题（草稿第一行写「主题：…」）";
  const sentToday = counts.all.has(o.followupId);
  if (o.oncePerDay && sentToday) return "今天已经给这位 KOL 发过信";
  if (o.oncePerDay && counts.autoTo.has(o.recipient)) return `今天已经有一封邀约或催信发到 ${o.recipient}（几位 KOL 共用这个邮箱），明天再发`;
  const ch = counts.byChannel.get(o.mailbox.channel)?.size ?? 0;
  if (!sentToday && ch >= o.mailbox.dailyExternal) return `${o.mailbox.address} 今天的额度（${o.mailbox.dailyExternal} 人）已用完`;
  return "";
}

export function companyFull(ctx: Ctx, counts: SendCounts, followupId: string): boolean {
  return !counts.all.has(followupId) && counts.all.size >= ctx.cfg.companyDailyExternal;
}

export interface SendReport {
  sent: { name: string; recipient: string; mailbox: string; kind: string; messageId: string; delivery?: string }[];
  skipped: Skipped[];
  failed: Skipped[];
  dryRun: boolean;
}

/**
 * Sends a list of mails with every check applied. Shared by `send`, `invite` and `remind`.
 * Stops starting new sends when the pause switch is on.
 */
export async function deliver(ctx: Ctx, items: Outgoing[], s: Snapshot, dryRun: boolean): Promise<SendReport> {
  const report: SendReport = { sent: [], skipped: [], failed: [], dryRun };
  const busy = !dryRun && items.length ? await otherSendingRun(ctx.base, ctx.cfg, ctx.run.id) : "";
  if (busy) {
    report.skipped.push(...items.map((o) => ({ key: o.key, name: o.name, reason: busy })));
    return report;
  }
  // Mails that went out last time but weren't all written back are written now, without sending them again.
  // This sends nothing, so it happens even while sending is paused.
  if (!dryRun) await catchUp(ctx, report);
  if (await sendingPaused(ctx.base.lark, ctx.cfg.baseToken)) {
    report.skipped.push(...items.map((o) => ({ key: o.key, name: o.name, reason: "「设置」表的「暂停所有发送」勾上了" })));
    return report;
  }
  const [counts, bounces] = await Promise.all([todaysSends(ctx.base, ctx.cfg), bounceStats(ctx.base, ctx.cfg)]);
  for (const fid of counts.auto) {
    const f = s.followups.get(fid);
    if (f) for (const e of followupEmails(s, f)) counts.autoTo.add(e);
  }
  const gap = Math.ceil(60_000 / Math.max(1, ctx.cfg.perMinute));
  const t = ctx.cfg.tables;
  const domains = new Map<string, Promise<string>>();
  // The pause switch is read again before every mail, so ticking it stops a run midway.
  const pausedNow = () => sendingPaused(ctx.base.lark, ctx.cfg.baseToken);

  for (const o of items) {
    const prior = ctx.journal.get(o.key);
    if (prior?.state === "recorded" || prior?.state === "sent") {
      if (report.sent.some((x) => x.messageId === prior.messageId)) continue;
      const left = prior.state === "sent" ? "，但还没记完，补记也没成功，请看上面的报错" : "";
      report.skipped.push({ key: o.key, name: o.name, reason: `这封信已经发过（${prior.messageId ?? ""}）${left}` });
      continue;
    }
    if (prior?.state === "sending" || prior?.state === "unknown") {
      // The mail may or may not have gone out, so it is never sent again on our own, however many runs come by.
      // Only a fresh approval, given after someone looked in the mailbox, sends it again.
      const reapproved = !!o.approved?.at && o.approved.at !== (prior.data as any)?.approvedAt;
      if (!reapproved) {
        const why = "上次发送结果不明，不会自动重发。请到邮箱「已发送」确认，再在决策台「出了问题」里点「确认已经发出」或「确认没发出，重新审核」";
        report.failed.push({ key: o.key, name: o.name, reason: why });
        if (!dryRun && prior.state === "sending") {
          ctx.journal.mark(o.key, "unknown", undefined, prior.data);
          await markFailed(ctx, o, why);
          await fileUnknownReminder(ctx, o, why);
        }
        continue;
      }
    }

    const senders = new Set<string>();
    if (o.replyTo) senders.add(o.recipient);
    else if (o.kind === "回复") {
      // Only an answer threads onto the KOL's latest mail. Invitations and reminders go to people who haven't
      // written back, so any older mail from that address belongs to another conversation and must not be quoted.
      const latest = await ctx.mail.latestFrom(o.mailbox.address, o.recipient).catch(() => undefined);
      if (latest) {
        o.replyTo = latest.message_id;
        senders.add(o.recipient);
        if (!o.subject) o.subject = replySubject(latest.subject);
      }
    }

    let reason = bouncePaused(o.mailbox, bounces) || checkOne(o, s, counts, senders) || (o.recipient ? await undeliverable(o.recipient, domains) : "");
    if (!reason && companyFull(ctx, counts, o.followupId)) reason = `全公司今天的外部收件人额度（${ctx.cfg.companyDailyExternal} 人）已用完`;
    if (reason) {
      report.skipped.push({ key: o.key, name: o.name, reason });
      continue;
    }
    if (dryRun) {
      const kind = o.prepareNote ? `${o.kind}（${o.prepareNote}）` : o.kind;
      report.sent.push({ name: o.name, recipient: o.recipient, mailbox: o.mailbox.address, kind, messageId: "（试跑，没有发出）" });
      continue;
    }
    if (await pausedNow()) {
      report.skipped.push({ key: o.key, name: o.name, reason: "发到一半，「设置」表的「暂停所有发送」被勾上了，剩下的没发" });
      continue;
    }
    if (o.after?.review) {
      const claim = await claimReview(ctx, o.after.review, o.approved?.fingerprint);
      if (claim.skip) {
        report.skipped.push({ key: o.key, name: o.name, reason: claim.skip });
        continue;
      }
      if (claim.fail) {
        report.failed.push({ key: o.key, name: o.name, reason: claim.fail });
        await markFailed(ctx, o, claim.fail);
        continue;
      }
    }
    if (o.prepare) {
      try {
        const ready = await o.prepare();
        // The code exists now, whatever happens to the mail: it goes onto the followup at once (E-25), so a mail
        // that then fails or is given up still leaves the code on record.
        await ctx.base.update(t.followups, { [o.followupId]: ready.followup });
        o.subject = fillTrial(o.subject, ready.values);
        o.body = fillTrial(o.body, ready.values);
        o.after = { ...o.after, followup: { ...o.after?.followup, ...ready.followup } };
        if (o.after.review) {
          await ctx.base.update(t.reviews, { [o.after.review]: { 执行结果: `${executing()}：${o.prepareNote ?? "发信前的准备"}已完成，正在发信` } });
        }
      } catch (err: any) {
        const why = `${o.prepareNote ?? "发信前的准备"}没有办成，这封信没发：${err?.message ?? err}`;
        report.failed.push({ key: o.key, name: o.name, reason: why });
        await markFailed(ctx, o, why);
        ctx.run.op({ type: "发出邮件", result: "失败", action: `${o.kind}：${o.name}`, detail: why, followup: o.followupId, recipients: o.recipient });
        continue;
      }
    }

    ctx.journal.mark(o.key, "sending", undefined, { approvedAt: o.approved?.at });
    let sent;
    try {
      sent = await sendRetryingConflicts(ctx, { mailbox: o.mailbox.address, to: o.recipient, subject: o.subject, body: toHtml(o.body), replyTo: o.replyTo });
    } catch (err: any) {
      const definite = err instanceof MailBlocked || (err instanceof LarkError && err.definite);
      ctx.journal.mark(o.key, definite ? "failed" : "unknown", undefined, { approvedAt: o.approved?.at });
      const why = definite ? String(err.message) : `发送结果不明：${err.message}。不会自动重发：请到邮箱「已发送」确认，再在决策台「出了问题」里选发出了没有`;
      report.failed.push({ key: o.key, name: o.name, reason: why });
      await markFailed(ctx, o, why);
      if (!definite) await fileUnknownReminder(ctx, o, why);
      ctx.run.op({ type: "发出邮件", result: "失败", action: `${o.kind}：${o.name}`, detail: why, followup: o.followupId, recipients: o.recipient });
      continue;
    }
    // Writing to a KOL whose followup was closed opens it again (R-05), unless the item itself closes it. Her own
    // mail already reopened it when it came in, so a closed one here means we are the ones writing first.
    const reopen = o.kind === "回复" && !o.after?.followup?.["阶段"]
      ? reopenAfterWriting(s.followups.get(o.followupId), today(ctx.cfg), ctx.cfg.timezone, ctx.cfg.followup.closeAfterDays) : {};
    const left: Unrecorded = {
      project: ctx.cfg.project, name: o.name, recipient: o.recipient, mailbox: { address: o.mailbox.address, channel: o.mailbox.channel },
      subject: o.subject, body: o.body, kind: o.kind, followupId: o.followupId, sentAt: Date.now(),
      after: Object.keys(reopen).length ? { ...o.after, followup: { ...reopen, ...o.after?.followup } } : o.after,
    };
    // Written before anything else, so if writing back fails the next run fills in the rest instead of skipping it.
    ctx.journal.mark(o.key, "sent", sent.messageId, left);
    counted(counts, left);
    try {
      await writeBack(ctx, o.key, sent.messageId, left);
    } catch (err: any) {
      const why = `信已经发出（${sent.messageId}），写回记录时出错：${err?.message ?? err}。下次运行会补记，不会重发`;
      report.failed.push({ key: o.key, name: o.name, reason: why });
      ctx.run.op({ type: "发出邮件", result: "失败", action: `${o.kind}：${o.name}`, detail: why, followup: left.followupId, recipients: o.recipient });
      continue;
    }
    o.followupId = left.followupId;
    ctx.run.counts.发出邮件++;
    ctx.run.op({ type: "发出邮件", result: "完成", action: `${o.kind}：${o.name}`, followup: o.followupId, recipients: o.recipient, body: o.body, sent: 1 });
    report.sent.push({ name: o.name, recipient: o.recipient, mailbox: o.mailbox.address, kind: o.kind, messageId: sent.messageId });
    if (report.sent.length % 20 === 0) await ctx.run.flush();
    await ctx.sleep(gap);
  }

  // Delivery status settles a few seconds after sending; bounces found later come in through `sync`.
  if (!dryRun && report.sent.length) {
    await ctx.sleep(5_000);
    for (const r of report.sent) {
      const codes = await ctx.mail.status(r.mailbox, r.messageId).catch(() => []);
      r.delivery = codes.length ? [...new Set(codes)].map((c) => STATUS_NAMES[c] ?? String(c)).join("、") : "未查到";
    }
  }
  return report;

  async function markFailed(ctx: Ctx, o: Outgoing, why: string) {
    if (o.after?.review) {
      await ctx.base.update(t.reviews, { [o.after.review]: { 状态: ["执行失败"], 执行结果: why.slice(0, 2000), 执行时间: stamp(Date.now(), ctx.cfg.timezone) } });
    }
  }
}

/** Marks the 执行结果 of an item filed for an automatic reminder whose result is unknown; the journal key follows. */
export const AUTO_SEND_MARK = "自动发信：";

/**
 * A reminder whose result is unknown goes in front of the reviewer as a 「出了问题」 card (C-04): she may have it
 * already, so it is never sent again on its own, and the KOL would otherwise wait on it for good. A reminder that
 * failed for certain needs no card: the next daily run tries it again.
 */
async function fileUnknownReminder(ctx: Ctx, o: Outgoing, why: string): Promise<void> {
  if (o.after?.review || o.kind !== "催信") return;
  await ctx.base.create(ctx.cfg.tables.reviews, [{
    类型: ["回复邮件"], 状态: ["执行失败"], KOL: [{ id: o.followupId }], 审核项: `[催信] ${o.name}`.slice(0, 200),
    发送渠道: [o.mailbox.channel], 收件人: o.recipient, 邮件草稿: `主题：${o.subject}\n${o.body}`,
    提出时间: stamp(Date.now(), ctx.cfg.timezone), 执行时间: stamp(Date.now(), ctx.cfg.timezone),
    执行结果: `${why}\n${AUTO_SEND_MARK}${o.key}`.slice(0, 2000),
  }]);
}

function counted(counts: SendCounts, m: Unrecorded): void {
  counts.all.add(m.followupId);
  if (m.kind !== "回复") {
    counts.auto.add(m.followupId);
    counts.autoTo.add(m.recipient);
  }
  if (!counts.byChannel.has(m.mailbox.channel)) counts.byChannel.set(m.mailbox.channel, new Set());
  counts.byChannel.get(m.mailbox.channel)!.add(m.followupId);
}

/**
 * Writes a sent mail into the base: the followup it starts (first invitations), the 接触记录 row, the followup and
 * profile changes, and the review marked done. Steps that would duplicate a row are noted in the journal as they
 * finish, so a catch-up after a failure part-way only does what is left.
 */
async function writeBack(ctx: Ctx, key: string, messageId: string, m: Unrecorded, catchingUp = false): Promise<void> {
  const t = ctx.cfg.tables;
  const now = stamp(m.sentAt ?? Date.now(), ctx.cfg.timezone);
  if (m.after?.createFollowup && !m.followupCreated) {
    // A first invitation: the followup row exists only once the mail is out.
    [m.followupId] = await ctx.base.create(t.followups, [m.after.createFollowup]);
    m.followupCreated = true;
    ctx.journal.mark(key, "sent", messageId, m);
  }
  if (!m.contactWritten) {
    // A run that died right after writing the row but before noting it leaves the row there: look before writing.
    const there = catchingUp && (await ctx.base.records(t.contacts, { filter: { logic: "and", conditions: [["Message ID", "==", messageId]] }, fields: ["Message ID"] })).length > 0;
    if (!there) {
      await ctx.base.create(t.contacts, [{
        方向: ["发出"],
        渠道: [m.mailbox.channel],
        "Message ID": messageId,
        摘要: `[${m.kind}] ${m.subject || "回复"}`.slice(0, 200),
        内容: m.body.slice(0, 5000),
        日期: now,
        KOL: [{ id: m.followupId }],
      }]);
    }
    m.contactWritten = true;
    ctx.journal.mark(key, "sent", messageId, m);
  }
  if (!m.after?.createFollowup) {
    let changes: Record<string, unknown> = { 最近联系日期: now, 当前轮到谁: ["KOL"], ...(m.after?.followup ?? {}) };
    if (catchingUp) changes = await stillCurrent(ctx, m, changes);
    else if (!m.after?.followup?.["阶段"]) {
      // Closed while this mail was going out: the mail is history, and a closed followup is nobody's turn (T-1).
      const [f] = await ctx.base.get(t.followups, [m.followupId], ["阶段"]);
      if (option(f?.["阶段"]) === "结案") changes = { 最近联系日期: now };
    }
    if (Object.keys(changes).length) await ctx.base.update(t.followups, { [m.followupId]: changes });
  }
  if (m.after?.profile) await ctx.base.update(t.profiles, { [m.after.profile[0]]: m.after.profile[1] });
  if (m.after?.review) {
    await ctx.base.update(t.reviews, {
      [m.after.review]: { 状态: ["已执行"], 执行时间: now, 执行结果: `已从 ${m.mailbox.address} 发给 ${m.recipient}（${messageId}）` },
    });
  }
  ctx.journal.mark(key, "recorded", messageId);
}

/**
 * What a late write-back may still change on the followup. The mail is history; the followup is now. Whatever
 * happened after the mail went out (she wrote back, someone closed her or moved her on) is newer and stays:
 * only the last-contact date moves, and only forward.
 */
async function stillCurrent(ctx: Ctx, m: Unrecorded, changes: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tz = ctx.cfg.timezone;
  const [f] = await ctx.base.get(ctx.cfg.tables.followups, [m.followupId], ["最后来信日期", "最近联系日期", "阶段", "当前轮到谁"]);
  if (!f) return {};
  const sentAt = m.sentAt ?? 0;
  const later = (v: unknown) => (cellTime(v, tz) ?? 0) > sentAt;
  // The base keeps minutes only, so a later time in the same minute can't be told apart; treat it as later.
  const sameMinuteReply = (cellTime(f["最后来信日期"], tz) ?? 0) >= sentAt - 60_000 && option(f["当前轮到谁"]) === "我们";
  const movedOn = later(f["最后来信日期"]) || later(f["最近联系日期"]) || sameMinuteReply;
  if (!movedOn) return changes;
  return later(f["最近联系日期"]) ? {} : { 最近联系日期: changes["最近联系日期"] };
}

/** Writes back this project's mails that went out in an earlier run whose write-back failed part-way. */
async function catchUp(ctx: Ctx, report: SendReport): Promise<void> {
  for (const e of ctx.journal.unrecorded()) {
    const m = e.data as Unrecorded | undefined;
    if (!m?.project || m.project !== ctx.cfg.project || !e.messageId) continue;
    try {
      await writeBack(ctx, e.key, e.messageId, m, true);
      ctx.run.op({ type: "发出邮件", result: "完成", action: `补记${m.kind}：${m.name}`, detail: "上次已经发出，记录没写完，这次补上，没有重发", followup: m.followupId, recipients: m.recipient });
      report.sent.push({ name: m.name, recipient: m.recipient, mailbox: m.mailbox.address, kind: `${m.kind}（上次已发出，这次补记，没有重发）`, messageId: e.messageId });
    } catch (err: any) {
      report.failed.push({ key: e.key, name: m.name, reason: `信上次已经发出（${e.messageId}），补记还是没成功：${err?.message ?? err}` });
    }
  }
}

/** How an item being carried out is marked in 审核队列.执行结果, so no other run touches it meanwhile. */
const EXECUTING = "执行中";
/** An item marked 执行中 this long ago belongs to a run that died: whether its mail went out is unknown. */
const EXECUTING_STALE_MS = 15 * 60_000;

function executing(): string {
  return `${EXECUTING}（${machineLabel(machine())}）`;
}

/**
 * Re-reads one approved 审核队列 item right before it is carried out and marks it 执行中. Returns why to leave
 * it alone (done, withdrawn, no longer approved, being carried out elsewhere) or why it failed (a run that died
 * midway, so nothing is repeated on a guess).
 */
export async function claimReview(ctx: Ctx, reviewId: string, built?: string): Promise<{ skip?: string; fail?: string }> {
  const t = ctx.cfg.tables;
  // Read the whole row: a base not yet given the approval fields (同意来源 …) must still work, and naming a field it lacks fails.
  const [r] = await ctx.base.get(t.reviews, [reviewId]);
  if (!r) return { skip: "审核队列里已经没有这一条" };
  const state = option(r["状态"]);
  if (state === "已执行") return { skip: "这一条已经执行过" };
  if (state === "已撤回") return { skip: "这一条已经撤回" };
  if (!isApproved(r)) return { skip: "这一条现在不是批准状态" };
  const problem = approvalProblem(ctx.cfg, r);
  if (problem) {
    if (problem.changed) await sendBack(ctx, reviewId, problem.reason);
    return { skip: problem.reason };
  }
  // The mail was put together from the item as read at the start of the run. If it was changed and approved
  // again since, that approval is for other content: leave it to the next run, which builds the mail afresh.
  if (built && fingerprint(r) !== built) return { skip: "这一轮开始以后内容改过又重新同意了，这次先不发，下一轮按最新内容发" };
  const result = text(r["执行结果"]);
  if (result.startsWith(EXECUTING)) {
    const age = Date.now() - (cellTime(r["执行时间"], ctx.cfg.timezone) ?? 0);
    if (age < EXECUTING_STALE_MS) return { skip: `另一处正在执行这一条（${result}）` };
    return { fail: `上次执行到一半中断了（${result}），信有没有发出、码有没有建好都不确定，不会自动重做。请到邮箱「已发送」和项目后台确认后再处理` };
  }
  await ctx.base.update(t.reviews, { [reviewId]: { 状态: ["待执行"], 执行时间: stamp(Date.now(), ctx.cfg.timezone), 执行结果: executing() } });
  return {};
}

/**
 * Feishu answers 1236006 ("failed to create draft: Concurrent write conflict") when drafts are written too
 * close together. The draft was never created, so nothing went out and trying again is safe.
 */
async function sendRetryingConflicts(ctx: Ctx, mail: Parameters<Ctx["mail"]["send"]>[0]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.mail.send(mail);
    } catch (err) {
      if (!(err instanceof LarkError && err.definite && err.message.includes("1236006")) || attempt >= 4) throw err;
      await ctx.sleep(2_000 * attempt);
    }
  }
}

/**
 * `kol send`: everything approved in 审核队列 that is an email and hasn't gone out yet. An approved item that
 * sends nothing but has a 发后动作 (a refusal left unanswered) is carried out here too.
 */
export async function sendApproved(ctx: Ctx, opts: { dryRun: boolean; only?: string[] }): Promise<SendReport & { notEmail: number; closed: string[]; codes: string[]; withdrawn: string[] }> {
  const t = ctx.cfg.tables;
  const [s, reviews, unanswered] = await Promise.all([
    loadSnapshot(ctx.base, ctx.cfg),
    ctx.base.records(t.reviews, { filter: { logic: "and", conditions: [["状态", "intersects", ["待你审核", "待执行"]]] } }),
    ctx.base.records(t.contacts, { filter: { logic: "and", conditions: [["待处理", "==", true], ["方向", "intersects", ["收到"]]] }, fields: ["KOL", "待处理", "方向", "日期", "摘要"] }),
  ]);
  const tz = ctx.cfg.timezone;
  // Each KOL's latest unanswered mail.
  const lastMail = new Map<string, number>();
  for (const m of unanswered) {
    // A bounce is not her writing again: it doesn't hold back an approved reply.
    if (text(m["摘要"]).startsWith(BOUNCE_MARK)) continue;
    const at = cellTime(m["日期"], tz) ?? 0;
    for (const fid of linkIds(m["KOL"])) lastMail.set(fid, Math.max(at, lastMail.get(fid) ?? 0));
  }
  const chosen = reviews.filter((r) => isApproved(r) && (!opts.only?.length || opts.only.includes(r.record_id)));
  const items: Outgoing[] = [];
  const skipped: Skipped[] = [];
  const closed: string[] = [];
  const codes: string[] = [];
  const failedEarly: Skipped[] = [];
  const day = today(ctx.cfg);
  let notEmail = 0;
  for (const r of chosen) {
    const type = option(r["类型"]);
    const channel = option(r["发送渠道"]);
    const followupId = linkIds(r["KOL"])[0] ?? "";
    const f = s.followups.get(followupId);
    const name = f ? displayName(s, f) : text(r["审核项"]);
    const problem = approvalProblem(ctx.cfg, r);
    if (problem) {
      if (problem.changed && !opts.dryRun) await sendBack(ctx, r.record_id, problem.reason);
      skipped.push({ key: r.record_id, name, reason: problem.reason });
      continue;
    }
    // Approving in the console files the mail the reviewer saw as handled. Unanswered mail dated at or after the
    // approval (or, without one, after the item was raised) is mail the approval never saw: back to the reviewer,
    // never sent over it. Times are kept to the minute, so the same minute counts as after.
    const approvedAt = cellTime(r["同意时间"], tz) ?? cellTime(r["提出时间"], tz);
    const wroteSince = approvedAt != null && (lastMail.get(followupId) ?? -1) >= approvedAt;
    if (followupId && wroteSince && ctx.journal.get(`review:${r.record_id}`)?.state !== "sent") {
      const why = "同意之后她又来信了，先看她新说的再决定这封还发不发";
      if (!opts.dryRun) await sendBack(ctx, r.record_id, why);
      skipped.push({ key: r.record_id, name, reason: why });
      continue;
    }
    const close = f ? closeChanges(r, profileOf(s, f), day, f) : null;
    if (typeof close === "string") {
      skipped.push({ key: r.record_id, name, reason: close });
      continue;
    }
    if (!SENDING_TYPES.includes(type) || channel === "不发邮件") {
      // No mail, but a code to create, extend or open is still carried out (E-25), then any 发后动作.
      const plan = f ? trialPlan(ctx.cfg, r, f, profileOf(s, f)) : null;
      if (typeof plan === "string") {
        skipped.push({ key: r.record_id, name, reason: plan });
        continue;
      }
      if (!plan && !close) {
        // Approved with nothing to carry out (an older decision): done, so it no longer holds her up.
        notEmail++;
        if (!opts.dryRun && option(r["状态"]) === "待你审核") {
          await ctx.base.update(t.reviews, { [r.record_id]: { 状态: ["已执行"], 执行时间: stamp(Date.now(), ctx.cfg.timezone), 执行结果: "已同意（这件事不用执行）" } });
        }
        continue;
      }
      if (opts.dryRun) {
        if (plan) codes.push(name);
        if (close) closed.push(name);
        continue;
      }
      const notes: string[] = [];
      if (plan) {
        if (await sendingPaused(ctx.base.lark, ctx.cfg.baseToken)) {
          skipped.push({ key: r.record_id, name, reason: "「设置」表的「暂停所有发送」勾上了，码先不建" });
          continue;
        }
        const claim = await claimReview(ctx, r.record_id, fingerprint(r));
        if (claim.skip) {
          skipped.push({ key: r.record_id, name, reason: claim.skip });
          continue;
        }
        const note = plan.action === "开活动码" ? partnerNote(plan) : trialNote(plan);
        try {
          if (claim.fail) throw new Error(claim.fail);
          const ready = await (plan.action === "开活动码" ? preparePartner(ctx, plan, r, followupId) : prepareTrial(ctx, plan, r, name, followupId))();
          await ctx.base.update(t.followups, { [followupId]: ready.followup });
        } catch (err: any) {
          const why = claim.fail ?? `${note}没有办成：${err?.message ?? err}`;
          failedEarly.push({ key: r.record_id, name, reason: why });
          await ctx.base.update(t.reviews, { [r.record_id]: { 状态: ["执行失败"], 执行结果: why.slice(0, 2000), 执行时间: stamp(Date.now(), ctx.cfg.timezone) } });
          ctx.run.op({ type: "后台操作", result: "失败", action: `${note}：${name}`, detail: why, followup: followupId });
          continue;
        }
        codes.push(name);
        notes.push(`${note}，已完成`);
        ctx.run.op({ type: "后台操作", result: "完成", action: `${note}：${name}`, followup: followupId });
      }
      if (close) {
        closed.push(name);
        await ctx.base.update(t.followups, { [followupId]: close.followup });
        if (close.profile) await ctx.base.update(t.profiles, { [close.profile[0]]: close.profile[1] });
        notes.push(`${option(r["发后动作"])}（${option(r["结案原因"])}）`);
        ctx.run.op({ type: "飞书变更", result: "完成", action: `${option(r["发后动作"])}（${option(r["结案原因"])}）：${name}`, followup: followupId });
      }
      await ctx.base.update(t.reviews, { [r.record_id]: { 状态: ["已执行"], 执行时间: stamp(Date.now(), ctx.cfg.timezone), 执行结果: `没发信，${notes.join("，")}` } });
      continue;
    }
    const mailbox = mailboxFor(ctx.cfg, channel || option(f?.["联系渠道"]));
    if (!mailbox) {
      skipped.push({ key: r.record_id, name, reason: `发送渠道「${channel || "未填"}」不是插件能发的飞书邮箱` });
      continue;
    }
    const { subject, body } = splitDraft(text(r["邮件草稿"]));
    const plan = trialPlan(ctx.cfg, r, f, profileOf(s, f));
    if (typeof plan === "string") {
      skipped.push({ key: r.record_id, name, reason: plan });
      continue;
    }
    const gap = plan ? missingPlaceholder(plan, `${subject}\n${body}`) : "";
    if (gap) {
      skipped.push({ key: r.record_id, name, reason: gap });
      continue;
    }
    // A check-in about a missing post moves her next follow-up 3 days on, once it has gone out (C-07).
    const checkIn = text(r["审核项"]).startsWith(CHECK_IN_MARK)
      ? { 下次跟进日期: `${addDays(day, CHECK_IN_WAIT_DAYS)} 10:00`, 下一步: `${day} 问了发布时间，等她回` } : {};
    items.push({
      key: `review:${r.record_id}`, followupId, name, recipient: emailsIn(r["收件人"])[0] ?? "",
      mailbox, subject, body, oncePerDay: false, kind: "回复",
      after: { review: r.record_id, ...(close ? { followup: { ...checkIn, ...close.followup }, profile: close.profile } : Object.keys(checkIn).length ? { followup: checkIn } : {}) },
      approved: { fingerprint: fingerprint(r), at: text(r["同意时间"]) },
      ...(plan?.action === "开活动码" ? { prepare: preparePartner(ctx, plan, r, followupId), prepareNote: partnerNote(plan) }
        : plan ? { prepare: prepareTrial(ctx, plan, r, name, followupId), prepareNote: trialNote(plan) } : {}),
    });
  }
  const report = await deliver(ctx, items, s, opts.dryRun);
  report.skipped.unshift(...skipped);
  report.failed.unshift(...failedEarly);
  // Items the reviewer chose 不发 for are withdrawn here, so their KOLs stop waiting on review.
  const withdrawn = opts.only?.length ? [] : await closeDeclined(ctx, { dryRun: opts.dryRun, reviews });
  return { ...report, notEmail, closed, codes, withdrawn };
}
