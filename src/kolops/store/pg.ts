import { randomBytes } from "node:crypto";
import { cellTime, dayOf } from "../base.js";
import type { Lark, RecordQuery, Row } from "../lark.js";

/**
 * A project's tables kept in Postgres instead of a Feishu base, in the same shape: every table, its fields and
 * every row are copied as Feishu gives them (rows as one JSON object each, Feishu's record ids kept), and the
 * `base +…` commands the plugin runs are answered from here. What Feishu did by itself is done here instead:
 * lookup formulas are worked out on reading, two-way links are kept in step on writing, dates are stored the way
 * Feishu returns them and 更新时间 / 录入时间 come from the row's own timestamps.
 */

/** The little the store needs from a Postgres driver; the plugin uses `postgres`, tests use PGlite. */
export interface Sql {
  query(text: string, params?: unknown[]): Promise<any[]>;
  tx<T>(fn: (q: Sql) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export const SCHEMA_SQL = `
create schema if not exists kol;
create table if not exists kol.tables (
  project text not null, name text not null, feishu_id text, position int not null default 0,
  primary key (project, name));
create table if not exists kol.fields (
  project text not null, tbl text not null, name text not null, position int not null default 0,
  type text not null, def jsonb not null,
  primary key (project, tbl, name));
create table if not exists kol.records (
  project text not null, tbl text not null, id text not null, fields jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (project, tbl, id));
create index if not exists records_updated on kol.records (project, tbl, updated_at);
-- Rows keep the order they had in Feishu (and new ones go last), as lists and ties in sorting depend on it.
alter table kol.records add column if not exists seq bigserial;
create or replace function kol.num(t text) returns numeric language plpgsql immutable as
  $$ begin return t::numeric; exception when others then return null; end $$;
create or replace function kol.ts(t text) returns timestamptz language plpgsql immutable as
  $$ begin return t::timestamptz; exception when others then return null; end $$;
create or replace function kol.bool(t text) returns boolean language plpgsql immutable as
  $$ begin return t::boolean; exception when others then return null; end $$;
`;

export interface FieldDef {
  name: string;
  type: string;
  id?: string;
  options?: { name: string }[];
  multiple?: boolean;
  link_table?: string;
  bidirectional?: boolean;
  bidirectional_link_field_id?: string;
  expression?: string;
  [k: string]: unknown;
}

/** Fields worked out by the store; writing them is refused, as Feishu ignores such writes. */
const COMPUTED = new Set(["formula", "lookup", "created_at", "updated_at", "created_by", "modified_by", "auto_number"]);

export class PgStore {
  private meta: Promise<Map<string, { feishuId: string; fields: FieldDef[] }>> | null = null;
  private tz = "+08:00";

  constructor(public project: string, public sql: Sql) {}

  // --- What the plugin asks for ---

  async records(table: string, opts: RecordQuery = {}): Promise<Row[]> {
    const name = await this.tableName(table);
    const rows = await this.load(name);
    const wanted = opts.filter ? rows.filter((r) => matches(r, opts.filter, this.tz)) : rows;
    return opts.fields?.length ? wanted.map((r) => pick(r, opts.fields!)) : wanted;
  }

  /** Answers the `base +…` lark-cli commands the plugin uses. */
  async command(args: string[]): Promise<any> {
    const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
    const many = (n: string) => args.filter((_, i) => args[i - 1] === n);
    const table = flag("--table-id");
    switch (args[1]) {
      case "+record-list":
        return matrix(await this.records(table!, { filter: flag("--filter-json") ? JSON.parse(flag("--filter-json")!) : undefined, fields: many("--field-id") }), many("--field-id"));
      case "+record-get": {
        const ids = new Set(many("--record-id"));
        const name = await this.tableName(table!);
        const rows = (await this.load(name, [...ids])).filter((r) => ids.has(r.record_id));
        return matrix(many("--field-id").length ? rows.map((r) => pick(r, many("--field-id"))) : rows, many("--field-id"));
      }
      case "+record-batch-create":
        return { record_id_list: await this.create(table!, JSON.parse(flag("--json")!).create_records) };
      case "+record-batch-update":
        await this.update(table!, JSON.parse(flag("--json")!).update_records);
        return {};
      case "+field-list":
        return { fields: (await this.fieldsOf(await this.tableName(table!))).map((f) => ({ ...f })) };
      case "+field-create":
        await this.addField(await this.tableName(table!), JSON.parse(flag("--json")!));
        return {};
      case "+field-update":
        await this.changeField(await this.tableName(table!), flag("--field-id")!, JSON.parse(flag("--json")!));
        return {};
      case "+table-create":
        await this.addTable(flag("--name")!, JSON.parse(flag("--fields") ?? "[]"));
        return {};
      case "+table-list":
        return { tables: [...(await this.tables()).entries()].map(([name, t]) => ({ name, id: t.feishuId || name })) };
      default:
        throw new Error(`数据库版还不支持 lark-cli base ${args[1]}`);
    }
  }

  async create(table: string, rows: Record<string, unknown>[]): Promise<string[]> {
    const name = await this.tableName(table);
    const defs = await this.fieldsOf(name);
    const ids: string[] = [];
    await this.sql.tx(async (q) => {
      for (const raw of rows) {
        const fields = this.normalize(name, defs, raw);
        const id = newId();
        await q.query("insert into kol.records (project, tbl, id, fields) values ($1, $2, $3, $4::text::jsonb)", [this.project, name, id, JSON.stringify(dropNulls(fields))]);
        await this.syncLinks(q, name, defs, id, {}, fields);
        ids.push(id);
      }
      await this.saveNewOptions(q, name, defs);
    });
    return ids;
  }

  async update(table: string, changes: Record<string, Record<string, unknown>>): Promise<void> {
    const name = await this.tableName(table);
    const defs = await this.fieldsOf(name);
    await this.sql.tx(async (q) => {
      for (const [id, raw] of Object.entries(changes)) {
        const fields = this.normalize(name, defs, raw);
        const [old] = await q.query("select fields from kol.records where project = $1 and tbl = $2 and id = $3 for update", [this.project, name, id]);
        if (!old) throw new Error(`${name} 里没有 ${id} 这一条`);
        const cleared = Object.keys(fields).filter((k) => fields[k] == null);
        // Merged in the database, so two writers changing different fields of one row never undo each other.
        await q.query("update kol.records set fields = (fields || $4::text::jsonb) - array(select jsonb_array_elements_text($5::text::jsonb)), updated_at = now() where project = $1 and tbl = $2 and id = $3",
          [this.project, name, id, JSON.stringify(dropNulls(fields)), JSON.stringify(cleared)]);
        await this.syncLinks(q, name, defs, id, old.fields, fields);
      }
      await this.saveNewOptions(q, name, defs);
    });
  }

  // --- Reading ---

  /** Every row of a table (or only these ids), with formulas and system fields filled in. */
  private async load(name: string, ids?: string[]): Promise<Row[]> {
    const defs = await this.fieldsOf(name);
    const rows = await this.sql.query(
      `select id, fields, created_at, updated_at from kol.records where project = $1 and tbl = $2${ids ? " and id in (select jsonb_array_elements_text($3::text::jsonb))" : ""} order by seq`,
      ids ? [this.project, name, JSON.stringify(ids)] : [this.project, name]);
    const out: Row[] = rows.map((r) => ({ record_id: r.id, ...r.fields }));
    for (const d of defs) {
      if (d.type === "created_at" || d.type === "updated_at") {
        rows.forEach((r, i) => (out[i][d.name] = iso(new Date(d.type === "created_at" ? r.created_at : r.updated_at).getTime(), this.tz)));
      }
    }
    for (const d of defs.filter((x) => x.type === "formula")) await this.formula(name, defs, d, out);
    return out;
  }

  /**
   * The lookups Feishu bases use, `[link].[field].LISTCOMBINE().UNIQUE()` and `[link].[field].MAX()`, worked out
   * from the linked rows. Any other formula reads as empty: the plugin doesn't use them.
   */
  private async formula(name: string, defs: FieldDef[], d: FieldDef, rows: Row[]): Promise<void> {
    const m = String(d.expression ?? "").match(/^\[(.+?)\]\.\[(.+?)\]\.(LISTCOMBINE\(\)\.UNIQUE\(\)|MAX\(\))$/);
    const link = m && defs.find((x) => x.name === m[1] && x.type === "link");
    if (!m || !link) {
      rows.forEach((r) => (r[d.name] = null));
      return;
    }
    const target = await this.tableName(link.link_table!);
    const ids = [...new Set(rows.flatMap((r) => linkIdsOf(r[link.name])))];
    const linked = ids.length ? await this.sql.query("select id, fields from kol.records where project = $1 and tbl = $2 and id in (select jsonb_array_elements_text($3::text::jsonb))", [this.project, target, JSON.stringify(ids)]) : [];
    const byId = new Map(linked.map((x) => [x.id, x.fields]));
    for (const r of rows) {
      const values = linkIdsOf(r[link.name]).flatMap((id) => {
        const v = byId.get(id)?.[m[2]];
        return v == null || v === "" ? [] : Array.isArray(v) ? v.map((x) => (typeof x === "object" && x ? x.name ?? x.text ?? x.id : x)) : [v];
      });
      if (m[3] === "MAX()") {
        const nums = values.map(Number).filter((n) => !Number.isNaN(n));
        r[d.name] = nums.length ? String(Math.max(...nums)) : null;
      } else {
        const unique = [...new Set(values.map(String))];
        r[d.name] = unique.length ? unique.join(",") : null;
      }
    }
  }

  // --- Writing ---

  /** Values the way Feishu stores them; unknown and computed fields are refused, as the plugin treats them as bugs. */
  private normalize(table: string, defs: FieldDef[], raw: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const bad: string[] = [];
    for (const [k, v] of Object.entries(raw ?? {})) {
      const d = defs.find((x) => x.name === k);
      if (!d) bad.push(`${k}（没有这个字段）`);
      else if (COMPUTED.has(d.type)) bad.push(`${k}（自动算的字段，不能写）`);
      else out[k] = this.value(d, v);
    }
    if (bad.length) throw new Error(`${table} 有字段没写进去：${bad.join("；")}`);
    return out;
  }

  private value(d: FieldDef, v: unknown): unknown {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return null;
    switch (d.type) {
      case "number": {
        const n = Number(v);
        if (Number.isNaN(n)) throw new Error(`「${d.name}」要填数字，收到的是「${v}」`);
        return n;
      }
      case "checkbox":
        return v === true || v === "true";
      case "datetime": {
        const s = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? `${v.trim()} 00:00` : v;
        const t = cellTime(s, this.tz);
        if (t == null) throw new Error(`「${d.name}」不是日期：「${v}」`);
        return iso(t, this.tz);
      }
      case "select": {
        const list = (Array.isArray(v) ? v : [v]).map((x) => String(typeof x === "object" && x ? (x as any).name ?? (x as any).text : x));
        const known = new Set((d.options ?? []).map((o) => o.name));
        for (const o of list) if (!known.has(o)) (d.options ??= []).push({ name: o }), (d as any)._changed = true;
        return d.multiple === false ? list.slice(0, 1) : list;
      }
      case "link":
        return (Array.isArray(v) ? v : [v]).map((x) => ({ id: String(typeof x === "object" && x ? (x as any).id ?? (x as any).record_id : x) }));
      case "text":
        return Array.isArray(v) ? v.map((x) => (typeof x === "object" && x ? (x as any).text ?? (x as any).name ?? "" : String(x))).join("") : typeof v === "object" ? JSON.stringify(v) : String(v);
      default:
        return v;
    }
  }

  /** Feishu adds an option the first time a row uses it; so does the store. */
  private async saveNewOptions(q: Sql, table: string, defs: FieldDef[]): Promise<void> {
    for (const d of defs.filter((x) => (x as any)._changed)) {
      delete (d as any)._changed;
      await q.query("update kol.fields set def = $4::text::jsonb where project = $1 and tbl = $2 and name = $3", [this.project, table, d.name, JSON.stringify(d)]);
    }
  }

  /** A two-way link written on one side shows on the other, as in Feishu. */
  private async syncLinks(q: Sql, table: string, defs: FieldDef[], id: string, before: Record<string, unknown>, after: Record<string, unknown>): Promise<void> {
    for (const d of defs) {
      if (d.type !== "link" || !d.bidirectional || !(d.name in after)) continue;
      const target = await this.tableName(d.link_table!);
      const back = (await this.fieldsOf(target)).find((x) => x.id === d.bidirectional_link_field_id);
      if (!back) continue;
      const was = new Set(linkIdsOf(before[d.name]));
      const now = new Set(linkIdsOf(after[d.name]));
      for (const other of new Set([...was, ...now])) {
        if (was.has(other) === now.has(other)) continue;
        const [row] = await q.query("select fields from kol.records where project = $1 and tbl = $2 and id = $3 for update", [this.project, target, other]);
        if (!row) continue;
        const ids = linkIdsOf(row.fields[back.name]).filter((x) => x !== id);
        if (now.has(other)) ids.push(id);
        await q.query("update kol.records set fields = case when $5::text::jsonb = '[]'::jsonb then fields - $4::text else jsonb_set(fields, array[$4::text], $5::text::jsonb) end, updated_at = now() where project = $1 and tbl = $2 and id = $3",
          [this.project, target, other, back.name, JSON.stringify(ids.map((x) => ({ id: x })))]);
      }
    }
  }

  // --- Tables and fields ---

  private tables() {
    this.meta ??= (async () => {
      const [tables, fields] = await Promise.all([
        this.sql.query("select name, feishu_id from kol.tables where project = $1 order by position, name", [this.project]),
        this.sql.query("select tbl, def from kol.fields where project = $1 order by position, name", [this.project]),
      ]);
      const map = new Map<string, { feishuId: string; fields: FieldDef[] }>(tables.map((t) => [t.name, { feishuId: t.feishu_id ?? "", fields: [] }]));
      for (const f of fields) map.get(f.tbl)?.fields.push(f.def);
      if (map.has("设置")) {
        const [s] = await this.sql.query("select fields->>'时区' as tz from kol.records where project = $1 and tbl = '设置' limit 1", [this.project]);
        if (s?.tz && /^[+-]\d{2}:\d{2}$/.test(s.tz)) this.tz = s.tz;
      }
      return map;
    })().catch((err) => {
      this.meta = null;
      throw err;
    });
    return this.meta;
  }

  /** The table a name or a Feishu table id refers to; "not found" when there is none, as Feishu says. */
  private async tableName(table: string): Promise<string> {
    const all = await this.tables();
    if (all.has(table)) return table;
    for (const [name, t] of all) if (t.feishuId && t.feishuId === table) return name;
    throw new Error(`table ${table} not found（项目「${this.project}」的数据库里没有这张表）`);
  }

  private async fieldsOf(name: string): Promise<FieldDef[]> {
    return (await this.tables()).get(name)!.fields;
  }

  private async addTable(name: string, fields: FieldDef[]): Promise<void> {
    await this.sql.tx(async (q) => {
      await q.query("insert into kol.tables (project, name, position) values ($1, $2, (select coalesce(max(position), 0) + 1 from kol.tables where project = $1))", [this.project, name]);
      for (const f of fields) await this.insertField(q, name, f);
    });
    this.meta = null;
  }

  private async addField(table: string, f: FieldDef): Promise<void> {
    if ((await this.fieldsOf(table)).some((x) => x.name === f.name)) throw new Error(`${table} 已经有「${f.name}」字段`);
    await this.insertField(this.sql, table, f);
    this.meta = null;
  }

  private async insertField(q: Sql, table: string, f: FieldDef): Promise<void> {
    const def = { ...f, id: f.id ?? `fld${randomBytes(5).toString("hex")}` };
    await q.query("insert into kol.fields (project, tbl, name, position, type, def) values ($1, $2, $3, (select coalesce(max(position), 0) + 1 from kol.fields where project = $1 and tbl = $2), $4, $5::text::jsonb)",
      [this.project, table, f.name, f.type, JSON.stringify(def)]);
  }

  /** Changes a field's options or settings; the options listed replace the old ones, as in Feishu. */
  private async changeField(table: string, field: string, f: Partial<FieldDef>): Promise<void> {
    const old = (await this.fieldsOf(table)).find((x) => x.name === field || x.id === field);
    if (!old) throw new Error(`${table} 没有「${field}」字段`);
    const def = { ...old, ...f, name: old.name, id: old.id };
    await this.sql.query("update kol.fields set def = $4::text::jsonb, type = $5 where project = $1 and tbl = $2 and name = $3", [this.project, table, old.name, JSON.stringify(def), def.type]);
    this.meta = null;
  }
}

/** The plugin's lark-cli, with the base commands of projects kept in Postgres answered from there. */
export class StoreLark implements Lark {
  constructor(private inner: Lark, private defaultToken: string, public storeFor: (baseToken: string) => PgStore | null) {}

  json(args: string[]): Promise<any> {
    if (args[0] === "base") {
      const token = args.includes("--base-token") ? args[args.indexOf("--base-token") + 1] : this.defaultToken;
      const store = this.storeFor(token);
      if (store) return store.command(args);
    }
    return this.inner.json(args);
  }

  records(table: string, opts: RecordQuery = {}): Promise<Row[]> {
    const store = this.storeFor(opts.baseToken ?? this.defaultToken);
    return store ? store.records(table, opts) : this.inner.records(table, opts);
  }
}

// --- Helpers ---

export function newId(): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return `rec${[...randomBytes(14)].map((b) => abc[b % abc.length]).join("")}`;
}

/** Feishu's datetime form: "2026-12-05T10:00:00.000+08:00". */
export function iso(ms: number, tz: string): string {
  const sign = tz.startsWith("-") ? -1 : 1;
  const [h, m] = tz.slice(1).split(":").map(Number);
  return `${new Date(ms + sign * (h * 60 + (m || 0)) * 60_000).toISOString().slice(0, 23)}${tz}`;
}

function linkIdsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x: any) => String(x?.id ?? x)).filter(Boolean) : [];
}

