import { addDays, cellTime, emailsIn, linkIds, option, text } from "../base.js";
import { loadConfig, mailboxFor, sendingPaused } from "../config.js";
import { makeCtx, type Ctx } from "../ctx.js";
import { blockedReason, displayName, profileEmails, profileOf } from "../data.js";
import { notExecutor, ExecutorLock } from "../executor.js";
import { find } from "../find.js";
import { closeChanges } from "../inbox.js";
import { closedFrom, reopenAfterWriting, reopenChanges } from "../reopen.js";
import type { Row } from "../lark.js";
import { splitDraft } from "../mail.js";
import { BOUNCE_MARK, RUN_TITLES, stamp, today } from "../ops.js";
import { approveInConsole, CHECK_IN_MARK, closeDeclined, executesOnApproval, executing, openMailItems, sendBack } from "../reviews.js";
import { CLOSE_REASONS } from "../schema.js";
import { AUTO_SEND_MARK, sendApproved } from "../send.js";
import type { Platform } from "../../discovery/models.js";
import { namedTemplate, type ConsoleData } from "./state.js";

/**
 * What the decision console's buttons do. Decisions and edits are written to the base straight away; anything
 * that reaches outside it (sending, codes, finding people) becomes a job that the one executor carries out.
 */

export interface Job {
  id: number;
  what: string;
  person: string;
  state: "排队中" | "进行中" | "做完了" | "没做成";
  note: string;
  at: number;
}

/** The console's own jobs, run one after another under the executor lock, with a fresh config each time. */
export class Jobs {
  list: Job[] = [];
  private chain: Promise<void> = Promise.resolve();
  private n = 0;

  constructor(private ctx: Ctx, private onDone: () => void = () => {}) {}

  add(what: string, person: string, title: string, fn: (jctx: Ctx) => Promise<string>): Job {
    const job: Job = { id: ++this.n, what, person, state: "排队中", note: "", at: Date.now() };
    this.list.unshift(job);
    this.list = this.list.slice(0, 50);
    this.chain = this.chain.then(async () => {
      job.state = "进行中";
      job.at = Date.now();
      try {
        job.note = await ExecutorLock.run(title, async () => {
          const cfg = await loadConfig(this.ctx.base.lark, this.ctx.cfg.project, this.ctx.cfg.baseToken);
          const why = notExecutor(cfg);
          if (why) throw new Error(why);
          const jctx = makeCtx(cfg, this.ctx.base.lark, this.ctx.me, title, false, this.ctx.sleep);
          await jctx.run.start();
          try {
            const note = await fn(jctx);
            await jctx.run.finish("完成");
            return note;
          } catch (err: any) {
            jctx.run.notes.push(String(err?.message ?? err));
            await jctx.run.finish("失败").catch(() => {});
            throw err;
          }
        }, { waitMs: 10 * 60_000 });
        job.state = "做完了";
      } catch (err: any) {
        job.state = "没做成";
        job.note = String(err?.message ?? err).slice(0, 300);
      }
      job.at = Date.now();
      this.onDone();
    });
    return job;
  }
}

/** Reads one review by id, or says why it can't be acted on. */
async function review(ctx: Ctx, id: string): Promise<Row> {
  const [r] = await ctx.base.get(ctx.cfg.tables.reviews, [id]);
  if (!r) throw new Error("审核队列里已经没有这一条，可能刚被处理过。点「刷新」看最新的");
  return r;
}

function nameOf(data: ConsoleData, fid: string): string {
  const f = data.snapshot.followups.get(fid);
  return f ? displayName(data.snapshot, f) : "";
}

/** Mail from this KOL nobody has dealt with yet. */
async function pendingMailOf(ctx: Ctx, fid: string): Promise<Row[]> {
  if (!fid) return [];
  const rows = await ctx.base.records(ctx.cfg.tables.contacts, {
    filter: { logic: "and", conditions: [["待处理", "==", true], ["方向", "intersects", ["收到"]]] }, fields: ["Message ID", "日期", "KOL", "待处理", "摘要"],
  });
  // A bounce waiting for a new address is not her writing to us (C-12): answering her leaves it alone.
  return rows.filter((r) => linkIds(r["KOL"]).includes(fid) && !text(r["摘要"]).startsWith(BOUNCE_MARK));
}

