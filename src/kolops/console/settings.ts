import { createHash } from "node:crypto";
import { cellTime, day, emailsIn, linkIds, option, text } from "../base.js";
import { warmupLimit } from "../config.js";
import type { Ctx } from "../ctx.js";
import { machine, machineLabel, notExecutor } from "../executor.js";
import type { Row } from "../lark.js";
import { bounceStats, stamp } from "../ops.js";
import { partnerValues } from "../partner.js";
import { listProjects } from "../projects.js";
import { approvalProblem, fingerprint, reviewState, sendBack, uncertain } from "../reviews.js";
import { SENDING_TYPES } from "../send.js";
import { SETTING_DEFAULTS, TEMPLATE_PURPOSES } from "../schema.js";
import type { ConsoleData } from "./state.js";

/**
 * The settings page (U-5): the project's rules, mailboxes, templates and options, read from and written to the
 * same 设置 / 发信邮箱 / 模板 tables the commands read, so a change here is what the next run uses. Every change
 * is written to 操作日志 as 「[设置] …：旧 → 新」 with who made it.
 */

type Kind = "number" | "text" | "date" | "list" | "bool";
interface Field { key: string; label: string; group: string; kind: Kind; min?: number; max?: number; hint?: string; readOnly?: boolean }

export const SETTING_FIELDS: Field[] = [
  { key: "全公司每日上限", label: "每天最多联系几位", group: "发信", kind: "number", min: 1 },
  { key: "每分钟上限", label: "每分钟最多发几封", group: "发信", kind: "number", min: 1 },
  { key: "退信率暂停线", label: "退信率暂停线（%）", group: "发信", kind: "number", min: 0, max: 100, hint: "最近 14 天至少发过 20 封才算；0 表示不检查" },
  { key: "第一次催信天数", label: "邀约后几天催第一次", group: "催信和结案", kind: "number", min: 0 },
  { key: "第二次催信天数", label: "再过几天催第二次", group: "催信和结案", kind: "number", min: 0 },
  { key: "结案天数", label: "再过几天还没回就结案", group: "催信和结案", kind: "number", min: 0 },
  { key: "自动催信起始日", label: "自动催信起始日", group: "催信和结案", kind: "date", hint: "只催这天及以后邀约的人；空着就不自动催" },
  { key: "不催级别", label: "不催的级别", group: "不催的人", kind: "list", hint: "用逗号隔开，例如 S, A" },
  { key: "不催的对方要求", label: "不催的对方要求", group: "不催的人", kind: "list" },
  { key: "跨项目冷却天数", label: "跨项目冷却天数", group: "跨项目冷却", kind: "number", min: 0, hint: "只在发邀约时检查；0 表示不查" },
  { key: "体验码默认次数", label: "体验码默认次数", group: "体验码和活动码", kind: "number", min: 1, max: 10 },
  { key: "体验码默认天数", label: "体验码默认天数", group: "体验码和活动码", kind: "number", min: 1, max: 60 },
  { key: "活动码粉丝折扣", label: "活动码默认折扣（%）", group: "体验码和活动码", kind: "number", min: 10, max: 20 },
  { key: "活动码市场", label: "资料市场到销售市场", group: "体验码和活动码", kind: "list", hint: "每项写成 资料市场=销售市场，逗号隔开，例如 台湾=TW" },
  { key: "体验未用提醒天数", label: "领了码几天没用提醒", group: "体验提醒", kind: "number", min: 1 },
  { key: "体验停滞提醒天数", label: "用过后几天没动静提醒", group: "体验提醒", kind: "number", min: 1 },
  { key: "体验到期提醒天数", label: "到期前几天提醒", group: "体验提醒", kind: "number", min: 0 },
  { key: "发布识别词", label: "发布识别词", group: "发布", kind: "list", hint: "帖子里出现这些词才算发布了，逗号隔开" },
  { key: "发布回看天数", label: "找帖子回看几天", group: "发布", kind: "number", min: 1 },
  { key: "找人国家", label: "找人国家", group: "找人", kind: "text" },
  { key: "找人语言", label: "找人语言", group: "找人", kind: "text" },
  { key: "时区", label: "时区", group: "其他", kind: "text", readOnly: true, hint: "要改请联系开发：当天额度、提醒日期、业务日都会跟着变" },
  { key: "说明", label: "说明", group: "其他", kind: "text" },
];

const list = (v: unknown) => String(v ?? "").split(/[,，、\n]+/).map((x) => x.trim()).filter(Boolean);

function shown(f: Field, v: unknown, tz: string): string {
  if (f.kind === "date") return v == null || v === "" ? "" : day(v, tz);
  if (f.kind === "list") return list(Array.isArray(v) ? v.map((x: any) => x?.name ?? x).join(",") : v).join(", ");
  if (f.kind === "number") return v == null || v === "" ? "" : String(Number(v));
  return text(v);
}

async function settingsRow(ctx: Ctx): Promise<Row> {
  const [row] = await ctx.base.records(ctx.cfg.tables.settings);
  if (!row) throw new Error("「设置」表是空的");
  return row;
}

