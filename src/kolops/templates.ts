import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An approved template, kept as a file in the plugin. Files are named <名字>.txt; the first line may be
 * 主旨：… for the subject. Placeholders look like {稱呼}. Only templates in this folder may be sent
 * without a per-mail review, which is how 批量授权模板 already work.
 */
export interface Template {
  name: string;
  subject: string;
  body: string;
}

export function loadTemplates(dir: string): Map<string, Template> {
  const out = new Map<string, Template>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".txt")) continue;
    const raw = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");
    const m = raw.match(/^\s*(?:主旨|主题|Subject)\s*[:：]\s*(.+)\n/i);
    out.set(file.slice(0, -4), {
      name: file.slice(0, -4),
      subject: m ? m[1].trim() : "",
      body: (m ? raw.slice(m[0].length) : raw).trim(),
    });
  }
  return out;
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
