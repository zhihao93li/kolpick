import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cellTime, linkIds, option, text } from "./base.js";
import { mailboxFor, type Config } from "./config.js";
import type { Ctx } from "./ctx.js";
import { displayName, followupEmails, loadSnapshot, profileOf } from "./data.js";
import type { Row } from "./lark.js";
import { stamp, today } from "./ops.js";
import { missingPlaceholder, trialPlan } from "./trial.js";

/** Where a 审核队列 item stands after review. 处理 decides; the older 审核结果 column can still say no or 改. */
export type ReviewState = "approved" | "revise" | "declined" | "pending";

export function reviewState(r: Row): ReviewState {
  const p = option(r["处理"]);
  const res = option(r["审核结果"]);
  if (p === "不发" || ["先不发", "不同意"].includes(res)) return "declined";
  if (p === "改" || res === "退回修改") return "revise";
  if (p === "发／同意") return "approved";
  return "pending";
}

/** Approval is 处理 = 发／同意, unless 审核结果 says otherwise. */
export function isApproved(r: Row): boolean {
  return reviewState(r) === "approved";
}

/**
 * Whether approving this item makes the executor do something: send a mail, create or extend a code, or close
 * the followup. Decisions, template approvals and to-dos only record the answer.
 */
export function executesOnApproval(r: Row): boolean {
  const sends = ["回复邮件", "协议"].includes(option(r["类型"])) && option(r["发送渠道"]) !== "不发邮件" && Boolean(text(r["邮件草稿"]));
  return sends || Boolean(option(r["体验码动作"])) || Boolean(option(r["发后动作"]));
}

/** What 同意来源 says for an approval made in the decision console. */
export const CONSOLE_SOURCE = "决策台";

/** Everything an approval covers: change any of these afterwards and the approval no longer holds. */
export const FINGERPRINT_FIELDS = ["邮件草稿", "收件人", "发送渠道", "体验码动作", "体验码", "体验次数", "体验天数", "活动码", "粉丝折扣",
  "销售市场", "合作页名称", "发后动作", "结案原因"];
export const APPROVAL_FIELDS = ["同意来源", "同意人", "同意时间", "内容指纹"];

function cellWords(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  return Array.isArray(v) ? v.map((x) => (typeof x === "object" && x ? (x as any).name ?? (x as any).text ?? (x as any).id ?? "" : String(x))).join("|") : String(v).trim();
}

/** A short hash of what the item would do, written when it is approved and checked again before it is carried out. */
export function fingerprint(r: Row): string {
  return createHash("sha256").update(JSON.stringify(FINGERPRINT_FIELDS.map((f) => cellWords(r[f])))).digest("hex").slice(0, 16);
}

/**
 * Why an approved item may not be carried out as it stands, or null when it may: it was changed after it was
 * approved (`changed`, so it goes back for review), or it was approved somewhere that no longer counts.
 */
export function approvalProblem(cfg: Pick<Config, "consoleOnlyApprovals">, r: Row): { reason: string; changed?: boolean } | null {
  const fp = text(r["内容指纹"]);
  if (fp && fp !== fingerprint(r)) return { reason: "同意之后内容被改过，已退回重新看", changed: true };
  if (cfg.consoleOnlyApprovals && text(r["同意来源"]) !== CONSOLE_SOURCE) {
    return { reason: "现在只认决策台上的同意：这一条是在飞书里批的，没有执行。要做的话，在决策台里点同意" };
  }
  return null;
}

/** Puts an item back in front of the reviewer with the reason, clearing its approval. */
export async function sendBack(ctx: Ctx, reviewId: string, why: string): Promise<void> {
  await ctx.base.update(ctx.cfg.tables.reviews, { [reviewId]: {
    处理: null, 审核结果: null, 同意来源: "", 同意人: "", 同意时间: null, 内容指纹: "", 状态: ["待你审核"],
    执行结果: `${stamp(Date.now(), ctx.cfg.timezone)} ${why}`.slice(0, 2000),
  } });
}

/**
 * Approves an item from the decision console: applies the reviewer's last edits, then records who approved it,
 * when, and the fingerprint of exactly what they saw.
 */
export async function approveInConsole(ctx: Ctx, reviewId: string, edits: Record<string, unknown> | ((r: Row) => Record<string, unknown>) = {}): Promise<Row> {
  const t = ctx.cfg.tables;
  const [r] = await ctx.base.get(t.reviews, [reviewId]);
  if (!r) throw new Error("审核队列里已经没有这一条");
  // Edits may be worked out from the row as read here, so a check on it covers exactly what is approved.
  if (typeof edits === "function") edits = edits(r);
  const state = option(r["状态"]);
  if (!["待你审核", "待执行"].includes(state)) throw new Error(`这一条现在是「${state}」，不能再同意`);
  const merged = { ...r, ...edits };
  const fields = {
    ...edits, 处理: ["发／同意"], 审核结果: null, 状态: ["待你审核"],
    同意来源: CONSOLE_SOURCE, 同意人: ctx.me.name || ctx.me.id, 同意时间: stamp(Date.now(), ctx.cfg.timezone), 内容指纹: fingerprint(merged),
  };
  await ctx.base.update(t.reviews, { [reviewId]: fields });
  return { ...merged, ...fields };
}