/**
 * An approval answers the KOL's mail the reviewer saw. `seen` is the Message ID of the latest mail the card
 * showed (or `true` when the reviewer wrote from her page, where all of it is shown): mail up to that one is
 * filed as handled; anything newer stops the approval, so a reply never goes out over something she said since.
 */
async function answerMail(ctx: Ctx, fid: string, seen: string | true | undefined): Promise<void> {
  const pending = await pendingMailOf(ctx, fid);
  if (!pending.length) return;
  if (seen !== true) {
    const tz = ctx.cfg.timezone;
    const shown = pending.find((m) => seen && text(m["Message ID"]) === seen);
    const at = (m: Row) => cellTime(m["日期"], tz) ?? 0;
    if (!shown || pending.some((m) => at(m) > at(shown))) throw new Error("她又来信了，这张卡片上没有。点「刷新」看完她新说的再决定");
  }
  await ctx.base.update(ctx.cfg.tables.contacts, Object.fromEntries(pending.map((m) => [m.record_id, { 待处理: false }])));
}

/**
 * 同意: records the approval (with the reviewer's last edits), then has the executor carry it out. Items that only
 * record an answer (a decision) get no job; an approved template is put to use. While sending is paused the
 * approval waits, and resuming sends it.
 */
export async function approve(ctx: Ctx, data: ConsoleData, jobs: Jobs, id: string, edits: Record<string, unknown>, seen?: string | true): Promise<Job | null> {
  const before = await review(ctx, id);
  const fid = linkIds(before["KOL"])[0] ?? "";
  await answerMail(ctx, fid, seen);
  const r = await approveInConsole(ctx, id, cleanEdits(edits));
  if (option(r["类型"]) === "模板审批") await approveNamedTemplate(ctx, r);
  if (!executesOnApproval(r)) {
    // Nothing to carry out: the answer is recorded and the item is done, so it no longer holds her up.
    await ctx.base.update(ctx.cfg.tables.reviews, { [id]: { 状态: ["已执行"], 执行时间: stamp(Date.now(), ctx.cfg.timezone), 执行结果: `${ctx.me.name}在决策台同意了（这件事不用执行）` } });
    return null;
  }
  if (await isPaused(ctx)) return null;
  const who = nameOf(data, fid) || text(r["审核项"]);
  return jobs.add(`${who}：${text(r["审核项"])}`, fid, RUN_TITLES.send, async (jctx) => {
    const rep = await sendApproved(jctx, { dryRun: false, only: [id] });
    if (rep.failed.length) throw new Error(rep.failed[0].reason);
    if (rep.sent.length) return `已发给 ${rep.sent[0].recipient}（${rep.sent[0].mailbox}）`;
    if (rep.codes.length && rep.closed.length) return "码已办好，已结束跟进";
    if (rep.codes.length) return "码已办好（这件事不发信）";
    if (rep.closed.length) return "已结束跟进";
    if (rep.skipped.length) throw new Error(rep.skipped[0].reason);
    return "已同意（这件事不用发信）";
  });
}

/**
 * A reply that has to go out from a mailbox the plugin can't send from (a Gmail, say): the reviewer sent it by hand,
 * so it is recorded the way a sent mail is — 接触记录, the followup waiting on the KOL, the item done.
 */
export async function manualSent(ctx: Ctx, data: ConsoleData, id: string, edits: Record<string, unknown>, seen?: string): Promise<void> {
  const t = ctx.cfg.tables;
  const [before] = await ctx.base.get(t.reviews, [id]);
  if (!before) throw new Error("审核队列里已经没有这一条");
  if (option(before["体验码动作"])) throw new Error("这一条还要建码，手动发信的邮箱没法一起做。点「让 Claude 改」，请它改成从飞书邮箱发");
  await answerMail(ctx, linkIds(before["KOL"])[0] ?? "", seen);
  const r = await approveInConsole(ctx, id, cleanEdits(edits));
  const fid = linkIds(r["KOL"])[0] ?? "";
  const f = data.snapshot.followups.get(fid);
  const close = f ? closeChanges(r, profileOf(data.snapshot, f), today(ctx.cfg), f) : null;
  if (typeof close === "string") throw new Error(close);
  const channel = option(r["发送渠道"]) || option(f?.["联系渠道"]);
  const { subject, body } = splitDraft(text(r["邮件草稿"]));
  const recipient = emailsIn(r["收件人"])[0] ?? "她";
  const now = stamp(Date.now(), ctx.cfg.timezone);
  if (fid) {
    await ctx.base.create(t.contacts, [{ 方向: ["发出"], 渠道: [channel], 摘要: `[回复] ${subject || "回复"}`.slice(0, 200), 内容: body.slice(0, 5000), 日期: now, KOL: [{ id: fid }] }]);
    await ctx.base.update(t.followups, { [fid]: { 最近联系日期: now, 当前轮到谁: ["KOL"],
      ...reopenAfterWriting(f, today(ctx.cfg), ctx.cfg.timezone, ctx.cfg.followup.closeAfterDays), ...(close?.followup ?? {}) } });
    if (close?.profile) await ctx.base.update(t.profiles, { [close.profile[0]]: close.profile[1] });
  }
  await ctx.base.update(t.reviews, { [id]: { 状态: ["已执行"], 执行时间: now, 执行结果: `${ctx.me.name} 从「${channel}」手动发给 ${recipient}` } });
}

