import { cellTime, option, text } from "./base.js";
import type { Ctx } from "./ctx.js";
import { displayName, loadSnapshot } from "./data.js";
import { stamp, today } from "./ops.js";
import { listProjects } from "./projects.js";

/** One code as the project's business data API reports it (docs/data-api.md). */
export interface CodeInfo {
  code: string;
  found: boolean;
  kind?: "trial" | "partner" | "other";
  active?: boolean;
  maxUses?: number | null;
  used?: number;
  expiresAt?: string | null;
  paidOrders?: number;
  refundedOrders?: number;
  visitors?: number;
}

const BATCH = 200;

/**
 * Asks the project's API about codes, 200 at a time, keyed "kind:code" in lower case: a trial and a partner
 * code may share a name, and each followup field wants its own kind. Never sends anything but the codes.
 */
export async function lookupCodes(url: string, key: string, codes: string[], fetchImpl: typeof fetch = fetch): Promise<Map<string, CodeInfo>> {
  const out = new Map<string, CodeInfo>();
  for (let i = 0; i < codes.length; i += BATCH) {
    const res = await fetchImpl(`${url.replace(/\/+$/, "")}/codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ codes: codes.slice(i, i + BATCH) }),
    });
    if (res.status === 401) throw new Error("业务数据接口拒绝了密钥（401）。请向项目负责人确认后用 kol project set-key 重新保存");
    if (!res.ok) throw new Error(`业务数据接口出错（${res.status}），这次先不同步`);
    const data: any = await res.json();
    for (const c of data?.codes ?? []) if (c.found) out.set(`${c.kind}:${String(c.code).toLowerCase()}`, c);
  }
  return out;
}

/** A trial-code write the API refused, with its reason (CODE_TAKEN, DAILY_LIMIT, …); nothing was changed. */
export class TrialCodeRefused extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/**
 * Runs one code write (create, extend, open a campaign) under I-5. The API answering no (4xx) is definite: nothing
 * changed. Anything else (a timeout, a dropped connection, a 5xx) may have gone through, so the write is noted as
 * unknown and is never tried again on its own; only someone who approves it again retries it. Creating a code or
 * a campaign may simply be approved again: the API hands back the one made the first time (data-api.md). An
 * extension is not like that, so the reviewer looks first.
 */
export async function writeOnce<T>(ctx: Ctx, key: string, what: string, call: () => Promise<T>, repeatable = false): Promise<T> {
  const check = repeatable
    ? "重新做不会建出第二个（项目后台会原样返回第一次建的），点「确认没做成，重新审核」再同意就行"
    : "请先到项目后台看到期日：已经延期了，就点「不做了，撤掉」，再写信告诉她新的到期日（到期日下次同步会更新到跟进上）；没延期，就点「确认没做成，重新审核」";
  if (ctx.journal.get(key)?.state === "unknown") throw new Error(`上次${what}结果不明，不会自动重做。${check}`);
  try {
    return await call();
  } catch (err: any) {
    if (err instanceof TrialCodeRefused) throw err;
    ctx.journal.mark(key, "unknown");
    throw new Error(`${what}结果不明（${err?.message ?? err}），不会自动重做。${check}`);
  }
}

async function writeTrial(url: string, key: string, path: string, body: object, fetchImpl: typeof fetch): Promise<{ created?: boolean; code: CodeInfo }> {
  const res = await fetchImpl(`${url.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401) throw new TrialCodeRefused("UNAUTHORIZED", "业务数据接口拒绝了体验码写密钥（401）。请向项目负责人确认后用 kol project set-trial-key 重新保存");
  if (res.status === 503) throw new TrialCodeRefused("NOT_CONFIGURED", "项目后台还没有开通建体验码（503）");
  // A server error may come after the write went through: not a refusal (I-5).
  if (res.status >= 500) throw new Error(`业务数据接口出错（${res.status}）`);
  if (!res.ok) throw new TrialCodeRefused(String(data.error ?? res.status), String(data.message ?? `业务数据接口出错（${res.status}）`));
  return data;
}

/** Creates a trial code; asking again for the same followup returns the code made the first time. */
export function createTrialCodeRemote(url: string, key: string, body: { code: string; maxUses: number; days: number; kolName: string; followupId: string; operator: string }, fetchImpl: typeof fetch = fetch) {
  return writeTrial(url, key, "/trial-codes", body, fetchImpl);
}

/** Extends a trial code by `days` from the later of now and its current expiry. Not idempotent: never retried blindly. */
export function extendTrialCodeRemote(url: string, key: string, code: string, body: { days: number; operator: string }, fetchImpl: typeof fetch = fetch) {
  return writeTrial(url, key, `/trial-codes/${encodeURIComponent(code)}/extend`, body, fetchImpl);
}

/**
 * `kol trial-check --code X`: whether a trial code may take this name. Trial and other platform codes share one
 * namespace (case-insensitive); a partner code with the same name doesn't block it.
 */
export async function checkTrialName(ctx: Ctx, code: string, fetchImpl: typeof fetch = fetch) {
  const key = listProjects().find((p) => p.name === ctx.cfg.project)?.dataApiKey;
  if (!ctx.cfg.dataApi || !key) throw new Error("没有业务数据接口或接口密钥，查不了码名");
  const info = await lookupCodes(ctx.cfg.dataApi, key, [code], fetchImpl);
  const taken = info.get(`trial:${code.toLowerCase()}`) ?? info.get(`other:${code.toLowerCase()}`);
  return taken
    ? { 码名: code, 可用: false, 原因: `已经有这个码（${taken.kind === "trial" ? "体验码" : "平台券码"}，用了 ${taken.used ?? 0} 次）`, 现状: taken }
    : { 码名: code, 可用: true };
}

/**
 * `kol codes`: refreshes 体验码已用 / 体验码上限 / 体验码到期 on open followups from the project's API, and lists
 * who used part of a trial, whose trial runs out soon, and how each 活动码 is doing.
 */
export async function syncCodes(ctx: Ctx, o: { dryRun: boolean; fetchImpl?: typeof fetch }) {
  const cfg = ctx.cfg;
  if (!cfg.dataApi) throw new Error("「设置」里没填业务数据接口，这个项目没法同步体验码和活动码");
  const key = listProjects().find((p) => p.name === cfg.project)?.dataApiKey;
  if (!key) throw new Error(`这台电脑没有项目「${cfg.project}」的接口密钥。请向项目负责人要，然后运行 kol project set-key ${cfg.project} <密钥>`);

  const s = await loadSnapshot(ctx.base, cfg);
  const rows = [...s.followups.values()];
  const open = rows.filter((f) => option(f["阶段"]) !== "结案" && (text(f["体验码"]) || text(f["活动码"])));
  const codes = [...new Set(open.flatMap((f) => [text(f["体验码"]), text(f["活动码"])]).filter(Boolean))];
  const info = await lookupCodes(cfg.dataApi, key, codes, o.fetchImpl);

  const soon = Date.now() + 3 * 86_400_000;
  const report = {
    查了: codes.length, 更新: 0, 找不到的码: [] as string[],
    体验码用了一部分: [] as { name: string; 体验码: string; 已用: number; 上限: number }[],
    体验码三天内到期: [] as { name: string; 体验码: string; 到期: string; 已用: number }[],
    活动码: [] as { name: string; 活动码: string; 付款订单: number; 退款订单: number; 访客: number }[],
    后台已停用: [] as string[],
    试跑: o.dryRun || undefined,
  };
  const changes: Record<string, Record<string, unknown>> = {};
  for (const f of open) {
    const name = s.followups.has(f.record_id) ? displayName(s, s.followups.get(f.record_id)!) : text(f["账号名称"]);
    const trial = text(f["体验码"]);
    const t = trial ? info.get(`trial:${trial.toLowerCase()}`) : undefined;
    if (trial && !t?.found) report.找不到的码.push(`${name}：${trial}`);
    if (t?.found) {
      const change: Record<string, unknown> = {};
      if (typeof t.used === "number" && t.used !== f["体验码已用"]) {
        change.体验码已用 = t.used;
        // Uses only go up; the day they did is when the KOL last tried something, which 体验跟进 waits on.
        if (t.used > (Number(f["体验码已用"]) || 0)) change.体验码最近使用 = stamp(Date.now(), cfg.timezone);
      }
      if (t.maxUses != null && t.maxUses !== f["体验码上限"]) change.体验码上限 = t.maxUses;
      const expires = t.expiresAt ? Date.parse(t.expiresAt) : null;
      if (expires != null && !Number.isNaN(expires) && cellTime(f["体验码到期"], cfg.timezone) !== expires) {
        change.体验码到期 = stamp(expires, cfg.timezone);
      }
      if (Object.keys(change).length) changes[f.record_id] = change;
      const used = t.used ?? 0;
      if (t.maxUses && used > 0 && used < t.maxUses) report.体验码用了一部分.push({ name, 体验码: trial, 已用: used, 上限: t.maxUses });
      if (expires != null && expires >= Date.now() && expires <= soon && (!t.maxUses || used < t.maxUses)) {
        report.体验码三天内到期.push({ name, 体验码: trial, 到期: stamp(expires, cfg.timezone).slice(0, 10), 已用: used });
      }
    }
    const partner = text(f["活动码"]);
    const p = partner ? info.get(`partner:${partner.toLowerCase()}`) : undefined;
    if (partner && !p?.found) report.找不到的码.push(`${name}：${partner}`);
    if (p?.found) {
      report.活动码.push({ name, 活动码: partner, 付款订单: p.paidOrders ?? 0, 退款订单: p.refundedOrders ?? 0, 访客: p.visitors ?? 0 });
    }
    // A code switched off in the back office is noted on the followup once, when it is first seen off (E-43).
    for (const [label, c, got] of [["体验码", trial, t], ["活动码", partner, p]] as const) {
      if (!c || got?.found !== true || got.active !== false) continue;
      const note = `${label} ${c} 在项目后台已停用`;
      if (text(f["下一步"]).includes(note)) continue;
      changes[f.record_id] = { ...changes[f.record_id], 下一步: `${today(cfg)} ${note}` };
      report.后台已停用.push(`${name}：${note}`);
    }
  }
  report.更新 = Object.keys(changes).length;
  if (!o.dryRun && report.更新) {
    await ctx.base.update(cfg.tables.followups, changes);
    ctx.run.op({ type: "飞书变更", result: "完成", action: `同步体验码 ${report.更新} 条` });
  }
  return report;
}
