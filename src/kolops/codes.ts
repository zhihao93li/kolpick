import { cellTime, option, text } from "./base.js";
import type { Ctx } from "./ctx.js";
import { displayName, loadSnapshot } from "./data.js";
import { stamp } from "./ops.js";
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
      if (typeof t.used === "number" && t.used !== f["体验码已用"]) change.体验码已用 = t.used;
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
  }
  report.更新 = Object.keys(changes).length;
  if (!o.dryRun && report.更新) {
    await ctx.base.update(cfg.tables.followups, changes);
    ctx.run.op({ type: "飞书变更", result: "完成", action: `同步体验码 ${report.更新} 条` });
  }
  return report;
}
