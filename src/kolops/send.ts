import { emailsIn, linkIds, option, text } from "./base.js";
import { mailboxFor, sendingPaused, type Mailbox } from "./config.js";
import type { Ctx } from "./ctx.js";
import { blockedReason, displayName, followupEmails, loadSnapshot, profileOf, type Snapshot } from "./data.js";
import { fillTrial, missingPlaceholder, prepareTrial, trialNote, trialPlan } from "./trial.js";
import { LarkError, type Row } from "./lark.js";
import { MailBlocked, replySubject, splitDraft, STATUS_NAMES, toHtml } from "./mail.js";
import { bounceStats, bouncePaused, otherSendingRun, stamp, today, todaysSends, type SendCounts } from "./ops.js";
import { closeChanges } from "./inbox.js";

export const SENDING_TYPES = ["回复邮件", "协议"];

/** Approval is 处理 = 发／同意. The older 审核结果 column can no longer approve, but a no left there still holds an item back. */
export function isApproved(r: Row): boolean {
  const no = ["退回修改", "先不发", "不同意"].includes(option(r["审核结果"]));
  return option(r["处理"]) === "发／同意" && !no;
}

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
  if (await sendingPaused(ctx.base.lark, ctx.cfg.baseToken)) {
    report.skipped.push(...items.map((o) => ({ key: o.key, name: o.name, reason: "「设置」表的「暂停所有发送」勾上了" })));
    return report;
  }
  const busy = !dryRun && items.length ? await otherSendingRun(ctx.base, ctx.cfg, ctx.run.id) : "";
  if (busy) {
    report.skipped.push(...items.map((o) => ({ key: o.key, name: o.name, reason: busy })));
    return report;
  }
  const [counts, bounces] = await Promise.all([todaysSends(ctx.base, ctx.cfg), bounceStats(ctx.base, ctx.cfg)]);
  const gap = Math.ceil(60_000 / Math.max(1, ctx.cfg.perMinute));
  const t = ctx.cfg.tables;

  for (const o of items) {
    const prior = ctx.journal.get(o.key);
    if (prior?.state === "recorded" || prior?.state === "sent") {
      report.skipped.push({ key: o.key, name: o.name, reason: `这封信已经发过（${prior.messageId ?? ""}）` });
      continue;
    }
    if (prior?.state === "sending") {
      // The last run died mid-send: the mail may or may not have gone out, so never resend on our own.
      report.failed.push({ key: o.key, name: o.name, reason: "上次发送中断，结果不明。请到邮箱的「已发送」里确认后再处理" });
      if (!dryRun) {
        ctx.journal.mark(o.key, "failed");
        await markFailed(ctx, o, "上次发送中断，结果不明，请到邮箱「已发送」确认");
      }
      continue;
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

    let reason = bouncePaused(o.mailbox, bounces) || checkOne(o, s, counts, senders);
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
    if (o.prepare) {
      try {
        const ready = await o.prepare();
        o.subject = fillTrial(o.subject, ready.values);
        o.body = fillTrial(o.body, ready.values);
        o.after = { ...o.after, followup: { ...o.after?.followup, ...ready.followup } };
      } catch (err: any) {
        const why = `${o.prepareNote ?? "发信前的准备"}没有办成，这封信没发：${err?.message ?? err}`;
        report.failed.push({ key: o.key, name: o.name, reason: why });
        await markFailed(ctx, o, why);
        ctx.run.op({ type: "发出邮件", result: "失败", action: `${o.kind}：${o.name}`, detail: why, followup: o.followupId, recipients: o.recipient });
        continue;
      }
    }

    ctx.journal.mark(o.key, "sending");
    let sent;
    try {
      sent = await sendRetryingConflicts(ctx, { mailbox: o.mailbox.address, to: o.recipient, subject: o.subject, body: toHtml(o.body), replyTo: o.replyTo });
    } catch (err: any) {
      const definite = err instanceof MailBlocked || (err instanceof LarkError && err.definite);
      ctx.journal.mark(o.key, definite ? "failed" : "sending");
      const why = definite ? String(err.message) : `发送结果不明：${err.message}。请到邮箱「已发送」确认，不会自动重发`;
      report.failed.push({ key: o.key, name: o.name, reason: why });
      await markFailed(ctx, o, why);
      ctx.run.op({ type: "发出邮件", result: "失败", action: `${o.kind}：${o.name}`, detail: why, followup: o.followupId, recipients: o.recipient });
      continue;
    }
    ctx.journal.mark(o.key, "sent", sent.messageId);
    counts.all.add(o.followupId);
    if (!counts.byChannel.has(o.mailbox.channel)) counts.byChannel.set(o.mailbox.channel, new Set());
    counts.byChannel.get(o.mailbox.channel)!.add(o.followupId);

    const now = stamp(Date.now(), ctx.cfg.timezone);
    if (o.after?.createFollowup) {
      // A first invitation: the followup row exists only once the mail is out.
      [o.followupId] = await ctx.base.create(t.followups, [o.after.createFollowup]);
    }
    await ctx.base.create(t.contacts, [{
      方向: ["发出"],
      渠道: [o.mailbox.channel],
      "Message ID": sent.messageId,
      摘要: `[${o.kind}] ${o.subject || "回复"}`.slice(0, 200),
      内容: o.body.slice(0, 5000),
      日期: now,
      KOL: [{ id: o.followupId }],
    }]);
    if (!o.after?.createFollowup) {
      await ctx.base.update(t.followups, {
        [o.followupId]: { 最近联系日期: now, 当前轮到谁: ["KOL"], ...(o.after?.followup ?? {}) },
      });
    }
    if (o.after?.profile) await ctx.base.update(t.profiles, { [o.after.profile[0]]: o.after.profile[1] });
    if (o.after?.review) {
      await ctx.base.update(t.reviews, {
        [o.after.review]: { 状态: ["已执行"], 执行时间: now, 执行结果: `已从 ${o.mailbox.address} 发给 ${o.recipient}（${sent.messageId}）` },
      });
    }
    ctx.journal.mark(o.key, "recorded", sent.messageId);
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
export async function sendApproved(ctx: Ctx, opts: { dryRun: boolean; only?: string[] }): Promise<SendReport & { notEmail: number; closed: string[] }> {
  const t = ctx.cfg.tables;
  const [s, reviews] = await Promise.all([
    loadSnapshot(ctx.base, ctx.cfg),
    ctx.base.records(t.reviews, { filter: { logic: "and", conditions: [["状态", "intersects", ["待你审核", "待执行"]]] } }),
  ]);
  const chosen = reviews.filter((r) => isApproved(r) && (!opts.only?.length || opts.only.includes(r.record_id)));
  const items: Outgoing[] = [];
  const skipped: Skipped[] = [];
  const closed: string[] = [];
  const day = today(ctx.cfg);
  let notEmail = 0;
  for (const r of chosen) {
    const type = option(r["类型"]);
    const channel = option(r["发送渠道"]);
    const followupId = linkIds(r["KOL"])[0] ?? "";
    const f = s.followups.get(followupId);
    const name = f ? displayName(s, f) : text(r["审核项"]);
    const close = f ? closeChanges(r, profileOf(s, f), day) : null;
    if (typeof close === "string") {
      skipped.push({ key: r.record_id, name, reason: close });
      continue;
    }
    if (!SENDING_TYPES.includes(type) || channel === "不发邮件") {
      if (!close) {
        notEmail++;
        continue;
      }
      closed.push(name);
      if (opts.dryRun) continue;
      await ctx.base.update(t.followups, { [followupId]: close.followup });
      if (close.profile) await ctx.base.update(t.profiles, { [close.profile[0]]: close.profile[1] });
      await ctx.base.update(t.reviews, { [r.record_id]: { 状态: ["已执行"], 执行时间: stamp(Date.now(), ctx.cfg.timezone), 执行结果: `没发信，${option(r["发后动作"])}（${option(r["结案原因"])}）` } });
      ctx.run.op({ type: "飞书变更", result: "完成", action: `${option(r["发后动作"])}（${option(r["结案原因"])}）：${name}`, followup: followupId });
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
    items.push({
      key: `review:${r.record_id}`, followupId, name, recipient: emailsIn(r["收件人"])[0] ?? "",
      mailbox, subject, body, oncePerDay: false, kind: "回复",
      after: { review: r.record_id, ...(close ? { followup: close.followup, profile: close.profile } : {}) },
      ...(plan ? { prepare: prepareTrial(ctx, plan, r, name, followupId), prepareNote: trialNote(plan) } : {}),
    });
  }
  const report = await deliver(ctx, items, s, opts.dryRun);
  report.skipped.unshift(...skipped);
  return { ...report, notEmail, closed };
}