/** Writes one line per change to 操作日志, so 修改记录 can show who changed what from what. */
async function logChanges(ctx: Ctx, lines: string[]): Promise<void> {
  if (!lines.length) return;
  const now = stamp(Date.now(), ctx.cfg.timezone);
  await ctx.base.create(ctx.cfg.tables.oplog, lines.map((l) => ({
    类型: ["飞书变更"], 结果: ["完成"], 操作: `[设置] ${l}`.slice(0, 500), 说明: `执行人：${ctx.me.name || ctx.me.id}`, 时间: now,
  })));
}

export async function changeHistory(ctx: Ctx, about: string) {
  const rows = await ctx.base.records(ctx.cfg.tables.oplog, { fields: ["操作", "说明", "时间"] });
  return rows.filter((r) => text(r["操作"]).startsWith(`[设置] ${about}`))
    .sort((a, b) => (cellTime(b["时间"], ctx.cfg.timezone) ?? 0) - (cellTime(a["时间"], ctx.cfg.timezone) ?? 0)).slice(0, 20)
    .map((r) => ({ when: stamp(cellTime(r["时间"], ctx.cfg.timezone) ?? 0, ctx.cfg.timezone), what: text(r["操作"]).slice(5), who: (text(r["说明"]).match(/执行人：(.+)/) ?? [])[1] ?? "" }));
}

// --- 发信规则 ---

export async function readRules(ctx: Ctx) {
  const row = await settingsRow(ctx);
  return {
    fields: SETTING_FIELDS.map((f) => ({ ...f, value: shown(f, row[f.key], ctx.cfg.timezone),
      default: (SETTING_DEFAULTS as Record<string, unknown>)[f.key] != null ? String((SETTING_DEFAULTS as Record<string, unknown>)[f.key]) : "" })),
  };
}

export async function saveRules(ctx: Ctx, values: Record<string, string>): Promise<number> {
  const row = await settingsRow(ctx);
  const out: Record<string, unknown> = {};
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(values ?? {})) {
    const f = SETTING_FIELDS.find((x) => x.key === key);
    if (!f) throw new Error(`「${key}」不能在这里改`);
    if (f.readOnly) throw new Error(`「${f.label}」不能在这里改`);
    const v = String(raw ?? "").trim();
    const was = shown(f, row[key], ctx.cfg.timezone);
    if (v === was) continue;
    if (f.kind === "number") {
      if (v === "") { out[key] = null; }
      else {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`「${f.label}」要填数字`);
        if (f.min != null && n < f.min) throw new Error(`「${f.label}」不能小于 ${f.min}`);
        if (f.max != null && n > f.max) throw new Error(`「${f.label}」不能大于 ${f.max}`);
        out[key] = n;
      }
    } else if (f.kind === "date") {
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`「${f.label}」的日期格式不对`);
      out[key] = v ? `${v} 00:00` : null;
    } else if (f.kind === "list") {
      if (key === "活动码市场" && list(v).some((p) => !/^[^=＝]+[=＝][^=＝]+$/.test(p))) throw new Error("「资料市场到销售市场」每项要写成 资料市场=销售市场");
      out[key] = list(v).join(", ");
    } else out[key] = v;
    lines.push(`${f.label}：${was || "空"} → ${v || "空"}`);
  }
  if (!lines.length) return 0;
  await ctx.base.update(ctx.cfg.tables.settings, { [row.record_id]: out });
  await logChanges(ctx, lines);
  return lines.length;
}

// --- 发信邮箱 ---

const MAILBOX_EDITS = ["渠道名", "每日上限", "退信率暂停线", "启用日期", "起步上限", "每天增加", "说明", "不自动催"] as const;

export async function readMailboxes(ctx: Ctx) {
  const [rows, stats, s] = await Promise.all([ctx.base.records(ctx.cfg.tables.mailboxes), bounceStats(ctx.base, ctx.cfg), settingsRow(ctx)]);
  const skip = list(s["不催渠道"]);
  const tz = ctx.cfg.timezone;
  return rows.filter((m) => text(m["邮箱"])).map((m) => {
    const address = text(m["邮箱"]).toLowerCase();
    const channel = text(m["渠道名"]) || address;
    const w = warmupLimit(m, tz);
    const st = stats.get(channel) ?? { sent: 0, bounced: 0 };
    return {
      id: m.record_id, address, channel, enabled: m["启用"] === true, daily: Number(m["每日上限"]) || 0, today: w.limit, warmup: w.note ?? "",
      bouncePause: m["退信率暂停线"] == null || m["退信率暂停线"] === "" ? "" : String(m["退信率暂停线"]),
      start: day(m["启用日期"], tz), startCap: m["起步上限"] ? String(m["起步上限"]) : "", perDay: m["每天增加"] ? String(m["每天增加"]) : "",
      note: text(m["说明"]), noRemind: skip.includes(channel), sent: st.sent, bounced: st.bounced,
    };
  });
}

