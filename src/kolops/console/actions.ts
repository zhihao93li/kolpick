import { cellTime, linkIds, option, text } from "../base.js";
import { loadConfig, mailboxFor, sendingPaused } from "../config.js";
import { makeCtx, type Ctx } from "../ctx.js";
import { displayName, profileEmails, profileOf } from "../data.js";
import { notExecutor, ExecutorLock } from "../executor.js";
import { find } from "../find.js";
import type { Row } from "../lark.js";
import { RUN_TITLES, stamp, today } from "../ops.js";
import { approveInConsole, closeDeclined } from "../reviews.js";
import { CLOSE_REASONS } from "../schema.js";
import { sendApproved } from "../send.js";
import type { Platform } from "../../discovery/models.js";
import type { ConsoleData } from "./state.js";

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

/** 同意: records the approval (with the reviewer's last edits), then has the executor carry it out. */
export async function approve(ctx: Ctx, data: ConsoleData, jobs: Jobs, id: string, edits: Record<string, unknown>): Promise<Job> {
  const r = await approveInConsole(ctx, id, cleanEdits(edits));
  const fid = linkIds(r["KOL"])[0] ?? "";
  const who = nameOf(data, fid) || text(r["审核项"]);
  return jobs.add(`${who}：${text(r["审核项"])}`, fid, RUN_TITLES.send, async (jctx) => {
    const rep = await sendApproved(jctx, { dryRun: false, only: [id] });
    if (rep.failed.length) throw new Error(rep.failed[0].reason);
    if (rep.sent.length) return `已发给 ${rep.sent[0].recipient}（${rep.sent[0].mailbox}）`;
    if (rep.closed.length) return "已结束跟进";
    if (rep.skipped.length) throw new Error(rep.skipped[0].reason);
    return "已同意（这件事不用发信）";
  });
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

/** A failed item the reviewer has dealt with by hand. */
export async function problemDone(ctx: Ctx, id: string): Promise<void> {
  const r = await review(ctx, id);
  await ctx.base.update(ctx.cfg.tables.reviews, { [id]: {
    状态: ["已撤回"], 执行结果: `${text(r["执行结果"])}\n${stamp(Date.now(), ctx.cfg.timezone)} ${ctx.me.name} 标为已人工处理`.trim().slice(0, 2000),
  } });
}

async function contact(ctx: Ctx, id: string): Promise<Row> {
  const [c] = await ctx.base.get(ctx.cfg.tables.contacts, [id], ["待处理", "KOL", "方向"]);
  if (!c) throw new Error("接触记录里已经没有这封信");
  return c;
}

/** 不用回: the mails (one KOL's card may hold several) are filed as handled. */
export async function mailDone(ctx: Ctx, ids: string[]): Promise<void> {
  for (const id of ids) await contact(ctx, id);
  await ctx.base.update(ctx.cfg.tables.contacts, Object.fromEntries(ids.map((id) => [id, { 待处理: false }])));
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
  await ctx.base.update(ctx.cfg.tables.followups, { [fid]: { 当前轮到谁: ["我们"], ...(last ? { 最后来信日期: stamp(last, ctx.cfg.timezone) } : {}) } });
}

/** 不再跟进 / 不要再联系她. */
export async function closeFollowup(ctx: Ctx, data: ConsoleData, fid: string, o: { never: boolean; reason?: string }): Promise<void> {
  const f = data.snapshot.followups.get(fid);
  if (!f) throw new Error("找不到这位 KOL 的跟进记录");
  const reason = o.reason && CLOSE_REASONS.includes(o.reason) ? o.reason : o.never ? "拒绝" : "其他";
  const day = today(ctx.cfg);
  const action = o.never ? "永不联系" : "结案";
  await ctx.base.update(ctx.cfg.tables.followups, { [fid]: { 阶段: ["结案"], 结案原因: [reason], 当前轮到谁: ["无需动作"], 下一步: `${day} ${action}（${reason}，${ctx.me.name}在决策台操作）` } });
  const p = profileOf(data.snapshot, f);
  if (o.never && p) await ctx.base.update(ctx.cfg.tables.profiles, { [p.record_id]: { 联系许可: ["永不联系"], 联系许可原因: `${day} ${reason}` } });
}

const FOLLOWUP_EDITS: Record<string, (v: string, tz: string) => unknown> = {
  下次跟进日期: (v) => (v ? `${v} 00:00` : null),
  下一步: (v) => v,
  当前轮到谁: (v) => [v],
  级别: (v) => [v],
};

/** Edits to a followup made on its page. */
export async function updateFollowup(ctx: Ctx, data: ConsoleData, fid: string, fields: Record<string, string>): Promise<void> {
  if (!data.snapshot.followups.has(fid)) throw new Error("找不到这位 KOL 的跟进记录");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    const to = FOLLOWUP_EDITS[k];
    if (!to) throw new Error(`「${k}」不能在这里改`);
    if (k === "下次跟进日期" && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error("下次跟进日期的格式不对");
    out[k] = to(String(v ?? "").trim(), ctx.cfg.timezone);
  }
  if (Object.keys(out).length) await ctx.base.update(ctx.cfg.tables.followups, { [fid]: out });
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
export async function writeMail(ctx: Ctx, data: ConsoleData, jobs: Jobs, fid: string, subject: string, body: string): Promise<Job> {
  const f = data.snapshot.followups.get(fid);
  if (!f) throw new Error("找不到这位 KOL 的跟进记录");
  if (!body.trim()) throw new Error("信是空的");
  const to = profileEmails(profileOf(data.snapshot, f))[0];
  if (!to) throw new Error("她的档案里没有邮箱");
  const channel = option(f["联系渠道"]);
  const mb = mailboxFor(ctx.cfg, channel) ?? ctx.cfg.mailboxes[0];
  if (!mb) throw new Error("「发信邮箱」里没有启用的邮箱");
  const draft = subject.trim() ? `主题：${subject.trim()}\n${body.trim()}` : body.trim();
  const [id] = await ctx.base.create(ctx.cfg.tables.reviews, [{
    类型: ["回复邮件"], 状态: ["待你审核"], KOL: [{ id: fid }], 提出时间: stamp(Date.now(), ctx.cfg.timezone),
    审核项: `${ctx.me.name}在决策台写的信`, 发送渠道: [mb.channel], 收件人: to, 邮件草稿: draft,
  }]);
  return approve(ctx, data, jobs, id, {});
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
}

const list = (v: unknown) => String(v ?? "").split(/[,，、\s]+/).map((x) => x.trim().replace(/^@/, "")).filter(Boolean);

/** 找新人: an Apify run on the executor, its people written into 档案 under the chosen batch. */
export function startFind(jobs: Jobs, req: FindRequest): Job {
  const budget = Number(req.budget);
  if (!["instagram", "youtube", "tiktok"].includes(req.platform)) throw new Error("平台只能是 Instagram、YouTube 或 TikTok");
  if (!Number.isFinite(budget) || budget <= 0 || budget > 50) throw new Error("最多花多少要在 0 到 50 美元之间");
  if (!req.batch) throw new Error("要选一个入库批次");
  const keywords = list(req.keywords);
  const seeds = list(req.seeds);
  if (!keywords.length && !seeds.length) throw new Error("关键词和相似账号至少填一样");
  return jobs.add(`找新人：${req.batch}（${req.platform}）`, "", RUN_TITLES.find, async (jctx) => {
    const r = await find(jctx, {
      platform: req.platform, keywords, seeds, handles: [], budget, batch: req.batch, job: req.batch, youtubeHidden: false, dryRun: false,
      minFollowers: req.minFollowers ? Number(req.minFollowers) : null, maxFollowers: req.maxFollowers ? Number(req.maxFollowers) : null,
    });
    return `新入库 ${r.新入库} 人，其中有邮箱 ${r.其中有邮箱} 人，花了 $${r.花费美元}`;
  });
}

export async function findOptions(ctx: Ctx): Promise<string[]> {
  return (await ctx.base.fieldOptions(ctx.cfg.tables.profiles, "入库批次")) ?? [];
}

