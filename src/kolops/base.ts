import { matrixRows, type Lark, type RecordQuery, type Row } from "./lark.js";

export type Fields = Record<string, unknown>;

/** Writes to one Base. Batches are capped at 200 and sent one after another, as lark-cli requires per table. */
export class Base {
  constructor(public lark: Lark, public token: string) {}

  records(table: string, opts: Omit<RecordQuery, "baseToken"> = {}): Promise<Row[]> {
    return this.lark.records(table, { ...opts, baseToken: this.token });
  }

  /** The records with these ids, 100 per call. Ids that no longer exist are simply missing from the result. */
  async get(table: string, ids: string[], fields: string[] = []): Promise<Row[]> {
    const rows: Row[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const args = ["base", "+record-get", "--base-token", this.token, "--table-id", table, "--format", "json", "--as", "user"];
      for (const id of ids.slice(i, i + 100)) args.push("--record-id", id);
      for (const f of fields) args.push("--field-id", f);
      rows.push(...matrixRows(await this.lark.json(args)));
    }
    return rows;
  }

  /** Names of a table's fields, or null when the base has no such table. Other errors (login, network) are thrown. */
  async fieldNames(table: string): Promise<string[] | null> {
    let data: any;
    try {
      data = await this.lark.json(["base", "+field-list", "--base-token", this.token, "--table-id", table, "--format", "json", "--as", "user"]);
    } catch (err: any) {
      if (/not_found|not found/i.test(String(err?.message))) return null;
      throw err;
    }
    const names: string[] = [];
    const walk = (v: any) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        if (typeof v.name === "string" && (v.type || v.field_id || v.id)) names.push(v.name);
        else Object.values(v).forEach(walk);
      }
    };
    walk(data);
    return names;
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

/** Epoch ms of a datetime cell: a number, an ISO string, or the "YYYY-MM-DD HH:mm" this plugin writes (in `tz`). */
export function cellTime(v: unknown, tz = "+08:00"): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  const local = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/);
  const t = local ? Date.parse(`${local[1]}T${local[2]}${local[3] ?? ":00"}${tz}`) : Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * "YYYY-MM-DDTHH:mm:ss+08:00": the only time form Feishu mail filters accept (milliseconds or a "Z" are
 * rejected with "field validation failed").
 */
export function isoSeconds(ms: number, tz = "+08:00"): string {
  const sign = tz.startsWith("-") ? -1 : 1;
  const [h, m] = tz.slice(1).split(":").map(Number);
  return `${new Date(ms + sign * (h * 60 + (m || 0)) * 60_000).toISOString().slice(0, 19)}${tz}`;
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

/**
 * A filter condition for "on or after this day". Feishu rejects ">=" on date fields and doesn't document
 * where ">" puts the boundary, so this asks for everything after the day before; callers that need the exact
 * boundary also check `day(cell) >= dayStr` themselves.
 */
export function onOrAfter(field: string, dayStr: string): [string, string, string] {
  return [field, ">", `ExactDate(${addDays(dayStr, -1)})`];
}

/** Days from `a` to `b`, both YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function emailsIn(v: unknown): string[] {
  return (text(v).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((e) => e.toLowerCase());
}