const EDITABLE = new Set(["邮件草稿", "体验码", "体验次数", "体验天数", "活动码", "粉丝折扣", "销售市场", "合作页名称"]);
const NUMBERS = new Set(["体验次数", "体验天数", "粉丝折扣"]);

/** Only the fields a reviewer may change from the card, typed the way the base stores them. */
function cleanEdits(edits: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(edits ?? {})) {
    if (!EDITABLE.has(k)) continue;
    if (NUMBERS.has(k)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`「${k}」要填大于 0 的数字`);
      out[k] = n;
    } else out[k] = String(v ?? "");
  }
  return out;
}

/** 要改: back to Claude with the reviewer's words. */
export async function revise(ctx: Ctx, id: string, note: string): Promise<void> {
  await review(ctx, id);
  await ctx.base.update(ctx.cfg.tables.reviews, { [id]: { 处理: ["改"], 你的意见: note.trim(), 同意来源: "", 内容指纹: "" } });
}

/** 这件事不用做了: withdrawn now, its KOL handed back. */
export async function drop(ctx: Ctx, id: string, note: string): Promise<void> {
  await review(ctx, id);
  await ctx.base.update(ctx.cfg.tables.reviews, { [id]: { 处理: ["不发"], 你的意见: note.trim(), 同意来源: "", 内容指纹: "" } });
  await closeDeclined(ctx, { dryRun: false });
}

/** 做完了: a to-do the reviewer has done, closed the way to-dos always were (处理 = 已完成). */
export async function todoDone(ctx: Ctx, id: string): Promise<void> {
  const r = await review(ctx, id);
  if (!["待你审核", "待执行"].includes(option(r["状态"]))) throw new Error(`这一条现在是「${option(r["状态"])}」，已经不在待办里了`);
  await ctx.base.update(ctx.cfg.tables.reviews, { [id]: {
    处理: ["已完成"], 状态: ["已执行"], 执行时间: stamp(Date.now(), ctx.cfg.timezone), 执行结果: `${ctx.me.name}在决策台标为做完了`,
  } });
}

/**
 * 确认已经发出: the reviewer found the mail in the mailbox's 已发送 after a send whose result was unknown. It is
 * recorded the way a sent mail is, and never sent again.
 */
