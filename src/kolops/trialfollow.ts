import { cellTime, day, linkIds, option, text } from "./base.js";
import { mailboxFor, type Config } from "./config.js";
import type { Ctx } from "./ctx.js";
import { displayName, followupEmails, loadSnapshot, profileOf } from "./data.js";
import type { Row } from "./lark.js";
import { RUN_TITLES, stamp } from "./ops.js";
import { closeDeclined, openMailItems } from "./reviews.js";
import { loadTemplates, MissingValue, pickTemplate, render } from "./templates.js";
import { dateWords, expiryWords } from "./trial.js";

const DAY = 86_400_000;

/** The three nudges, each with the template purpose it is written from and the 审核项 tag that keeps it to once. */
export const TRIAL_NUDGES = {
  到期: { purpose: "体验到期", tag: "[体验到期]" },
  未用: { purpose: "体验未用", tag: "[体验未用]" },
  停滞: { purpose: "体验跟进", tag: "[体验停滞]" },
} as const;
type Nudge = keyof typeof TRIAL_NUDGES;

export interface Due {
  kind: Nudge;
  /** The part of 审核项 that marks this nudge as done for this code (and use count, or expiry). */
  key: string;
  why: string;
}

/**
 * Which nudge a trial needs now, if any: the code runs out within 到期提醒天数 with uses left (ask whether to
 * extend); it was never used and nobody has written for 未用提醒天数; or it was partly used and both the code
 * and the conversation have been quiet for 停滞提醒天数.
 */
export function trialDue(cfg: Config, f: Row, name: string, now = Date.now()): Due | null {
  const code = text(f["体验码"]);
  if (!code || option(f["阶段"]) === "结案") return null;
  const used = Number(f["体验码已用"]) || 0;
  const max = Number(f["体验码上限"]) || 0;
  const expires = cellTime(f["体验码到期"], cfg.timezone);
  if (expires == null || expires <= now || (max && used >= max)) return null;
  const r = cfg.trialNudge;
  const last = Math.max(cellTime(f["最近联系日期"], cfg.timezone) ?? 0, cellTime(f["最后来信日期"], cfg.timezone) ?? 0);
  const quiet = last ? Math.floor((now - last) / DAY) : Infinity;
  const until = stamp(expires, cfg.timezone).slice(0, 10);
  if (expires - now <= r.expiringDays * DAY) {
    return { kind: "到期", key: `${TRIAL_NUDGES.到期.tag} ${name} ${code} ${until}`, why: `体验码 ${code} ${until} 到期，还剩 ${max ? max - used : "?"} 次，问要不要延期` };
  }
  if (used === 0 && quiet >= r.unusedDays) {
    return { kind: "未用", key: `${TRIAL_NUDGES.未用.tag} ${name} ${code}`, why: `体验码 ${code} 还没用过，${quiet === Infinity ? "一直" : `${quiet} 天`}没有往来` };
  }
  const lastUse = cellTime(f["体验码最近使用"], cfg.timezone) ?? 0;
  const idle = Math.floor((now - Math.max(lastUse, last)) / DAY);
  if (used > 0 && idle >= r.stalledDays) {
    return { kind: "停滞", key: `${TRIAL_NUDGES.停滞.tag} ${name} ${code} ${used}`, why: `体验码 ${code} 用了 ${used}/${max || "?"} 次，${idle} 天没有新动静` };
  }
  return null;
}

/** How long after a trial code runs out it still gets its one 「体验码已过期」 item (R-09); older ones are history. */
const EXPIRED_WITHIN_DAYS = 14;

/**
 * A trial that ran out while the KOL was still trying it (R-09): one item asking whether to extend, give a new
 * code, or stop, raised once per code. Codes that ran out long ago, or whose KOL has moved on, are left alone.
 */
export function trialExpired(cfg: Config, f: Row, name: string, now = Date.now()): { key: string; why: string; until: string } | null {
  const code = text(f["体验码"]);
  if (!code || !["体验中", "已看报告"].includes(option(f["阶段"]))) return null;
  const expires = cellTime(f["体验码到期"], cfg.timezone);
  if (expires == null || expires > now || now - expires > EXPIRED_WITHIN_DAYS * DAY) return null;
  const until = stamp(expires, cfg.timezone).slice(0, 10);
  return { key: `[体验过期] ${name} ${code}`, why: `体验码 ${code} 已在 ${until} 到期，用了 ${Number(f["体验码已用"]) || 0}/${Number(f["体验码上限"]) || "?"} 次`, until };
}

/**
 * Whether today's usage numbers are in (R-06 to R-08): a code sync finished today. Nudges that rest on how much a
 * code was used wait for one, so a failed sync never reads as 「还没用过」.
 */
async function usageSyncedToday(ctx: Ctx, now: number): Promise<boolean> {
  const runs = await ctx.base.records(ctx.cfg.tables.runs, {
    filter: { logic: "and", conditions: [["结果", "intersects", ["完成"]]] },
    fields: ["运行", "开始时间", "结果"],
  });
  const todayStr = day(now, ctx.cfg.timezone);
  return runs.some((r) => text(r["运行"]).startsWith(RUN_TITLES.codes) && day(r["开始时间"], ctx.cfg.timezone) === todayStr);
}

/**
 * `kol trial-followup`: files a 待你审核 reply for every trial that needs a nudge, written from the project's
 * approved template for it. Each nudge goes in once per code (per use count for a stalled trial, per expiry
 * date for one running out). KOLs we owe an answer, or with an item already waiting, are left alone.
 */