/** Whether anything names this channel: mail history, a followup's 联系渠道, or an item still to go out. */
async function channelInUse(ctx: Ctx, channel: string, address = ""): Promise<boolean> {
  // The sender finds a mailbox by its 渠道名 or its address, in any capitals (mailboxFor), so references are read
  // whole and compared without case: an exact-match filter would miss 「BRAND」 for 「Brand」.
  const names = new Set([channel, address].map((x) => x.trim().toLowerCase()).filter(Boolean));
  const t = ctx.cfg.tables;
  const used = (rows: Row[], field: string) => rows.some((r) => names.has(option(r[field]).toLowerCase()));
  const [cs, fs, rs] = await Promise.all([
    ctx.base.records(t.contacts, { fields: ["渠道"] }),
    ctx.base.records(t.followups, { fields: ["联系渠道"] }),
    ctx.base.records(t.reviews, { fields: ["发送渠道"] }),
  ]);
  return used(cs, "渠道") || used(fs, "联系渠道") || used(rs, "发送渠道");
}

/** Whether mail has gone to or come from this mailbox: then its address can't change (U-5). */
async function hasHistory(ctx: Ctx, channel: string): Promise<boolean> {
  const n = channel.trim().toLowerCase();
  const rows = await ctx.base.records(ctx.cfg.tables.contacts, { fields: ["渠道"] });
  return rows.some((r) => option(r["渠道"]).toLowerCase() === n);
}

export async function saveMailbox(ctx: Ctx, id: string, input: Record<string, unknown>): Promise<string> {
  const t = ctx.cfg.tables;
  const rows = await ctx.base.records(t.mailboxes);
  const now = id ? rows.find((r) => r.record_id === id) : undefined;
  if (id && !now) throw new Error("发信邮箱表里已经没有这个邮箱");
  const out: Record<string, unknown> = {};
  const lines: string[] = [];
  const address = String(input["邮箱"] ?? "").trim().toLowerCase();
  if (!now) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error("邮箱格式不对");
    if (rows.some((r) => text(r["邮箱"]).toLowerCase() === address)) throw new Error(`${address} 已经在发信邮箱里了`);
    out["邮箱"] = address;
    out["启用"] = input["启用"] !== false;
  } else if (address && address !== text(now["邮箱"]).toLowerCase()) {
    // The address is who the mail comes from: anything approved or in progress under this mailbox was approved
    // with this sender, so a used mailbox never changes address.
    if (await channelInUse(ctx, text(now["渠道名"]) || text(now["邮箱"]).toLowerCase(), text(now["邮箱"]))) throw new Error("这个邮箱已经有往来记录、跟进或待发的信，不能改地址：停用后加一个新的，旧的记录保留");
    out["邮箱"] = address;
  }
  for (const k of MAILBOX_EDITS) {
    if (!(k in input) || k === "不自动催") continue;
    const v = String(input[k] ?? "").trim();
    if (["每日上限", "起步上限", "每天增加", "退信率暂停线"].includes(k)) {
      if (v === "") { out[k] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`「${k}」要填不小于 0 的数字`);
      if (k === "每日上限" && n <= 0) throw new Error("每天上限要大于 0");
      if (k === "退信率暂停线" && n > 100) throw new Error("退信率暂停线在 0 到 100 之间");
      out[k] = n;
    } else if (k === "启用日期") {
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error("启用日期格式不对");
      out[k] = v ? `${v} 00:00` : null;
    } else out[k] = v;
  }
  if (!now && !out["每日上限"]) throw new Error("要填每天上限");
  const channel = String(out["渠道名"] ?? text(now?.["渠道名"]) ?? "").trim() || address || text(now?.["邮箱"]).toLowerCase();
  // Items and followups name their mailbox by 渠道名, so one name must mean one mailbox (another's 渠道名 or
  // address would send approved mail from the wrong one), and a name already in use can't change under them.
  const others = rows.filter((r) => r.record_id !== id);
  const taken = new Set(others.flatMap((r) => [text(r["渠道名"]).toLowerCase(), text(r["邮箱"]).toLowerCase()]).filter(Boolean));
  if (taken.has(channel.toLowerCase())) throw new Error(`渠道名「${channel}」已经是另一个发信邮箱的名字或地址，换一个`);
  const finalAddress = String(out["邮箱"] ?? text(now?.["邮箱"])).toLowerCase();
  if (taken.has(finalAddress)) throw new Error(`${finalAddress} 已经是另一个发信邮箱的名字或地址`);
  const wasChannel = now ? text(now["渠道名"]) || text(now["邮箱"]).toLowerCase() : "";
  if (now && "渠道名" in out && channel !== wasChannel && (await channelInUse(ctx, wasChannel, text(now["邮箱"])))) {
    throw new Error(`渠道名「${wasChannel}」已经用在往来记录、跟进或待发的信上，不能改：停用后加一个新的`);
  }
  if (!now && !out["渠道名"]) out["渠道名"] = channel;
  let rowId = id;
  if (now) {
    for (const [k, v] of Object.entries(out)) {
      const was = k === "启用日期" ? day(now[k], ctx.cfg.timezone) : text(now[k] ?? "");
      const to = k === "启用日期" ? String(v ?? "").slice(0, 10) : String(v ?? "");
      if (was !== to) lines.push(`发信邮箱 ${text(now["邮箱"])} ${k}：${was || "空"} → ${to || "空"}`);
    }
    if (Object.keys(out).length) await ctx.base.update(t.mailboxes, { [id]: out });
  } else {
    [rowId] = await ctx.base.create(t.mailboxes, [out]);
    lines.push(`发信邮箱 加了 ${address}（每天上限 ${out["每日上限"]}）`);
  }
  if ("不自动催" in input) {
    const s = await settingsRow(ctx);
    const skip = list(s["不催渠道"]);
    const want = input["不自动催"] === true;
    if (want !== skip.includes(channel)) {
      const next = want ? [...skip, channel] : skip.filter((c) => c !== channel);
      await ctx.base.update(t.settings, { [s.record_id]: { 不催渠道: next.join(", ") } });
      lines.push(`发信邮箱 ${channel} 自动催：${want ? "会催 → 不催" : "不催 → 会催"}`);
    }
  }
  await logChanges(ctx, lines);
  return rowId;
}