export async function problemSent(ctx: Ctx, data: ConsoleData, id: string, codeName = "", how = "在邮箱里确认已经发出，补记"): Promise<void> {
  const t = ctx.cfg.tables;
  const r = await review(ctx, id);
  if (option(r["状态"]) !== "执行失败") throw new Error(`这一条现在是「${option(r["状态"])}」，不是没做成的`);
  const fid = linkIds(r["KOL"])[0] ?? "";
  const f = data.snapshot.followups.get(fid);
  const close = f ? closeChanges(r, profileOf(data.snapshot, f), today(ctx.cfg), f) : null;
  const channel = option(r["发送渠道"]) || option(f?.["联系渠道"]);
  const { subject, body } = splitDraft(text(r["邮件草稿"]));
  const now = stamp(Date.now(), ctx.cfg.timezone);
  const day = today(ctx.cfg);
  // An automatic reminder is recorded as one, so it counts toward the two before closing.
  const auto = autoSendKey(r);
  const n = auto ? Number(auto.split(":")[2]) : 0;
  ctx.journal.mark(auto || `review:${id}`, "recorded");
  // The code the reviewer found made in the project back office (C-04), onto the followup like a made one.
  const action = option(r["体验码动作"]);
  const filled = codeName.trim();
  const codeFields = filled && action ? (action === "开活动码" ? { 活动码: filled } : { 体验码: filled }) : {};
  if (fid) {
    const kind = auto ? "催信" : "回复";
    await ctx.base.create(t.contacts, [{ 方向: ["发出"], 渠道: [channel], 摘要: `[${kind}] ${subject || kind}`.slice(0, 200), 内容: body.slice(0, 5000), 日期: now, KOL: [{ id: fid }] }]);
    const next = auto ? { 下次跟进日期: `${addDays(day, n === 1 ? ctx.cfg.followup.secondAfterDays : ctx.cfg.followup.closeAfterDays)} 10:00` } : {};
    await ctx.base.update(t.followups, { [fid]: { 最近联系日期: now, 当前轮到谁: ["KOL"], ...next, ...codeFields,
      ...reopenAfterWriting(f, day, ctx.cfg.timezone, ctx.cfg.followup.closeAfterDays), ...(typeof close === "object" && close ? close.followup : {}) } });
    if (typeof close === "object" && close?.profile) await ctx.base.update(t.profiles, { [close.profile[0]]: close.profile[1] });
  }
  const code = !action ? "" : filled ? `，码 ${filled} 已记到跟进` : "。体验码 / 活动码有没有建好，请到项目后台核对，建好了把码名填上";
  await ctx.base.update(t.reviews, { [id]: { 状态: ["已执行"], 执行时间: now,
    执行结果: `${text(r["执行结果"])}\n${now} ${ctx.me.name} ${how}${code}`.trim().slice(0, 2000) } });
}

/**
 * 确认没发出: the reviewer checked the mailbox and the mail isn't there. The item goes back in front of them as
 * not yet approved; approving it again sends it.
 */
export async function problemRetry(ctx: Ctx, id: string): Promise<void> {
  const r = await review(ctx, id);
  if (option(r["状态"]) !== "执行失败") throw new Error(`这一条现在是「${option(r["状态"])}」，不是没做成的`);
  const auto = autoSendKey(r);
  if (auto) {
    // An automatic reminder that didn't go out: the next daily run sends it again, under the usual rules.
    ctx.journal.mark(auto, "failed");
    await ctx.base.update(ctx.cfg.tables.reviews, { [id]: { 状态: ["已撤回"],
      执行结果: `${text(r["执行结果"])}\n${stamp(Date.now(), ctx.cfg.timezone)} ${ctx.me.name} 确认没发出，下次例行再催`.slice(0, 2000) } });
    return;
  }
  // The reviewer looked: nothing went out and no code was made, so trying again is theirs to allow (I-5).
  for (const key of [`review:${id}`, `trial:${id}`, `partner:${id}`]) {
    const prior = ctx.journal.get(key);
    if (prior?.state === "sending" || prior?.state === "unknown") ctx.journal.mark(key, "failed");
  }
  await sendBack(ctx, id, `${ctx.me.name} 在邮箱里确认没有发出，重新审核`);
}

/** The journal key of the automatic reminder an item was filed for (C-04), or "" for a reviewed item. */
function autoSendKey(r: Row): string {
  const line = text(r["执行结果"]).split("\n").find((l) => l.startsWith(AUTO_SEND_MARK));
  return line ? line.slice(AUTO_SEND_MARK.length).trim() : "";
}

/** A failed item the reviewer has dealt with by hand. */
export async function problemDone(ctx: Ctx, data: ConsoleData, id: string): Promise<void> {
  const r = await review(ctx, id);
  // An automatic reminder given up on: the next daily run judges her again under the usual rules, instead of
  // skipping her for good over a result nobody will settle now.
  const auto = autoSendKey(r);
  if (auto) {
    // Nobody checked whether it went out, so it must not go out again (I-5): it counts as the reminder it was,
    // and her follow-up moves on as after one, rather than her being chased twice or stuck.
    await problemSent(ctx, data, id, "", "撤掉了这封结果不明的催信，没有核实发没发出，按已经催过一次记，不重发");
    return;
  }
  await ctx.base.update(ctx.cfg.tables.reviews, { [id]: {
    状态: ["已撤回"], 执行结果: `${text(r["执行结果"])}\n${stamp(Date.now(), ctx.cfg.timezone)} ${ctx.me.name} 标为已人工处理`.trim().slice(0, 2000),
  } });
}