function dropNulls(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}

function pick(r: Row, fields: string[]): Row {
  const out: Row = { record_id: r.record_id };
  for (const f of fields) if (f in r) out[f] = r[f];
  return out;
}

/** The `+record-list --format json` shape, which `matrixRows` turns back into rows. */
function matrix(rows: Row[], fields: string[]): any {
  const names = fields.length ? fields : [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => k !== "record_id")))];
  return { fields: names, record_id_list: rows.map((r) => r.record_id), data: rows.map((r) => names.map((f) => r[f] ?? null)), has_more: false };
}

/** Feishu's record filter, for the conditions the plugin writes: intersects, ==, !=, >, <, >=, <=, isEmpty, isNotEmpty. */
export function matches(r: Row, filter: any, tz: string): boolean {
  const conds: [string, string, any][] = filter?.conditions ?? [];
  const test = ([field, op, value]: [string, string, any]) => {
    const v = r[field];
    const empty = v == null || v === "" || (Array.isArray(v) && !v.length);
    if (op === "isEmpty") return empty;
    if (op === "isNotEmpty") return !empty;
    const date = typeof value === "string" ? value.match(/^ExactDate\((\d{4}-\d{2}-\d{2})\)$/) : null;
    if (date) {
      const t = cellTime(v, tz);
      if (t == null) return false;
      const d = dayOf(t, tz);
      return op === ">" ? d > date[1] : op === "<" ? d < date[1] : op === ">=" ? d >= date[1] : op === "<=" ? d <= date[1] : op === "==" ? d === date[1] : op === "!=" ? d !== date[1] : false;
    }
    const cells = (Array.isArray(v) ? v : [v]).map((x) => (typeof x === "object" && x ? x.name ?? x.text ?? x.id : x));
    if (op === "intersects") return cells.some((x) => (Array.isArray(value) ? value : [value]).includes(x));
    if (op === "==") return cells.some((x) => x === value || String(x) === String(value)) || (value === false && empty);
    if (op === "!=") return !cells.some((x) => x === value || String(x) === String(value));
    const n = Number(v), w = Number(value);
    if (Number.isNaN(n) || Number.isNaN(w)) return false;
    return op === ">" ? n > w : op === "<" ? n < w : op === ">=" ? n >= w : op === "<=" ? n <= w : false;
  };
  return filter?.logic === "or" ? conds.some(test) : conds.every(test);
}