/** Approved or waiting mail that would go out from this mailbox: disabling it first needs each one handled (U-5). */
export async function mailboxPending(ctx: Ctx, data: ConsoleData, id: string) {
  const [m] = await ctx.base.get(ctx.cfg.tables.mailboxes, [id]);
  if (!m) throw new Error("发信邮箱表里已经没有这个邮箱");
  const channel = text(m["渠道名"]) || text(m["邮箱"]).toLowerCase();
  const names = new Set([channel, text(m["邮箱"])].map((x) => x.toLowerCase()).filter(Boolean));
  const mine = (v: unknown) => names.has(option(v).toLowerCase());
  const open = await ctx.base.records(ctx.cfg.tables.reviews, { filter: { logic: "and", conditions: [["状态", "intersects", ["待你审核", "待执行", "执行失败"]]] } });
  const s = data.snapshot;
  // Only items that send mail (I-1's own test), from this mailbox or, with none named, from the one she knows.
  return open.filter((r) => SENDING_TYPES.includes(option(r["类型"])) && option(r["发送渠道"]) !== "不发邮件")
    .filter((r) => mine(r["发送渠道"]) || (!option(r["发送渠道"]) && mine(s.followups.get(linkIds(r["KOL"])[0] ?? "")?.["联系渠道"])))
    .map((r) => {
      const f = s.followups.get(linkIds(r["KOL"])[0] ?? "");
      const why = text(r["执行结果"]);
      // Being sent, or possibly gone out already (I-5): not something to move or withdraw from here.
      const u = uncertain(r, ctx.journal.get(`review:${r.record_id}`)?.state);
      const stuck = !u ? "" : u === "正在执行" ? "正在执行，等它结束再停用" : u === "已经发出" ? "这台电脑记着已经发出，先在「出了问题」里核对" : "结果不明，先在「出了问题」里核对";
      return { id: r.record_id, title: text(r["审核项"]), who: f ? text(f["账号名称"]) : "", to: emailsIn(r["收件人"])[0] ?? "", stuck,
        state: stuck ? stuck : reviewState(r) === "approved" ? "已同意，还没发" : option(r["状态"]) === "执行失败" ? "没发成" : "待你决定" };
    });
}

/** Unanswered mail from her dated at or after this time: an approval given before it never saw it (I-4). */
async function wroteSince(ctx: Ctx, fid: string, since: number | null): Promise<boolean> {
  if (!fid || since == null) return false;
  const rows = await ctx.base.records(ctx.cfg.tables.contacts, { filter: { logic: "and", conditions: [["待处理", "==", true], ["方向", "intersects", ["收到"]]] }, fields: ["KOL", "日期", "摘要"] });
  return rows.some((c) => linkIds(c["KOL"]).includes(fid) && !text(c["摘要"]).startsWith("[退信]") && (cellTime(c["日期"], ctx.cfg.timezone) ?? 0) >= since);
}

/**
 * 停用: every mail still meant to go out from this mailbox is moved to another mailbox or withdrawn first, so
 * nothing is left waiting on a mailbox that will never send. Moving keeps an approval only while it still holds:
 * the content is what was approved and she hasn't written since; then just the sender changes, approver and time
 * kept. Otherwise the item goes back for a full review with the new mailbox. Anything being sent or with an
 * unknown result blocks the switch-off until it is dealt with.
 */