async function contact(ctx: Ctx, id: string): Promise<Row> {
  const [c] = await ctx.base.get(ctx.cfg.tables.contacts, [id], ["待处理", "KOL", "方向"]);
  if (!c) throw new Error("接触记录里已经没有这封信");
  return c;
}

/**
 * 不用回: the mails (one KOL's card may hold several) are filed as handled. A KOL left with nothing for us to
 * answer or decide no longer waits on us: the ball is with her, or nowhere once she is closed.
 */
export async function mailDone(ctx: Ctx, ids: string[]): Promise<void> {
  const t = ctx.cfg.tables;
  const rows = [];
  for (const id of ids) rows.push(await contact(ctx, id));
  await ctx.base.update(t.contacts, Object.fromEntries(ids.map((id) => [id, { 待处理: false }])));
  const kols = [...new Set(rows.flatMap((r) => linkIds(r["KOL"])))];
  if (!kols.length) return;
  const open = await ctx.base.records(t.reviews, { filter: { logic: "and", conditions: [["状态", "intersects", ["待你审核", "待执行"]]] }, fields: ["KOL", "状态"] });
  for (const fid of kols) {
    if (open.some((r) => linkIds(r["KOL"]).includes(fid)) || (await pendingMailOf(ctx, fid)).length) continue;
    const [f] = await ctx.base.get(t.followups, [fid], ["阶段", "当前轮到谁"]);
    if (!f || option(f["当前轮到谁"]) !== "我们") continue;
    await ctx.base.update(t.followups, { [fid]: { 当前轮到谁: [option(f["阶段"]) === "结案" ? "无需动作" : "KOL"] } });
  }
}

/** 标成永不联系 from a mail: filed as handled, the followup closed and the profile marked for this project. */
export async function mailNever(ctx: Ctx, data: ConsoleData, ids: string[]): Promise<void> {
  const first = await contact(ctx, ids[0]);
  await mailDone(ctx, ids);
  const fid = linkIds(first["KOL"])[0];
  if (fid) await closeFollowup(ctx, data, fid, { never: true, reason: "拒绝" });
}

/**
 * 关联到 KOL: mail from an address no profile had. The mails join her followup (still 待处理, so they come back
 * as her card), the address joins her profile so later mail matches, and the followup waits on us.
 */
export async function mailLink(ctx: Ctx, data: ConsoleData, ids: string[], fid: string): Promise<void> {
  const f = data.snapshot.followups.get(fid);
  if (!f) throw new Error("找不到这位 KOL 的跟进记录");
  const rows = await ctx.base.get(ctx.cfg.tables.contacts, ids, ["内容", "日期", "KOL"]);
  if (rows.length !== ids.length) throw new Error("接触记录里有的信已经不在了，点「刷新」再试");
  const senders = [...new Set(rows.map((r) => text(r["内容"]).replace(/^发件人：/, "").trim().toLowerCase()).filter((e) => e.includes("@")))];
  await ctx.base.update(ctx.cfg.tables.contacts, Object.fromEntries(ids.map((id) => [id, { KOL: [{ id: fid }] }])));
  const p = profileOf(data.snapshot, f);
  const known = profileEmails(p);
  const extra = senders.filter((e) => !known.includes(e));
  if (p && extra.length) {
    const others = [text(p["其他邮箱"]), ...extra].filter(Boolean).join(", ");
    await ctx.base.update(ctx.cfg.tables.profiles, { [p.record_id]: { 其他邮箱: others } });
  }
  const last = Math.max(0, ...rows.map((r) => cellTime(r["日期"], ctx.cfg.timezone) ?? 0));
  // Her mail, now known to be hers, opens a closed followup again (E-12, R-05); a 永不联系 one stays closed (P-6).
  const neverAgain = option(f["阶段"]) === "结案" && Boolean(blockedReason(data.snapshot, f, senders[0] ?? ""));
  await ctx.base.update(ctx.cfg.tables.followups, { [fid]: {
    ...(last ? { 最后来信日期: stamp(last, ctx.cfg.timezone) } : {}),
    ...(neverAgain ? {} : { 当前轮到谁: ["我们"], ...(option(f["阶段"]) === "已邀约" ? { 阶段: ["已回复"] } : {}), ...reopenChanges(f, today(ctx.cfg)) }),
  } });
}

