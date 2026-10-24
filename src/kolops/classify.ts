import { readFileSync } from "node:fs";
import { option, options, text } from "./base.js";
import type { Ctx } from "./ctx.js";

/** What Claude fills in for a newly found KOL. Select fields must use one of the base's option names. */
export const CLASSIFY_SELECTS = ["合作邀约方向", "市场", "語言", "内容类型"] as const;
const CLASSIFY_FIELDS = [...CLASSIFY_SELECTS, "称呼"] as const;
type ClassifyField = (typeof CLASSIFY_FIELDS)[number];

const BIO_MARK = "简介：";

/** The bio `kol find` keeps at the end of 备注, if any. */
export function bioOf(note: unknown): string {
  const s = text(note);
  const i = s.lastIndexOf(BIO_MARK);
  return i < 0 ? "" : s.slice(i + BIO_MARK.length).trim();
}

export function withBio(note: string, bio: string): string {
  const b = bio.replace(/\s+/g, " ").trim().slice(0, 500);
  return b ? `${note}\n${BIO_MARK}${b}` : note;
}

async function choices(ctx: Ctx): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const f of CLASSIFY_SELECTS) out[f] = (await ctx.base.fieldOptions(ctx.cfg.tables.profiles, f)) ?? [];
  return out;
}

/** `kol classify --batch X`: profiles in an 入库批次 still missing any of the fields, with what to judge them by. */
export async function toClassify(ctx: Ctx, o: { batch: string; limit: number }) {
  const rows = await ctx.base.records(ctx.cfg.tables.profiles, {
    filter: { logic: "and", conditions: [["入库批次", "intersects", [o.batch]]] },
    fields: ["账号", "账号名称", "主页链接", "粉丝数", "主要平台", "备注", ...CLASSIFY_FIELDS],
  });
  const missing = rows.filter((r) => CLASSIFY_FIELDS.some((f) => !text(r[f])));
  return {
    批次: o.batch,
    还要补的人数: missing.length,
    可选值: await choices(ctx),
    说明: "选项字段只能用「可选值」里的名字，拿不准就选「待確認」（没有这个选项就留空）。称呼写信里怎么叫对方，比如「小鹿」「Amy」，不要带 @",
    名单: missing.slice(0, o.limit).map((r) => ({
      id: r.record_id, 账号: text(r["账号"]), 账号名称: text(r["账号名称"]), 主页链接: text(r["主页链接"]),
      粉丝数: r["粉丝数"] ?? null, 主要平台: options(r["主要平台"]), 简介: bioOf(r["备注"]),
      已有: Object.fromEntries(CLASSIFY_FIELDS.filter((f) => text(r[f])).map((f) => [f, f === "称呼" ? text(r[f]) : option(r[f])])),
    })),
  };
}

/**
 * `kol classify --apply file.json`: writes { record_id: { 合作邀约方向, 市场, 語言, 内容类型, 称呼 } }. Every value
 * is checked first and nothing is written if any is wrong, so a typo never lands half a batch.
 */
export async function applyClassification(ctx: Ctx, o: { file: string; dryRun: boolean }) {
  const input: Record<string, Partial<Record<ClassifyField, string>>> = JSON.parse(readFileSync(o.file, "utf8"));
  const allowed = await choices(ctx);
  const known = new Set((await ctx.base.records(ctx.cfg.tables.profiles, { fields: ["账号"] })).map((r) => r.record_id));
  const errors: string[] = [];
  const changes: Record<string, Record<string, unknown>> = {};
  for (const [id, values] of Object.entries(input)) {
    if (!known.has(id)) {
      errors.push(`${id}：档案里没有这条记录`);
      continue;
    }
    const change: Record<string, unknown> = {};
    for (const [field, raw] of Object.entries(values ?? {})) {
      const v = String(raw ?? "").trim();
      if (!v) continue;
      if (field === "称呼") change[field] = v.replace(/^@/, "");
      else if ((CLASSIFY_SELECTS as readonly string[]).includes(field)) {
        if (allowed[field].includes(v)) change[field] = [v];
        else errors.push(`${id}：「${field}」没有「${v}」这个选项`);
      } else errors.push(`${id}：不能用 classify 改「${field}」`);
    }
    if (Object.keys(change).length) changes[id] = change;
  }
  if (errors.length) return { 写入: 0, 问题: errors, 说明: "有问题的值没改好之前，一条都没写" };
  if (!o.dryRun) {
    await ctx.base.update(ctx.cfg.tables.profiles, changes);
    ctx.run.op({ type: "飞书变更", result: "完成", action: `补全档案 ${Object.keys(changes).length} 人`, detail: o.file });
  }
  return { 写入: Object.keys(changes).length, 试跑: o.dryRun || undefined };
}