export async function disableMailbox(ctx: Ctx, data: ConsoleData, id: string, plan: Record<string, { action: "move" | "drop"; to?: string }>, on = false): Promise<void> {
  const t = ctx.cfg.tables;
  const [m] = await ctx.base.get(t.mailboxes, [id]);
  if (!m) throw new Error("发信邮箱表里已经没有这个邮箱");
  if (on) {
    await ctx.base.update(t.mailboxes, { [id]: { 启用: true } });
    return logChanges(ctx, [`发信邮箱 ${text(m["邮箱"])} 启用：停用 → 启用`]);
  }
  const pending = await mailboxPending(ctx, data, id);
  const stuck = pending.filter((p) => p.stuck);
  if (stuck.length) throw new Error(`有 ${stuck.length} 封信现在不能换邮箱或撤掉：${stuck.map((p) => `${p.who || p.title}（${p.stuck}）`).join("、")}`);
  const missing = pending.filter((p) => !plan?.[p.id]);
  if (missing.length) throw new Error(`还有 ${missing.length} 封信要从这个邮箱发，先逐件选换邮箱或撤掉：${missing.map((p) => p.who || p.title).join("、")}`);
  const others = (await ctx.base.records(t.mailboxes)).filter((r) => r.record_id !== id && r["启用"] === true);
  const lines: string[] = [];
  for (const p of pending) {
    // Read again: it may have started executing since the list was shown.
    const [r] = await ctx.base.get(t.reviews, [p.id]);
    if (!r || !["待你审核", "待执行", "执行失败"].includes(option(r["状态"]))) throw new Error(`「${p.title}」刚有了变化，重新打开停用清单再看`);
    const u = uncertain(r, ctx.journal.get(`review:${p.id}`)?.state);
    if (u) throw new Error(`「${p.title}」${u}，先在「出了问题」里核对，再停用`);
    const step = plan[p.id];
    if (step.action === "drop") {
      await ctx.base.update(t.reviews, { [p.id]: { 状态: ["已撤回"], 处理: ["不发"], 同意来源: "", 内容指纹: "",
        执行结果: `${stamp(Date.now(), ctx.cfg.timezone)} 停用发信邮箱 ${text(m["邮箱"])} 时撤回（${ctx.me.name}在决策台操作）` } });
      lines.push(`停用 ${text(m["邮箱"])}：撤掉「${p.title}」`);
      continue;
    }
    const to = others.find((x) => text(x["邮箱"]).toLowerCase() === String(step.to ?? "").toLowerCase());
    if (!to) throw new Error(`「${step.to ?? ""}」不是启用的发信邮箱`);
    const channel = text(to["渠道名"]) || text(to["邮箱"]).toLowerCase();
    const approved = reviewState(r) === "approved";
    const holds = approved && !approvalProblem(ctx.cfg, r)
      && !(await wroteSince(ctx, linkIds(r["KOL"])[0] ?? "", cellTime(r["同意时间"], ctx.cfg.timezone) ?? cellTime(r["提出时间"], ctx.cfg.timezone)));
    if (holds) {
      const moved = { ...r, 发送渠道: [channel] };
      await ctx.base.update(t.reviews, { [p.id]: { 发送渠道: [channel], ...(text(r["内容指纹"]) ? { 内容指纹: fingerprint(moved) } : {}) } });
    } else {
      await ctx.base.update(t.reviews, { [p.id]: { 发送渠道: [channel] } });
      if (approved) await sendBack(ctx, p.id, `停用发信邮箱 ${text(m["邮箱"])} 时改从 ${channel} 发；同意之后内容改过或她又来信了，请重新看一遍`);
    }
    lines.push(`停用 ${text(m["邮箱"])}：「${p.title}」改从 ${channel} 发${approved && !holds ? "，退回重新审核" : ""}`);
  }
  await ctx.base.update(t.mailboxes, { [id]: { 启用: false } });
  lines.push(`发信邮箱 ${text(m["邮箱"])} 启用：启用 → 停用`);
  await logChanges(ctx, lines);
}

/** 检查连接: this computer's Feishu login can read the mailbox (sending uses the same access). */
export async function checkMailbox(ctx: Ctx, address: string): Promise<{ ok: boolean; note: string }> {
  const a = address.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) return { ok: false, note: "邮箱格式不对" };
  try {
    await ctx.mail.list(a, { folder: "INBOX" }, 1);
    return { ok: true, note: `这台电脑登录的飞书账号能读 ${a} 的收件箱（能不能发信，要等第一封信发出才确认）` };
  } catch (err: any) {
    const why = String(err?.message ?? err);
    return { ok: false, note: /mailbox|邮箱|permission|权限|not found|identity/i.test(why)
      ? `这台电脑登录的飞书账号读不了 ${a}：这个邮箱可能还没开通，或者这个账号没有它的权限。开通或授权后再检查一次`
      : `读不了 ${a}：${why.slice(0, 160)}` };
  }
}

// --- 模板 ---

