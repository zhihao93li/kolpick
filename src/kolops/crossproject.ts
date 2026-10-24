import { Base, cellTime, dayOf, linkIds } from "./base.js";
import type { Ctx } from "./ctx.js";
import { cachedRecords } from "./cache.js";
import { FOLLOWUP_FIELDS, PROFILE_FIELDS, profileEmails } from "./data.js";
import { listProjects } from "./projects.js";
import { TABLES } from "./schema.js";

/**
 * Addresses another project registered on this computer contacted within the cooldown, with a reason to
 * show. Projects keep separate bases, so this is the only place one project sees another's outreach.
 */
export async function contactedElsewhere(ctx: Ctx): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // 0 in 设置 turns the check off (an empty cell means the default).
  if (ctx.cfg.crossProjectCooldownDays <= 0) return out;
  const cutoff = Date.now() - ctx.cfg.crossProjectCooldownDays * 86_400_000;
  for (const p of listProjects()) {
    if (p.baseToken === ctx.cfg.baseToken) continue;
    const other = new Base(ctx.base.lark, p.baseToken);
    let profiles, followups;
    try {
      // Same fields as the snapshot, so this shares that project's local copy instead of reading it in full.
      [profiles, followups] = await Promise.all([
        cachedRecords(other, TABLES.profiles, PROFILE_FIELDS, ctx.cfg.timezone),
        cachedRecords(other, TABLES.followups, FOLLOWUP_FIELDS, ctx.cfg.timezone),
      ]);
    } catch (err: any) {
      throw new Error(`读不到项目「${p.name}」的飞书表，没法检查跨项目联系记录。`
        + `如果这个项目已经不用了，运行 kol project remove ${p.name}。原始错误：${err?.message ?? err}`);
    }
    const byId = new Map(profiles.map((r) => [r.record_id, r]));
    for (const f of followups) {
      const last = cellTime(f["最近联系日期"], ctx.cfg.timezone) ?? cellTime(f["首次邀约日期"], ctx.cfg.timezone);
      if (last != null && last < cutoff) continue;
      const when = last == null ? "联系过（没有日期）" : `${dayOf(last, ctx.cfg.timezone)} 联系过`;
      for (const e of profileEmails(byId.get(linkIds(f["档案"])[0] ?? ""))) {
        if (!out.has(e)) out.set(e, `项目「${p.name}」${when}，${ctx.cfg.crossProjectCooldownDays} 天内不重复联系`);
      }
    }
  }
  return out;
}
