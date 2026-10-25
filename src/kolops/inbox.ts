import { readFileSync } from "node:fs";
import { cellTime, dayOf, linkIds, onOrAfter, option, text } from "./base.js";
import { lookupCodes } from "./codes.js";
import { mailboxFor } from "./config.js";
import type { Ctx } from "./ctx.js";
import { displayName, loadSnapshot, profileOf } from "./data.js";
import type { Row } from "./lark.js";
import { addressOf } from "./mail.js";
import { stamp } from "./ops.js";
import { listProjects } from "./projects.js";
import { CLOSE_ACTIONS, CLOSE_REASONS } from "./schema.js";
import { missingPlaceholder, suggestTrialCode, trialPlan } from "./trial.js";

/** How Claude sorts a mail from a KOL; each becomes one 审核队列 item, except 不用回. */
export const INBOX_CATEGORIES = ["想体验", "要回复", "拒绝", "不用回"] as const;
type Category = (typeof INBOX_CATEGORIES)[number];

const QUOTE_MARKERS = [
  /(<[^>\s]+>\s*)?於\s*\d{4}\s*年.{0,40}?(寫道|写道)\s*[:：]/,
  /(<[^>\s]+>\s*)?在\s*\d{4}\s*年.{0,40}?(写道|寫道)\s*[:：]/,
  /On .{5,120}? wrote:/,
  /(^|\s)(发件人|寄件者|From)\s*[:：]/,
  /-{2,}\s*(原始邮件|原始郵件|Original Message)/i,
  /\n\s*>/,
];

/** The KOL's own words: the mail cut at its first quoted-history marker, whitespace collapsed, at most 1,500 characters. */
export function ownWords(body: string): string {
  let cut = body.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(body);
    if (!m || m.index >= cut) continue;
    // The marker line usually starts with the sender's name; cut from the start of that line when what precedes
    // the marker on it looks like a name rather than a sentence.
    const line = body.lastIndexOf("\n", m.index);
    const lead = line >= 0 ? body.slice(line, m.index) : "";
    cut = line >= 0 && lead.length <= 40 && !/[。！？!?，,]/.test(lead) ? line : m.index;
  }
  return body.slice(0, cut).replace(/\s+/g, " ").trim().slice(0, 1500);
}

/**
 * `kol inbox`: every inbound mail still marked 待处理, with the KOL's own words, where their followup stands, and
 * for KOLs without a trial code yet a suggested code name already checked against the project's API.
 */
