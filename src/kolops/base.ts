import type { Lark, Row } from "./lark.js";

export type Fields = Record<string, unknown>;

/** Writes to one Base. Batches are capped at 200 and sent one after another, as lark-cli requires per table. */
export class Base {
  constructor(public lark: Lark, private token: string) {}

  records(table: string, opts?: { filter?: object; fields?: string[] }): Promise<Row[]> {
    return this.lark.records(table, opts);
  }

  /** Option names of a select field, or null when the field can't be found. */
  async fieldOptions(table: string, field: string): Promise<string[] | null> {
    const data = await this.lark.json(["base", "+field-list", "--base-token", this.token, "--table-id", table, "--format", "json", "--as", "user"]);
    let found: string[] | null = null;
    const walk = (v: any) => {
      if (found || !v || typeof v !== "object") return;
      if (!Array.isArray(v) && v.name === field && (v.options || v.property?.options)) {
        found = (v.options ?? v.property.options).map((o: any) => String(o.name ?? o));
        return;
      }
      Object.values(v).forEach(walk);
    };
    walk(data);
    return found;
  }

  async create(table: string, rows: Fields[]): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < rows.length; i += 200) {
      const data = await this.lark.json(["base", "+record-batch-create", "--base-token", this.token, "--table-id", table,
        "--json", JSON.stringify({ create_records: rows.slice(i, i + 200) }), "--as", "user"]);
      noIgnored(table, data);
      ids.push(...recordIds(data));
    }
    return ids;
  }

  async update(table: string, changes: Record<string, Fields>): Promise<void> {
    const entries = Object.entries(changes);
    for (let i = 0; i < entries.length; i += 200) {
      const data = await this.lark.json(["base", "+record-batch-update", "--base-token", this.token, "--table-id", table,
        "--json", JSON.stringify({ update_records: Object.fromEntries(entries.slice(i, i + 200)) }), "--as", "user"]);
      noIgnored(table, data);
    }
  }
}

/** A misspelt or read-only field is silently skipped by the API; treat that as a bug, not a success. */
function noIgnored(table: string, data: any): void {
  const ignored = data?.ignored_fields ?? [];
  if (ignored.length) throw new Error(`${table} 有字段没写进去：${ignored.map((f: any) => `${f.name}（${f.reason}）`).join("；")}`);
}

function recordIds(data: any): string[] {
  const list = data?.record_id_list ?? data?.record_ids ?? data?.records?.map((r: any) => r.record_id) ?? [];
  return list.map(String);
}

// --- Reading NDJSON cells ---

export function text(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" && x ? (x as any).name ?? (x as any).text ?? "" : String(x))).join(", ");
  return String(v).trim();
}

/** A single-select value (NDJSON gives selects as arrays of option names). */
export function option(v: unknown): string {
  return Array.isArray(v) ? String(v[0] ?? "") : text(v);
}

export function options(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : v ? [String(v)] : [];
}

export function linkIds(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x: any) => String(x?.id ?? x)).filter(Boolean) : [];
}

/** Calendar day (YYYY-MM-DD) of a datetime cell in the given offset, or "" when empty. */
export function day(v: unknown, tz = "+08:00"): string {
  if (!v) return "";
  const t = typeof v === "number" ? v : Date.parse(String(v));
  if (Number.isNaN(t)) return String(v).slice(0, 10);
  return dayOf(t, tz);
}

export function dayOf(ms: number, tz = "+08:00"): string {
  const sign = tz.startsWith("-") ? -1 : 1;
  const [h, m] = tz.slice(1).split(":").map(Number);
  return new Date(ms + sign * (h * 60 + (m || 0)) * 60_000).toISOString().slice(0, 10);
}

export function addDays(dayStr: string, n: number): string {
  const d = new Date(`${dayStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Days from `a` to `b`, both YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function emailsIn(v: unknown): string[] {
  return (text(v).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((e) => e.toLowerCase());
}