/** 不再跟进 / 不要再联系她. */
export async function closeFollowup(ctx: Ctx, data: ConsoleData, fid: string, o: { never: boolean; reason?: string }): Promise<void> {
  const f = data.snapshot.followups.get(fid);
  if (!f) throw new Error("找不到这位 KOL 的跟进记录");
  const reason = o.reason && CLOSE_REASONS.includes(o.reason) ? o.reason : o.never ? "拒绝" : "其他";
  const day = today(ctx.cfg);
  const action = o.never ? "永不联系" : "结案";
  await ctx.base.update(ctx.cfg.tables.followups, { [fid]: { 阶段: ["结案"], 结案原因: [reason], 当前轮到谁: ["无需动作"], 下一步: `${day} ${action}（${reason}，${ctx.me.name}在决策台操作）${closedFrom(f)}` } });
  const p = profileOf(data.snapshot, f);
  if (o.never && p) await ctx.base.update(ctx.cfg.tables.profiles, { [p.record_id]: { 联系许可: ["永不联系"], 联系许可原因: `${day} ${reason}` } });
  // Whatever was still waiting to be done for her is withdrawn, approved or not: closing means stop.
  const open = await ctx.base.records(ctx.cfg.tables.reviews, { filter: { logic: "and", conditions: [["状态", "intersects", ["待你审核", "待执行"]]] }, fields: ["KOL", "状态", "执行结果"] });
  // One already being carried out may be going out right now: it is left to finish and be checked, not shown as withdrawn.
  const mine = open.filter((r) => linkIds(r["KOL"]).includes(fid) && !executing(r));
  if (mine.length) {
    await ctx.base.update(ctx.cfg.tables.reviews, Object.fromEntries(mine.map((r) => [r.record_id, {
      处理: ["不发"], 状态: ["已撤回"], 同意来源: "", 内容指纹: "", 执行结果: `${stamp(Date.now(), ctx.cfg.timezone)} ${action}时撤回（${ctx.me.name}在决策台操作）`,
    }])));
  }
}

/** The stages a reviewer may set by hand (E-32, E-33). 结案 goes through 不再跟进, which asks for a reason. */
const EDITABLE_STAGES = ["已邀约", "已回复", "体验中", "已看报告", "合作中", "已约发布", "已发布", "暂缓"];

const FOLLOWUP_EDITS: Record<string, (v: string, tz: string) => unknown> = {
  下次跟进日期: (v) => (v ? `${v} 00:00` : null),
  约定发布日期: (v) => (v ? `${v} 00:00` : null),
  下一步: (v) => v,
  当前轮到谁: (v) => [v],
  级别: (v) => [v],
  阶段: (v) => [v],
};