export async function listInbox(ctx: Ctx, o: { limit: number }) {
  const cfg = ctx.cfg;
  const [s, pending] = await Promise.all([
    loadSnapshot(ctx.base, cfg),
    ctx.base.records(cfg.tables.contacts, {
      filter: { logic: "and", conditions: [["待处理", "==", true], ["方向", "intersects", ["收到"]]] },
      fields: ["Message ID", "渠道", "摘要", "日期", "KOL", "待处理", "方向"],
    }),
  ]);
  const time = (r: Row) => cellTime(r["日期"], cfg.timezone) ?? 0;
  pending.sort((a, b) => time(a) - time(b));
  const batch = pending.slice(0, o.limit);

  // A mail we have written since was most likely answered by hand and only left ticked.
  const lastSent = new Map<string, number>();
  if (batch.length) {
    const sent = await ctx.base.records(cfg.tables.contacts, {
      filter: { logic: "and", conditions: [["方向", "intersects", ["发出"]], onOrAfter("日期", dayOf(time(batch[0]), cfg.timezone))] },
      fields: ["KOL", "日期", "方向"],
    });
    for (const r of sent) for (const id of linkIds(r["KOL"])) lastSent.set(id, Math.max(lastSent.get(id) ?? 0, time(r)));
  }
  const answered = (r: Row) => {
    const at = lastSent.get(linkIds(r["KOL"])[0] ?? "") ?? 0;
    return at > time(r) ? stamp(at, cfg.timezone) : null;
  };

  // Read the bodies per mailbox, 20 at a time as lark-cli batches them.
  const bodies = new Map<string, { from: string; text: string }>();
  const byMailbox = new Map<string, string[]>();
  for (const r of batch) {
    const mb = mailboxFor(cfg, option(r["渠道"]));
    if (mb && text(r["Message ID"])) byMailbox.set(mb.address, [...(byMailbox.get(mb.address) ?? []), text(r["Message ID"])]);
  }
  for (const [mailbox, ids] of byMailbox) {
    const data = await ctx.base.lark.json(["mail", "+messages", "--mailbox", mailbox, "--message-ids", ids.join(","), "--html=false", "--format", "json", "--as", "user"]);
    for (const m of data?.messages ?? []) {
      bodies.set(String(m.message_id), { from: addressOf(String(m.head_from?.mail_address ?? "")), text: ownWords(String(m.body_plain_text ?? "")) });
    }
  }

  // Suggested code names for KOLs who have none yet, checked in one call.
  const suggestions = new Map<string, string>();
  for (const r of batch) {
    const f = s.followups.get(linkIds(r["KOL"])[0] ?? "");
    if (f && !text(f["体验码"])) {
      const name = suggestTrialCode(profileOf(s, f));
      if (name) suggestions.set(f.record_id, name);
    }
  }
  const taken = new Set<string>();
  const key = listProjects().find((p) => p.name === cfg.project)?.dataApiKey;
  const checked = Boolean(cfg.dataApi && key && suggestions.size);
  if (checked) {
    const info = await lookupCodes(cfg.dataApi!, key!, [...new Set(suggestions.values())]).catch(() => new Map());
    for (const k of info.keys()) taken.add(k.slice(k.indexOf(":") + 1));
  }

  return {
    待处理总数: pending.length,
    这一批: batch.length,
    之后已回过信: batch.filter(answered).length,
    分类: INBOX_CATEGORIES,
    说明: "「之后回过信」有日期的，多半已经手动回过，只是没取消待处理，一般选不用回。逐封判断分类，写成决定文件再用 inbox --apply 提交。想体验：草稿用 {體驗碼}{次數}{到期日}；拒绝：发后动作选结案或永不联系并给结案原因；不用回：只取消待处理。",
    来信: batch.map((r) => {
      const fid = linkIds(r["KOL"])[0] ?? "";
      const f = s.followups.get(fid);
      const mb = mailboxFor(cfg, option(r["渠道"]));
      const b = bodies.get(text(r["Message ID"]));
      const suggested = suggestions.get(fid);
      return {
        contact: r.record_id,
        kol: f ? displayName(s, f) : "（没关联跟进）",
        followup: fid || null,
        阶段: f ? option(f["阶段"]) : "",
        体验码: f ? text(f["体验码"]) || null : null,
        体验码到期: f && cellTime(f["体验码到期"], cfg.timezone) ? stamp(cellTime(f["体验码到期"], cfg.timezone)!, cfg.timezone) : null,
        渠道: option(r["渠道"]),
        插件能回: Boolean(mb),
        from: b?.from ?? "",
        主题: text(r["摘要"]),
        日期: stamp(time(r), cfg.timezone),
        之后回过信: answered(r),
        内容: b?.text ?? (mb ? "（读不到正文）" : "（这个渠道插件读不了，请手动看）"),
        ...(suggested ? { 建议码名: suggested, 码名可用: checked ? !taken.has(suggested.toLowerCase()) : "没查（这台电脑没有接口密钥）" } : {}),
      };
    }),
  };
}

/**
 * What an approved item's 发后动作 changes: the followup closes with the item's 结案原因, and 永不联系 also marks
 * the profile so nothing is ever sent to it again. Null when the item has no 发后动作; a string when it can't be done.
 */