/** Placeholders each kind of template may use; anything else can't be filled and blocks submitting. */
const BASE_HOLDERS = ["稱呼", "称呼", "账号名称"];
const TRIAL_HOLDERS = [...BASE_HOLDERS, "體驗碼", "体验码", "已用", "剩餘", "剩余", "次數", "次数", "到期日", "已於 / 將於", "M 月 D 日"];
/** What partnerValues fills (partner.ts), without the braces. */
const PARTNER_HOLDERS = Object.keys(partnerValues("x", "x", "x", 15)).map((k) => k.slice(1, -1));
export function placeholdersFor(purpose: string): string[] {
  if (purpose === "发布确认") return [...BASE_HOLDERS, "約定日期", "约定日期", "活動碼", "活动码"];
  if (purpose === "发活动码") return [...BASE_HOLDERS, ...PARTNER_HOLDERS];
  if (/体验|发体验码/.test(purpose)) return TRIAL_HOLDERS;
  return BASE_HOLDERS;
}

/** What stops while a template of this purpose has a draft (Q-11 current rule). */
export function draftStops(purpose: string): string {
  if (purpose === "邀约") return "用它的邀约批次发不了";
  if (purpose === "催信 1") return "第一次催信不发（结案照常）";
  if (purpose === "催信 2") return "第二次催信不发（结案照常）";
  if (purpose === "体验到期") return "体验快到期的提醒不提";
  if (purpose === "体验未用") return "领了码没用的提醒不提";
  if (purpose === "体验跟进") return "体验停滞的提醒不提";
  if (purpose === "发布确认") return "没按时发布的卡片改用插件自带的写法";
  return "用它的信先不用这个模板";
}

const BACKUP = "【编辑前在用版本】";
const BACKUP_END = "【在用版本完】";
/** The text in use before an edit, kept in 备注 between two markers so notes added around it don't break it. */
function backupOf(r: Row): { subject: string; body: string } | null {
  const note = text(r["备注"]);
  const at = note.indexOf(BACKUP);
  if (at < 0) return null;
  const end = note.indexOf(BACKUP_END, at);
  try {
    const b = JSON.parse(note.slice(at + BACKUP.length, end < 0 ? undefined : end));
    if (typeof b?.subject === "string" && typeof b?.body === "string") return b;
  } catch {}
  throw new Error(`模板「${text(r["名称"])}」备注里存的编辑前版本读不出来（可能被改动过），先在飞书里检查备注`);
}
function withoutBackup(r: Row): string {
  const note = text(r["备注"]);
  const at = note.indexOf(BACKUP);
  if (at < 0) return note.trim();
  const end = note.indexOf(BACKUP_END, at);
  return `${note.slice(0, at)}${end < 0 ? "" : note.slice(end + BACKUP_END.length)}`.trim();
}

export async function readTemplates(ctx: Ctx) {
  const rows = await ctx.base.records(ctx.cfg.tables.templates);
  return {
    purposes: [...TEMPLATE_PURPOSES],
    holders: Object.fromEntries(TEMPLATE_PURPOSES.map((p) => [p, placeholdersFor(p)])),
    stops: Object.fromEntries(TEMPLATE_PURPOSES.map((p) => [p, draftStops(p)])),
    list: rows.map((r) => {
      const purpose = option(r["用途"]);
      let b: { subject: string; body: string } | null = null;
      let broken = "";
      try { b = backupOf(r); } catch (err: any) { broken = String(err?.message ?? err); }
      return { broken,
        id: r.record_id, name: text(r["名称"]), purpose, language: text(r["语言"]), direction: text(r["方向"]), state: option(r["状态"]),
        subject: text(r["主旨"]), body: text(r["正文"]), note: withoutBackup(r), active: b, holders: placeholdersFor(purpose),
        stops: ["草稿", "待审核"].includes(option(r["状态"])) ? draftStops(purpose) : "",
        updated: r["更新时间"] ? stamp(cellTime(r["更新时间"], ctx.cfg.timezone) ?? 0, ctx.cfg.timezone) : "",
      };
    }),
  };
}

function unknownHolders(purpose: string, ...parts: string[]): string[] {
  const ok = new Set(placeholdersFor(purpose));
  return [...new Set(parts.join("\n").match(/\{([^{}\n]+)\}/g) ?? [])].filter((h) => !ok.has(h.slice(1, -1).trim()));
}

/**
 * 存草稿: the template's text changes and it is 草稿 until approved. An approved template keeps its text in 备注
 * first, so 放弃草稿 can put it back. A new template starts as a draft.
 */