const OPEN = ["待你审核", "待执行"];
/** Marks a mail asking an overdue KOL about her post; the ones that went out are counted (C-07). */
export const CHECK_IN_MARK = "[发布确认]";
const MAIL_TYPES = ["回复邮件", "协议"];

/** True while the item is being carried out: claimed by a send that hasn't finished. */
export function executing(r: Row): boolean {
  return option(r["状态"]) === "待执行" && text(r["执行结果"]).startsWith("执行中");
}

/**
 * I-5: an item whose mail or code may already have gone through: being carried out, failed with an unknown result,
 * or noted on this computer as sending, unknown, prepared or sent. Only checking the mailbox and the 出了问题 card
 * settle it; nothing else may send it back, move it to another mailbox or withdraw it.
 */
export function uncertain(r: Row, journalState?: string): string {
  if (executing(r)) return "正在执行";
  if (option(r["状态"]) === "执行失败" && /结果不明|中断/.test(text(r["执行结果"]))) return "结果不明";
  if (journalState && journalState !== "failed") return journalState === "sent" || journalState === "recorded" ? "已经发出" : "结果不明";
  return "";
}

/**
 * The items holding each KOL's one place for a mail (I-1): mail items still to be decided, approved, being sent, or
 * failed and not yet dealt with. An item that sends nothing (only a code) doesn't hold it.
 */
export async function openMailItems(ctx: Ctx): Promise<Map<string, Row[]>> {
  const rows = await ctx.base.records(ctx.cfg.tables.reviews, {
    filter: { logic: "and", conditions: [["状态", "intersects", [...OPEN, "执行失败"]]] },
    fields: ["审核项", "类型", "状态", "处理", "审核结果", "KOL", "邮件草稿", "发送渠道", "执行结果"],
  });
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    if (!MAIL_TYPES.includes(option(r["类型"])) || option(r["发送渠道"]) === "不发邮件" || option(r["处理"]) === "不发") continue;
    for (const fid of linkIds(r["KOL"])) out.set(fid, [...(out.get(fid) ?? []), r]);
  }
  return out;
}

/** A newer draft may take the place of this one only while nothing of it has been tried (E-20). */
export function replaceable(r: Row): boolean {
  return OPEN.includes(option(r["状态"])) && !executing(r);
}
const REVIEW_FIELDS = ["审核项", "类型", "状态", "处理", "审核结果", "KOL", "你的意见", "我的判断和建议", "邮件草稿", "发送渠道", "体验码动作", "体验码", "体验次数", "体验天数", "活动码", "粉丝折扣", "销售市场", "合作页名称"];

export async function openReviews(ctx: Ctx): Promise<Row[]> {
  return ctx.base.records(ctx.cfg.tables.reviews, { filter: { logic: "and", conditions: [["状态", "intersects", OPEN]] }, fields: REVIEW_FIELDS });
}

/**
 * Items the reviewer chose 不发 for: withdrawn, with the reason kept, and their KOL handed back so it no longer
 * waits on review. A KOL who wrote last needs nothing more from us (we chose not to answer); otherwise we are
 * waiting on them, as before the item was filed. Runs inside `send` and the daily `trial-followup`.
 */
export async function closeDeclined(ctx: Ctx, o: { dryRun: boolean; reviews?: Row[] }): Promise<string[]> {
  const t = ctx.cfg.tables;
  const all = o.reviews ?? await openReviews(ctx);
  const declined = all.filter((r) => reviewState(r) === "declined");
  if (!declined.length) return [];
  const s = await loadSnapshot(ctx.base, ctx.cfg);
  const stillOpen = new Set(all.filter((r) => reviewState(r) !== "declined").flatMap((r) => linkIds(r["KOL"])));
  const now = stamp(Date.now(), ctx.cfg.timezone);
  const day = today(ctx.cfg);
  const names: string[] = [];
  const reviewChanges: Record<string, Record<string, unknown>> = {};
  const followupChanges: Record<string, Record<string, unknown>> = {};
  for (const r of declined) {
    const fid = linkIds(r["KOL"])[0] ?? "";
    const f = s.followups.get(fid);
    const why = text(r["你的意见"]);
    names.push(f ? displayName(s, f) : text(r["审核项"]));
    reviewChanges[r.record_id] = { 状态: ["已撤回"], 执行时间: now, 执行结果: `审核选了不发，没有发出${why ? `（${why}）` : ""}`.slice(0, 2000) };
    if (!f || option(f["当前轮到谁"]) !== "等你审核" || stillOpen.has(fid)) continue;
    const lastIn = cellTime(f["最后来信日期"], ctx.cfg.timezone) ?? 0;
    const lastOut = cellTime(f["最近联系日期"], ctx.cfg.timezone) ?? 0;
    followupChanges[fid] = {
      当前轮到谁: [lastIn > lastOut ? "无需动作" : "KOL"],
      下一步: `${day} 审核不发：${text(r["审核项"])}${why ? `（${why}）` : ""}`.slice(0, 500),
    };
  }
  if (o.dryRun) return names;
  await ctx.base.update(t.reviews, reviewChanges);
  if (Object.keys(followupChanges).length) await ctx.base.update(t.followups, followupChanges);
  ctx.run.op({ type: "飞书变更", result: "完成", action: `审核不发的撤回 ${names.length} 条` });
  return names;
}

