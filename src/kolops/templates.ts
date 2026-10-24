import { option, text } from "./base.js";
import type { Base } from "./base.js";
import type { Config } from "./config.js";

/**
 * An approved template, kept in the project's 模板 table. A person approves it in Feishu by setting 状态
 * to 已批准; only those are ever sent without a per-mail review. Placeholders look like {稱呼}.
 */
export interface Template {
  name: string;
  purpose: string;
  direction: string;
  language: string;
  subject: string;
  body: string;
}

export async function loadTemplates(base: Base, cfg: Config): Promise<Template[]> {
  const rows = await base.records(cfg.tables.templates, {
    filter: { logic: "and", conditions: [["状态", "intersects", ["已批准"]]] },
  });
  return rows
    .filter((r) => option(r["状态"]) === "已批准" && text(r["正文"]))
    .map((r) => ({
      name: text(r["名称"]), purpose: option(r["用途"]), direction: text(r["方向"]), language: text(r["语言"]),
      subject: text(r["主旨"]), body: text(r["正文"]).replace(/\r\n/g, "\n"),
    }));
}

/** The approved template for a purpose, preferring one written in the KOL's language. */
export function pickTemplate(all: Template[], purpose: string, language = ""): Template | undefined {
  const fit = all.filter((t) => t.purpose === purpose);
  return fit.find((t) => language && t.language && language.includes(t.language)) ?? fit.find((t) => !t.language) ?? fit[0];
}

export class MissingValue extends Error {}

/** Fills {占位符}. Any placeholder left without a value is an error, never sent as-is. */
export function render(t: Template, values: Record<string, string>): { subject: string; body: string } {
  const fill = (s: string) => s.replace(/\{([^{}\n]+)\}/g, (whole, key: string) => {
    const v = values[key.trim()];
    if (!v) throw new MissingValue(`模板「${t.name}」缺少 ${whole} 的值`);
    return v;
  });
  return { subject: fill(t.subject), body: fill(t.body) };
}

/** A template file (主旨：… on the first line, then the body), as `kol setup-base --import-templates` reads it. */
export function parseTemplateFile(raw: string): { subject: string; body: string } {
  const s = raw.replace(/\r\n/g, "\n");
  const m = s.match(/^\s*(?:主旨|主题|Subject)\s*[:：]\s*(.+)\n/i);
  return { subject: m ? m[1].trim() : "", body: (m ? s.slice(m[0].length) : s).trim() };
}