export function closeChanges(review: Row, profile: Row | undefined, day: string): { followup: Record<string, unknown>; profile?: [string, Record<string, unknown>] } | string | null {
  const action = option(review["发后动作"]);
  if (!action) return null;
  if (!CLOSE_ACTIONS.includes(action as any)) return `发后动作「${action}」看不懂，只能是 ${CLOSE_ACTIONS.join(" 或 ")}`;
  const reason = option(review["结案原因"]);
  if (!reason) return "选了发后动作但没选结案原因";
  const followup = { 阶段: ["结案"], 结案原因: [reason], 当前轮到谁: ["无需动作"], 下一步: `${day} ${action}（${reason}）` };
  if (action !== "永不联系") return { followup };
  if (!profile) return "要标永不联系，但找不到这位 KOL 的档案";
  return { followup, profile: [profile.record_id, { 联系许可: ["永不联系"], 联系许可原因: `${day} ${reason}` }] };
}

export interface InboxDecision {
  contact: string;
  category: Category;
  /** The reply body, for 想体验 and 要回复 (and optionally 拒绝). The first line may be 主题：…; replies usually leave it out. */
  draft?: string;
  /** Who the reply goes to; defaults to the sender of the mail. */
  to?: string;
  /** A code to create, extend or (开活动码) a partner campaign to open before the reply goes out. */
  trial?: { action: "发码" | "延期" | "开活动码"; code?: string; uses?: number; days?: number; percentOff?: number; market?: string; pageName?: string };
  /** For 拒绝: what happens to the followup once approved. */
  after?: (typeof CLOSE_ACTIONS)[number];
  reason?: string;
  /** One line for the reviewer: why this answer. */
  note?: string;
  /** Short label for 审核项, e.g. 「想体验，发码 deer_jay」. */
  label?: string;
}

/**
 * `kol inbox --apply file.json`: turns Claude's decisions into 审核队列 items in one go, unticks the mails it
 * covered and hands their followups to 等你审核. Every decision is checked first; if any is wrong nothing is written.
 */