export async function saveTemplate(ctx: Ctx, id: string, input: Record<string, string>): Promise<string> {
  const t = ctx.cfg.tables;
  const subject = String(input.subject ?? "").trim(), body = String(input.body ?? "").replace(/\r\n/g, "\n").trim();
  if (!id) {
    const name = String(input.name ?? "").trim(), purpose = String(input.purpose ?? "");
    if (!name) throw new Error("要写模板名称");
    if (!TEMPLATE_PURPOSES.includes(purpose as any)) throw new Error("要选模板用途");
    const [nid] = await ctx.base.create(t.templates, [{ 名称: name, 用途: [purpose], 语言: String(input.language ?? "").trim(), 方向: String(input.direction ?? "").trim(), 主旨: subject, 正文: body, 状态: ["草稿"] }]);
    await logChanges(ctx, [`模板 新建「${name}」（${purpose}）`]);
    return nid;
  }
  const [r] = await ctx.base.get(t.templates, [id]);
  if (!r) throw new Error("模板表里已经没有这个模板");
  if (subject === text(r["主旨"]) && body === text(r["正文"])) return id;
  const state = option(r["状态"]);
  const keep = state === "已批准" && !backupOf(r)
    ? `${withoutBackup(r)}${withoutBackup(r) ? "\n" : ""}${BACKUP}${JSON.stringify({ subject: text(r["主旨"]), body: text(r["正文"]) })}${BACKUP_END}` : text(r["备注"]);
  await ctx.base.update(t.templates, { [id]: { 主旨: subject, 正文: body, 状态: ["草稿"], 备注: keep } });
  await logChanges(ctx, [`模板「${text(r["名称"])}」存了草稿${input.why ? `：${String(input.why).trim()}` : ""}${state === "已批准" ? `（在用版本暂停：${draftStops(option(r["用途"]))}）` : ""}`]);
  return id;
}

/** 提交审核: the draft goes to 待你决定 as a template card (C-09); approving it there puts it to use. */
export async function submitTemplate(ctx: Ctx, id: string): Promise<void> {
  const [r] = await ctx.base.get(ctx.cfg.tables.templates, [id]);
  if (!r) throw new Error("模板表里已经没有这个模板");
  if (option(r["状态"]) !== "草稿") throw new Error(`这个模板现在是「${option(r["状态"])}」，只有草稿能提交`);
  if (!text(r["正文"])) throw new Error("正文是空的");
  const bad = unknownHolders(option(r["用途"]), text(r["主旨"]), text(r["正文"]));
  if (bad.length) throw new Error(`${bad.join("、")} 系统不认识，发信时会填不上。改掉或删掉才能提交`);
  await ctx.base.update(ctx.cfg.tables.templates, { [id]: { 状态: ["待审核"] } });
  await logChanges(ctx, [`模板「${text(r["名称"])}」提交审核`]);
}

/** 放弃草稿: back to the version in use before the edit, or 停用 for a template that never had one. */
export async function discardTemplate(ctx: Ctx, id: string): Promise<void> {
  const [r] = await ctx.base.get(ctx.cfg.tables.templates, [id]);
  if (!r) throw new Error("模板表里已经没有这个模板");
  if (!["草稿", "待审核"].includes(option(r["状态"]))) throw new Error("这个模板没有草稿");
  const b = backupOf(r);
  await ctx.base.update(ctx.cfg.tables.templates, { [id]: b ? { 主旨: b.subject, 正文: b.body, 状态: ["已批准"], 备注: withoutBackup(r) } : { 状态: ["停用"] } });
  await logChanges(ctx, [`模板「${text(r["名称"])}」放弃草稿，${b ? "恢复用编辑前的版本" : "没有在用版本，停用"}`]);
}

/**
 * What approving a template writes: 已批准 and the note without the kept old text, in one write. The kept text is
 * read first, so a mangled one stops the approval instead of leaving it half done.
 */
export function approvalFields(r: Row, at: string): Record<string, unknown> {
  const kept = backupOf(r);
  return { 状态: ["已批准"], 审核时间: at, ...(kept ? { 备注: withoutBackup(r) } : {}) };
}

/** A short hash of a template's text, so a card approves exactly the version it showed. */
export function templateVersion(r: Row): string {
  return createHash("sha256").update(`${text(r["主旨"])}\n${text(r["正文"])}`).digest("hex").slice(0, 12);
}

// --- 选项 ---

const OPTION_FIELDS: Record<string, { table: "profiles" | "followups"; field: string }> = {
  入库批次: { table: "profiles", field: "入库批次" },
  邀约批次: { table: "followups", field: "邀约批次" },
  内容类型: { table: "profiles", field: "内容类型" },
};

export async function readOptions(ctx: Ctx, data: ConsoleData) {
  const s = data.snapshot;
  const count = (rows: Iterable<Row>, field: string) => {
    const n = new Map<string, number>();
    for (const r of rows) {
      const v = r[field];
      for (const o of Array.isArray(v) ? v.map((x: any) => String(x?.name ?? x)) : option(v) ? [option(v)] : []) n.set(o, (n.get(o) ?? 0) + 1);
    }
    return n;
  };
  const out: Record<string, { name: string; n: number }[]> = {};
  for (const [label, o] of Object.entries(OPTION_FIELDS)) {
    const opts = (await ctx.base.fieldOptions(ctx.cfg.tables[o.table], o.field)) ?? [];
    const n = count(o.table === "profiles" ? s.profiles.values() : s.followups.values(), o.field);
    out[label] = [...new Set([...opts, ...n.keys()])].map((name) => ({ name, n: n.get(name) ?? 0 }));
  }
  return out;
}