export async function trialFollowup(ctx: Ctx, o: { dryRun: boolean; now?: number }) {
  const cfg = ctx.cfg;
  const t = cfg.tables;
  const now = o.now ?? Date.now();
  // Withdraw what the reviewer turned down first, so those KOLs are no longer counted as waiting on review.
  const withdrawn = await closeDeclined(ctx, { dryRun: o.dryRun });
  const [s, reviews, templates, open, fresh] = await Promise.all([
    loadSnapshot(ctx.base, cfg),
    ctx.base.records(t.reviews, { fields: ["审核项", "状态", "KOL"] }),
    loadTemplates(ctx.base, cfg),
    openMailItems(ctx),
    usageSyncedToday(ctx, now),
  ]);
  const done = new Set(reviews.map((r) => text(r["审核项"])).filter((x) => x.startsWith("[体验")));
  // Anything still open for her (I-1 for mail, plus decisions waiting) comes first.
  const waiting = new Set([...open.keys(), ...reviews.filter((r) => ["待你审核", "待执行"].includes(option(r["状态"]))).flatMap((r) => linkIds(r["KOL"]))]);

  const report = {
    提交审核: [] as { name: string; 类型: Nudge; 原因: string }[],
    要手动跟进: [] as { name: string; 类型: Nudge; 原因: string }[],
    缺模板: [] as string[],
    已过期待定: [] as string[],
    用量没同步: fresh ? undefined : "今天还没有成功同步码的用量，「到期」「没用过」「停滞」先不提，同步成功后再跑",
    审核不发已撤回: withdrawn,
    试跑: o.dryRun || undefined,
  };
  const rows: Record<string, unknown>[] = [];
  const missing = new Map<string, string[]>();
  for (const f of s.followups.values()) {
    const name = displayName(s, f);
    const expired = trialExpired(cfg, f, name, now);
    if (expired && !done.has(expired.key) && !waiting.has(f.record_id)) {
      // No mail to draft yet: what to do next is the reviewer's call (C-10).
      report.已过期待定.push(name);
      rows.push({
        类型: ["决定"], 状态: ["待你审核"], KOL: [{ id: f.record_id }], 提出时间: stamp(now, cfg.timezone), 发送渠道: ["不发邮件"],
        审核项: expired.key, 我的判断和建议: expired.why,
        要你定什么: "体验码已经过期。要延期或换一个新码，就点「让 Claude 改」写一句（比如「延期 7 天」「换新码」），Claude 会起草回信；不再跟进就点「不做了」",
      });
      continue;
    }
    if (!fresh) continue;
    const due = trialDue(cfg, f, name, now);
    if (!due || done.has(due.key)) continue;
    // We owe them an answer, or something for them is already in review: that comes first.
    if (["我们", "等你审核"].includes(option(f["当前轮到谁"])) || waiting.has(f.record_id)) continue;
    const mb = mailboxFor(cfg, option(f["联系渠道"]));
    if (!mb) {
      report.要手动跟进.push({ name, 类型: due.kind, 原因: `${due.why}（${option(f["联系渠道"]) || "没填联系渠道"}，插件发不了）` });
      continue;
    }
    const p = profileOf(s, f);
    const tpl = pickTemplate(templates, TRIAL_NUDGES[due.kind].purpose, text(p?.["語言"]));
    if (!tpl) {
      const purpose = TRIAL_NUDGES[due.kind].purpose;
      missing.set(purpose, [...(missing.get(purpose) ?? []), name]);
      continue;
    }
    const used = Number(f["体验码已用"]) || 0;
    const max = Number(f["体验码上限"]) || 0;
    const expiresIso = new Date(cellTime(f["体验码到期"], cfg.timezone)!).toISOString();
    const call = text(p?.["称呼"]) || name;
    let mail;
    try {
      mail = render(tpl, {
        稱呼: call, 称呼: call, 账号名称: name, 體驗碼: text(f["体验码"]), 体验码: text(f["体验码"]),
        已用: String(used), 剩餘: String(Math.max(0, max - used)), 剩余: String(Math.max(0, max - used)), 次數: String(max), 次数: String(max),
        到期日: expiryWords(expiresIso, cfg.timezone),
        // The first hand-written template says 「原期限{已於 / 將於} {M 月 D 日}到期」.
        "已於 / 將於": "將於", "M 月 D 日": dateWords(expiresIso, cfg.timezone),
      });
    } catch (err) {
      if (!(err instanceof MissingValue)) throw err;
      report.要手动跟进.push({ name, 类型: due.kind, 原因: `${due.why}；${err.message}` });
      continue;
    }
    report.提交审核.push({ name, 类型: due.kind, 原因: due.why });
    rows.push({
      类型: ["回复邮件"], 状态: ["待你审核"], KOL: [{ id: f.record_id }], 提出时间: stamp(now, cfg.timezone),
      审核项: due.key, 我的判断和建议: `${due.why}（用量是 ${day(now, cfg.timezone)} 同步的）。按「${tpl.name}」模板写的`, 发送渠道: [mb.channel],
      收件人: followupEmails(s, f)[0] ?? "", 邮件草稿: mail.subject ? `主题：${mail.subject}\n${mail.body}` : mail.body,
    });
  }
  report.缺模板 = [...missing].map(([m, names]) => `「模板」表里还没有已批准的「${m}」模板，${names.length} 位先没提交：${names.join("、")}`);
  if (o.dryRun || !rows.length) return report;
  await ctx.base.create(t.reviews, rows);
  ctx.run.counts.新增待审 += rows.length;
  ctx.run.op({ type: "飞书变更", result: "完成", action: `体验跟进提交审核 ${rows.length} 条` });
  return report;
}