export async function applyInbox(ctx: Ctx, o: { file: string; dryRun: boolean }) {
  const cfg = ctx.cfg;
  const t = cfg.tables;
  const decisions: InboxDecision[] = JSON.parse(readFileSync(o.file, "utf8"));
  const s = await loadSnapshot(ctx.base, cfg);
  const pending = new Map((await ctx.base.records(t.contacts, {
    filter: { logic: "and", conditions: [["待处理", "==", true], ["方向", "intersects", ["收到"]]] },
    fields: ["Message ID", "渠道", "摘要", "KOL", "待处理", "方向"],
  })).map((r) => [r.record_id, r]));

  const errors: string[] = [];
  const reviews: Record<string, unknown>[] = [];
  const untick: Record<string, Record<string, unknown>> = {};
  const handOver: Record<string, Record<string, unknown>> = {};
  const now = stamp(Date.now(), cfg.timezone);
  for (const d of decisions) {
    const c = pending.get(d.contact);
    const where = `${d.contact}`;
    if (!c) {
      errors.push(`${where}：不是待处理的来信（可能已经处理过）`);
      continue;
    }
    if (!INBOX_CATEGORIES.includes(d.category)) {
      errors.push(`${where}：分类「${d.category}」不对，只能是 ${INBOX_CATEGORIES.join("、")}`);
      continue;
    }
    const fid = linkIds(c["KOL"])[0] ?? "";
    const f = s.followups.get(fid);
    const name = f ? displayName(s, f) : where;
    untick[d.contact] = { 待处理: false };
    if (d.category === "不用回") continue;
    if (!f) {
      errors.push(`${where}：这封信没关联跟进记录，只能选「不用回」`);
      continue;
    }
    const mb = mailboxFor(cfg, option(c["渠道"]));
    const draft = (d.draft ?? "").trim();
    const replying = d.category !== "拒绝" || Boolean(draft);
    if (replying && !mb) {
      errors.push(`${where}（${name}）：渠道「${option(c["渠道"])}」插件发不了，请手动回，或选「不用回」`);
      continue;
    }
    if (replying && !draft) {
      errors.push(`${where}（${name}）：「${d.category}」要写回复草稿`);
      continue;
    }
    if (d.category === "想体验" && d.trial?.action !== "发码" && !text(f["体验码"])) {
      errors.push(`${where}（${name}）：想体验但没有发码，也没有现成的体验码`);
      continue;
    }
    if (d.category === "拒绝" && (!d.after || !CLOSE_ACTIONS.includes(d.after) || !d.reason || !CLOSE_REASONS.includes(d.reason))) {
      errors.push(`${where}（${name}）：拒绝要选发后动作（${CLOSE_ACTIONS.join(" / ")}）和结案原因（${CLOSE_REASONS.join(" / ")}）`);
      continue;
    }
    const review: Record<string, unknown> = {
      类型: [replying ? "回复邮件" : "决定"], 状态: ["待你审核"], KOL: [{ id: fid }], 提出时间: now,
      审核项: `[批量] ${d.category} ${name}${d.label ? `：${d.label}` : ""}`.slice(0, 200),
      ...(d.note ? { 我的判断和建议: d.note } : {}),
      发送渠道: [replying ? mb!.channel : "不发邮件"],
      ...(replying ? { 收件人: d.to ?? "", 邮件草稿: draft } : {}),
      ...(d.after ? { 发后动作: [d.after], 结案原因: [d.reason] } : {}),
    };
    if (d.trial) {
      review["体验码动作"] = [d.trial.action];
      if (d.trial.code) review[d.trial.action === "开活动码" ? "活动码" : "体验码"] = d.trial.code;
      if (d.trial.percentOff) review["粉丝折扣"] = d.trial.percentOff;
      if (d.trial.market) review["销售市场"] = d.trial.market;
      if (d.trial.pageName) review["合作页名称"] = d.trial.pageName;
      if (d.trial.uses) review["体验次数"] = d.trial.uses;
      if (d.trial.days) review["体验天数"] = d.trial.days;
      const plan = trialPlan(cfg, review as any, f, profileOf(s, f));
      const problem = typeof plan === "string" ? plan : plan ? missingPlaceholder(plan, draft) : "";
      if (problem) {
        errors.push(`${where}（${name}）：${problem}`);
        continue;
      }
    }
    reviews.push({ ...review, _contact: d.contact, _from: c });
    handOver[fid] = { 当前轮到谁: ["等你审核"] };
  }
  if (errors.length) return { 写入: 0, 问题: errors, 说明: "有问题的决定改好之前，一条都没写" };

  // The reply goes to whoever wrote, unless the decision says otherwise; read the sender only when needed.
  const needSender = reviews.filter((r) => r["邮件草稿"] && !r["收件人"]);
  if (needSender.length) {
    const byMailbox = new Map<string, Row[]>();
    for (const r of needSender) {
      const c = r._from as Row;
      const mb = mailboxFor(cfg, option(c["渠道"]))!;
      byMailbox.set(mb.address, [...(byMailbox.get(mb.address) ?? []), c]);
    }
    const senders = new Map<string, string>();
    for (const [mailbox, rows] of byMailbox) {
      const data = await ctx.base.lark.json(["mail", "+messages", "--mailbox", mailbox, "--message-ids", rows.map((c) => text(c["Message ID"])).join(","), "--html=false", "--format", "json", "--as", "user"]);
      for (const m of data?.messages ?? []) senders.set(String(m.message_id), addressOf(String(m.head_from?.mail_address ?? "")));
    }
    for (const r of needSender) r["收件人"] = senders.get(text((r._from as Row)["Message ID"])) ?? "";
  }
  const rows = reviews.map(({ _contact, _from, ...r }) => r);
  const report = {
    写入: rows.length, 只标为已处理: Object.keys(untick).length - rows.length,
    按分类: Object.fromEntries(INBOX_CATEGORIES.map((k) => [k, decisions.filter((d) => d.category === k).length])),
    试跑: o.dryRun || undefined,
  };
  if (o.dryRun) return report;
  if (rows.length) await ctx.base.create(t.reviews, rows);
  await ctx.base.update(t.contacts, untick);
  if (Object.keys(handOver).length) await ctx.base.update(t.followups, handOver);
  ctx.run.counts.新增待审 += rows.length;
  ctx.run.op({ type: "来信处理", result: "完成", action: `批量处理来信 ${decisions.length} 封，提交审核 ${rows.length} 条` });
  return report;
}