/** Edits to a followup made on its page. */
export async function updateFollowup(ctx: Ctx, data: ConsoleData, fid: string, fields: Record<string, string>): Promise<void> {
  if (!data.snapshot.followups.has(fid)) throw new Error("找不到这位 KOL 的跟进记录");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    const to = FOLLOWUP_EDITS[k];
    if (!to) throw new Error(`「${k}」不能在这里改`);
    if ((k === "下次跟进日期" || k === "约定发布日期") && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${k}的格式不对`);
    if (k === "阶段" && !EDITABLE_STAGES.includes(String(v))) throw new Error(`阶段只能改成：${EDITABLE_STAGES.join("、")}；要结案请点「不再跟进」`);
    const closed = option(data.snapshot.followups.get(fid)!["阶段"]) === "结案" && !fields["阶段"];
    if (k === "当前轮到谁" && closed && v !== "无需动作") throw new Error("她已经结案了，轮到谁只能是「无需动作」；要继续跟进，先给她写信或改阶段");
    out[k] = to(String(v ?? "").trim(), ctx.cfg.timezone);
  }
  if (!Object.keys(out).length) return;
  if (out["阶段"]) {
    const was = option(data.snapshot.followups.get(fid)!["阶段"]);
    out["下一步"] ??= `${today(ctx.cfg)} 阶段从「${was}」改成「${option(out["阶段"])}」（${ctx.me.name}在决策台操作）`;
  }
  await ctx.base.update(ctx.cfg.tables.followups, { [fid]: out });
}

/** 加新邮箱 after a bounce (C-12): the address joins her profile, so mail can go there. */
export async function addEmail(ctx: Ctx, data: ConsoleData, fid: string, address: string): Promise<void> {
  const f = data.snapshot.followups.get(fid);
  if (!f) throw new Error("找不到这位 KOL 的跟进记录");
  const email = address.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("邮箱格式不对");
  const p = profileOf(data.snapshot, f);
  if (!p) throw new Error("她的跟进没有关联档案");
  if (profileEmails(p).includes(email)) return;
  await ctx.base.update(ctx.cfg.tables.profiles, { [p.record_id]: { 其他邮箱: [text(p["其他邮箱"]), email].filter(Boolean).join(", ") } });
}

/** 记下这条发布: a post found by hand, so its numbers get tracked and the KOL moves to 已发布. */
export async function logPost(ctx: Ctx, data: ConsoleData, fid: string, link: string): Promise<void> {
  const url = link.trim();
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error("请贴完整的帖子链接（https:// 开头）");
  if (!data.snapshot.followups.has(fid)) throw new Error("找不到这位 KOL 的跟进记录");
  const platform = /instagram\.com/.test(url) ? "Instagram" : /youtu\.?be/.test(url) ? "YouTube" : /tiktok\.com/.test(url) ? "TikTok"
    : /threads\.(net|com)/.test(url) ? "Threads" : /facebook\.com|fb\.watch/.test(url) ? "Facebook" : "其他";
  const now = stamp(Date.now(), ctx.cfg.timezone);
  await ctx.base.create(ctx.cfg.tables.posts, [{ KOL: [{ id: fid }], 内容链接: url, 平台: [platform], 发布日期: now, 备注: `${ctx.me.name} 在决策台手动记下` }]);
  await ctx.base.update(ctx.cfg.tables.followups, { [fid]: { 阶段: ["已发布"], 下一步: `${today(ctx.cfg)} 记下发布：${url}`.slice(0, 500) } });
}

/** 写信给她: the reviewer's own words, approved as they write them and sent by the executor. */
export async function writeMail(ctx: Ctx, data: ConsoleData, jobs: Jobs, fid: string, subject: string, body: string, from?: string,
                                o: { to?: string; purpose?: string } = {}): Promise<Job | null> {
  const f = data.snapshot.followups.get(fid);
  if (!f) throw new Error("找不到这位 KOL 的跟进记录");
  if (!body.trim()) throw new Error("信是空的");
  // Any address on her profile may be chosen (E-29); the first is the default.
  const emails = profileEmails(profileOf(data.snapshot, f));
  const to = o.to ? o.to.trim().toLowerCase() : emails[0];
  if (!to) throw new Error("她的档案里没有邮箱");
  if (!emails.includes(to)) throw new Error(`${to} 不是她档案里的邮箱，先把它加到她的档案`);
  const held = (await openMailItems(ctx)).get(fid)?.[0];
  if (held) throw new Error(`她已经有一封待发或没发成的信「${text(held["审核项"])}」，同一时间只能有一封。先在「待你决定」或「出了问题」里处理那一封`);
  const channel = option(f["联系渠道"]);
  // Writing from another mailbox than the one she knows changes who she hears from, so it is only ever chosen.
  const mb = from ? ctx.cfg.mailboxes.find((m) => m.address === from) : mailboxFor(ctx.cfg, channel);
  if (from && !mb) throw new Error(`「${from}」不是「发信邮箱」里启用的邮箱`);
  if (!mb) throw new Error(`她一直是跟「${channel || "未填"}」联系的，这个邮箱系统发不了。到她的页面点「写信给她」，选一个发信邮箱再发`);
  const draft = subject.trim() ? `主题：${subject.trim()}\n${body.trim()}` : body.trim();
  const [id] = await ctx.base.create(ctx.cfg.tables.reviews, [{
    类型: ["回复邮件"], 状态: ["待你审核"], KOL: [{ id: fid }], 提出时间: stamp(Date.now(), ctx.cfg.timezone),
    审核项: `${o.purpose === "发布确认" ? `${CHECK_IN_MARK} ` : ""}${ctx.me.name}在决策台写的信`, 发送渠道: [mb.channel], 收件人: to, 邮件草稿: draft,
  }]);
  // Written from her page, where all her mail is shown, so it answers whatever she sent.
  return approve(ctx, data, jobs, id, {}, true);
}

/** After 恢复发送: everything approved while sending was paused goes out now. */
export function sendQueued(jobs: Jobs): Job {
  return jobs.add("恢复发送：发出排着的信", "", RUN_TITLES.send, async (jctx) => {
    const rep = await sendApproved(jctx, { dryRun: false });
    return `发出 ${rep.sent.length} 封${rep.failed.length ? `，${rep.failed.length} 封没发成` : ""}${rep.skipped.length ? `，${rep.skipped.length} 件先没动` : ""}`;
  });
}

/** 同意 / 不用了 on a template waiting for approval: it is put to use, or set aside. */
export async function decideTemplate(ctx: Ctx, id: string, ok: boolean): Promise<void> {
  const t = ctx.cfg.tables;
  const [r] = await ctx.base.get(t.templates, [id]);
  if (!r) throw new Error("模板表里已经没有这个模板");
  if (option(r["状态"]) !== "待审核") throw new Error(`这个模板现在是「${option(r["状态"])}」，不是待审核`);
  await ctx.base.update(t.templates, { [id]: { 状态: [ok ? "已批准" : "停用"], 审核时间: stamp(Date.now(), ctx.cfg.timezone) } });
}

async function approveNamedTemplate(ctx: Ctx, r: Row): Promise<void> {
  // Read now rather than from the page's copy, which may predate the template.
  const pending = await ctx.base.records(ctx.cfg.tables.templates, { filter: { logic: "and", conditions: [["状态", "intersects", ["待审核"]]] } });
  const tpl = namedTemplate(pending.filter((x) => option(x["状态"]) === "待审核"), r);
  if (tpl) await decideTemplate(ctx, tpl.record_id, true);
}

/** 暂停所有发送, from the top bar. */
export async function setPaused(ctx: Ctx, on: boolean): Promise<boolean> {
  const [row] = await ctx.base.records(ctx.cfg.tables.settings, { fields: ["暂停所有发送"] });
  if (!row) throw new Error("「设置」表是空的");
  await ctx.base.update(ctx.cfg.tables.settings, { [row.record_id]: { 暂停所有发送: on } });
  return on;
}

export async function isPaused(ctx: Ctx): Promise<boolean> {
  return sendingPaused(ctx.base.lark, ctx.cfg.baseToken);
}

export interface FindRequest {
  platform: Platform;
  keywords?: string;
  seeds?: string;
  minFollowers?: number;
  maxFollowers?: number;
  budget: number;
  batch: string;
  /** About how many accounts to search. */
  target?: number;
}

const list = (v: unknown) => String(v ?? "").split(/[,，、\s]+/).map((x) => x.trim().replace(/^@/, "")).filter(Boolean);

/** 找新人: an Apify run on the executor, its people written into 档案 under the chosen batch. */
export function startFind(jobs: Jobs, req: FindRequest): Job {
  const budget = Number(req.budget);
  if (!["instagram", "youtube", "tiktok"].includes(req.platform)) throw new Error("平台只能是 Instagram、YouTube 或 TikTok");
  if (!Number.isFinite(budget) || budget <= 0 || budget > 50) throw new Error("最多花多少要在 0 到 50 美元之间");
  const batch = String(req.batch ?? "").trim();
  if (!batch) throw new Error("要写一个入库批次");
  if (batch.length > 40) throw new Error("入库批次名字太长了");
  const target = req.target ? Number(req.target) : undefined;
  if (target != null && (!Number.isFinite(target) || target < 10 || target > 2000)) throw new Error("搜多少个账号要在 10 到 2000 之间");
  const keywords = list(req.keywords);
  const seeds = list(req.seeds);
  if (!keywords.length && !seeds.length) throw new Error("关键词和相似账号至少填一样");
  return jobs.add(`找新人：${batch}（${req.platform}）`, "", RUN_TITLES.find, async (jctx) => {
    const r = await find(jctx, {
      platform: req.platform, keywords, seeds, handles: [], budget, batch, job: batch, youtubeHidden: false, dryRun: false, target, addBatch: true,
      minFollowers: req.minFollowers ? Number(req.minFollowers) : null, maxFollowers: req.maxFollowers ? Number(req.maxFollowers) : null,
    });
    return `新入库 ${r.新入库} 人，其中有邮箱 ${r.其中有邮箱} 人，花了 $${r.花费美元}`;
  });
}

export async function findOptions(ctx: Ctx): Promise<string[]> {
  return (await ctx.base.fieldOptions(ctx.cfg.tables.profiles, "入库批次")) ?? [];
}