/** `kol revise` with no file: the items sent back with 改, with the reviewer's words and the draft to rework. */
export async function toRevise(ctx: Ctx) {
  const s = await loadSnapshot(ctx.base, ctx.cfg);
  const items = (await openReviews(ctx)).filter((r) => reviewState(r) === "revise");
  return {
    要改: items.map((r) => {
      const f = s.followups.get(linkIds(r["KOL"])[0] ?? "");
      return {
        review: r.record_id, kol: f ? displayName(s, f) : "", 审核项: text(r["审核项"]), 意见: text(r["你的意见"]) || "（没写意见，问同事要改哪里）",
        草稿: text(r["邮件草稿"]), 体验码动作: option(r["体验码动作"]) || undefined,
      };
    }),
    说明: "按意见重写后写成 [{\"review\": \"rec…\", \"draft\": \"新草稿\", \"note\": \"改了什么\"}]，用 revise --apply 提交，会重新送审",
  };
}

/**
 * `kol revise --apply file.json`: puts each reworked draft back into its item and sends it for review again:
 * 处理 and 审核结果 are cleared, the reviewer's words move into 我的判断和建议 so the next round starts clean.
 * Every entry is checked first; if any is wrong nothing is written.
 */
export async function applyRevisions(ctx: Ctx, o: { file: string; dryRun: boolean }) {
  /**
   * `trial` turns the item into a code action with its mail, e.g. an expired trial the reviewer asked to extend or
   * replace (C-10): 延期 the KOL's current code by `days`, or 发码 a new `code`.
   */
  const list: { review: string; draft: string; note?: string; trial?: { action: "发码" | "延期"; days?: number; uses?: number; code?: string } }[] =
    JSON.parse(readFileSync(o.file, "utf8"));
  const s = await loadSnapshot(ctx.base, ctx.cfg);
  const open = new Map((await openReviews(ctx)).map((r) => [r.record_id, r]));
  const errors: string[] = [];
  const changes: Record<string, Record<string, unknown>> = {};
  for (const x of list) {
    const r = open.get(x.review);
    if (!r || reviewState(r) !== "revise") {
      errors.push(`${x.review}：不是待修改的审核项`);
      continue;
    }
    const draft = (x.draft ?? "").trim();
    if (!draft) {
      errors.push(`${x.review}：新草稿是空的`);
      continue;
    }
    const f = s.followups.get(linkIds(r["KOL"])[0] ?? "");
    let turned: Record<string, unknown> = {};
    if (x.trial) {
      if (!["发码", "延期"].includes(x.trial.action)) {
        errors.push(`${x.review}：trial.action 只能是「发码」或「延期」`);
        continue;
      }
      const mb = f ? mailboxFor(ctx.cfg, option(f["联系渠道"])) : undefined;
      const to = f ? followupEmails(s, f)[0] : "";
      if (!mb || !to) {
        errors.push(`${x.review}：她的联系渠道插件发不了，或档案里没有邮箱，没法改成发信`);
        continue;
      }
      turned = {
        类型: ["回复邮件"], 发送渠道: [mb.channel], 收件人: to, 体验码动作: [x.trial.action],
        体验码: x.trial.code ?? (x.trial.action === "延期" ? text(f?.["体验码"]) : ""),
        ...(x.trial.days ? { 体验天数: x.trial.days } : {}), ...(x.trial.uses ? { 体验次数: x.trial.uses } : {}),
      };
    }
    const plan = trialPlan(ctx.cfg, { ...r, ...turned }, f, profileOf(s, f));
    const problem = typeof plan === "string" ? plan : plan ? missingPlaceholder(plan, draft) : "";
    if (problem) {
      errors.push(`${x.review}：${problem}`);
      continue;
    }
    const history = [text(r["我的判断和建议"]), `${today(ctx.cfg)} 按意见改：${text(r["你的意见"]) || "（没写）"}${x.note ? ` → ${x.note}` : ""}`].filter(Boolean).join("\n");
    changes[x.review] = { ...turned, 邮件草稿: draft, 处理: null, 审核结果: null, 你的意见: "", 我的判断和建议: history.slice(0, 5000), 状态: ["待你审核"] };
  }
  if (errors.length) return { 写入: 0, 问题: errors, 说明: "有问题的改好之前，一条都没写" };
  if (!o.dryRun && list.length) {
    await ctx.base.update(ctx.cfg.tables.reviews, changes);
    ctx.run.op({ type: "飞书变更", result: "完成", action: `按审核意见重写 ${list.length} 条` });
  }
  return { 写入: o.dryRun ? 0 : list.length, 试跑: o.dryRun || undefined };
}