async function setOptions(ctx: Ctx, table: string, field: string, options: string[], multiple: boolean): Promise<void> {
  // Feishu replaces a select's whole option list, so the existing options go first, unchanged.
  await ctx.base.lark.json(["base", "+field-update", "--base-token", ctx.base.token, "--table-id", table, "--field-id", field,
    "--json", JSON.stringify({ name: field, type: "select", multiple, options: options.map((name) => ({ name })) }), "--as", "user", "--yes"]);
}

/** 新增: a batch name as a new option; names are unique. */
export async function addOption(ctx: Ctx, which: string, name: string): Promise<void> {
  const o = OPTION_FIELDS[which];
  if (!o || which === "内容类型") throw new Error("这里只能加入库批次和邀约批次");
  const v = name.trim();
  if (!v || v.length > 40) throw new Error("名字要在 1 到 40 个字之间");
  const table = ctx.cfg.tables[o.table];
  const opts = (await ctx.base.fieldOptions(table, o.field)) ?? [];
  if (opts.includes(v)) throw new Error(`「${v}」已经有了`);
  await setOptions(ctx, table, o.field, [...opts, v], false);
  await logChanges(ctx, [`选项 ${which} 加了「${v}」`]);
}

/** 改名 or 合并 (renaming to a name that exists merges): every record using the old name is moved over. */
export async function renameOption(ctx: Ctx, _data: ConsoleData, which: string, from: string, to: string): Promise<number> {
  const o = OPTION_FIELDS[which];
  if (!o) throw new Error("没有这个选项");
  const a = from.trim(), b = to.trim();
  if (!a || !b || a === b) throw new Error("要写新的名字");
  const table = ctx.cfg.tables[o.table];
  const opts = (await ctx.base.fieldOptions(table, o.field)) ?? [];
  const multiple = which === "内容类型";
  if (!opts.includes(b)) await setOptions(ctx, table, o.field, [...opts, b], multiple);
  // Read the records now rather than from the page's copy, which may be minutes old (a record changed since must
  // not be overwritten, and one given the old name since must not be missed).
  const read = async () => (await ctx.base.records(table, { fields: [o.field], fresh: true }))
    .map((r) => ({ id: r.record_id, now: (Array.isArray(r[o.field]) ? r[o.field].map((x: any) => String(x?.name ?? x)) : option(r[o.field]) ? [option(r[o.field])] : []) as string[] }));
  // Each batch is read again right before it is written, so values set in the meantime are kept.
  const ids = (await read()).filter((r) => r.now.includes(a)).map((r) => r.id);
  let changed = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const rows = await ctx.base.get(table, ids.slice(i, i + 100), [o.field]);
    const changes: Record<string, Record<string, unknown>> = {};
    for (const r of rows) {
      const v = r[o.field];
      const now: string[] = Array.isArray(v) ? v.map((x: any) => String(x?.name ?? x)) : option(v) ? [option(v)] : [];
      if (!now.includes(a)) continue;
      const next = [...new Set(now.map((x) => (x === a ? b : x)))];
      changes[r.record_id] = { [o.field]: multiple ? next : [next[0]] };
    }
    if (Object.keys(changes).length) await ctx.base.update(table, changes);
    changed += Object.keys(changes).length;
  }
  const left = (await read()).filter((r) => r.now.includes(a)).length;
  // The option list is read again too, so an option added meanwhile isn't dropped.
  const latest = (await ctx.base.fieldOptions(table, o.field)) ?? opts;
  if (!left) await setOptions(ctx, table, o.field, [...new Set([...latest.filter((x) => x !== a), b])], multiple);
  await logChanges(ctx, [`选项 ${which}「${a}」${opts.includes(b) ? "合并到" : "改名为"}「${b}」，改了 ${changed} 条${left ? `；还有 ${left} 条刚用上旧名字，旧选项先留着` : ""}`]);
  return changed;
}

// --- 接入和执行电脑 ---

export async function readAccess(ctx: Ctx) {
  const p = listProjects().find((x) => x.name === ctx.cfg.project);
  const m = machine();
  return {
    executor: ctx.cfg.executor || "", thisMachine: machineLabel(m), isExecutor: !notExecutor(ctx.cfg, m),
    dataApi: ctx.cfg.dataApi, hasKey: Boolean(p?.dataApiKey), hasTrialKey: Boolean(p?.trialKey), hasPartnerKey: Boolean(p?.partnerKey),
    webhook: Boolean(ctx.cfg.webhook),
    database: p?.database ? p.database.replace(/^[a-z]+:\/\/[^@]*@/i, "").replace(/[/?].*$/, "") : "",
  };
}

export async function saveDataApi(ctx: Ctx, url: string): Promise<void> {
  const v = url.trim();
  if (v && !/^https:\/\/\S+$/.test(v)) throw new Error("业务数据接口要是 https:// 开头的地址");
  const row = await settingsRow(ctx);
  if (text(row["业务数据接口"]) === v) return;
  await ctx.base.update(ctx.cfg.tables.settings, { [row.record_id]: { 业务数据接口: v } });
  await logChanges(ctx, [`业务数据接口：${text(row["业务数据接口"]) || "空"} → ${v || "空"}`]);
}
