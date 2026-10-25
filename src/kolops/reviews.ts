import { readFileSync } from "node:fs";
import { cellTime, linkIds, option, text } from "./base.js";
import type { Ctx } from "./ctx.js";
import { displayName, loadSnapshot, profileOf } from "./data.js";
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

const OPEN = ["待你审核", "待执行"];
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
  const list: { review: string; draft: string; note?: string }[] = JSON.parse(readFileSync(o.file, "utf8"));
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
    const plan = trialPlan(ctx.cfg, r, f, profileOf(s, f));
    const problem = typeof plan === "string" ? plan : plan ? missingPlaceholder(plan, draft) : "";
    if (problem) {
      errors.push(`${x.review}：${problem}`);
      continue;
    }
    const history = [text(r["我的判断和建议"]), `${today(ctx.cfg)} 按意见改：${text(r["你的意见"]) || "（没写）"}${x.note ? ` → ${x.note}` : ""}`].filter(Boolean).join("\n");
    changes[x.review] = { 邮件草稿: draft, 处理: null, 审核结果: null, 你的意见: "", 我的判断和建议: history.slice(0, 5000), 状态: ["待你审核"] };
  }
  if (errors.length) return { 写入: 0, 问题: errors, 说明: "有问题的改好之前，一条都没写" };
  if (!o.dryRun && list.length) {
    await ctx.base.update(ctx.cfg.tables.reviews, changes);
    ctx.run.op({ type: "飞书变更", result: "完成", action: `按审核意见重写 ${list.length} 条` });
  }
  return { 写入: o.dryRun ? 0 : list.length, 试跑: o.dryRun || undefined };
}
