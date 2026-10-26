import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import postgres from "postgres";
import { cellTime, dayOf } from "../base.js";
import type { Lark } from "../lark.js";
import { dataDir } from "../ops.js";
import { listProjects } from "../projects.js";
import { PgStore, SCHEMA_SQL, StoreLark, type FieldDef, type Sql } from "./pg.js";
import { RowCache } from "./rowcache.js";

/** A Postgres connection through the `postgres` driver. */
export function connect(url: string): Sql & { exec(text: string): Promise<void> } {
  const sql = postgres(url, { max: 4, onnotice: () => {}, connect_timeout: 15 });
  const wrap = (q: any): Sql => ({
    query: async (text, params = []) => [...(await q.unsafe(text, params as any[]))],
    tx: (fn) => sql.begin((t) => fn(wrap(t))) as any,
    end: () => sql.end({ timeout: 5 }),
  });
  return { ...wrap(sql), exec: async (text) => void (await sql.unsafe(text)) };
}

const connections = new Map<string, Sql & { exec(text: string): Promise<void> }>();

function shared(url: string) {
  let c = connections.get(url);
  if (!c) connections.set(url, (c = connect(url)));
  return c;
}

/**
 * The lark-cli the commands use, with the tables of every project registered with a database answered from
 * Postgres. Projects without one keep using their Feishu base, so both kinds can live on one computer.
 */
export function withStores(inner: Lark, defaultToken: string): Lark {
  const byToken = new Map(listProjects().filter((p) => p.database).map((p) => [p.baseToken, p]));
  if (!byToken.size) return inner;
  const stores = new Map<string, PgStore>();
  return new StoreLark(inner, defaultToken, (token) => {
    const p = byToken.get(token);
    if (!p) return null;
    let s = stores.get(token);
    if (!s) stores.set(token, (s = new PgStore(p.name, shared(p.database!), new RowCache(cacheDir(p.name, p.database!)))));
    return s;
  });
}

/** Where a project's local copy of its database tables lives; one per database, so switching databases starts afresh. */
export function cacheDir(project: string, url: string): string {
  const db = createHash("sha256").update(url.replace(/\/\/([^:@/]+):[^@]+@/, "//$1@")).digest("hex").slice(0, 10);
  return join(dataDir(), "cache", `db-${project.replace(/[^\w一-鿿-]/g, "_")}-${db}`);
}

// --- Copying a Feishu base in, backups ---

export interface Snapshot {
  version: 1;
  project: string;
  exportedAt: string;
  tables: { name: string; feishu_id: string; position: number }[];
  fields: { tbl: string; name: string; position: number; type: string; def: FieldDef }[];
  records: { tbl: string; id: string; fields: Record<string, unknown>; created_at: string; updated_at: string }[];
}

/** Values Feishu works out are not stored; who created a row is, since nothing can work it out again. */
const NOT_STORED = new Set(["formula", "lookup", "created_at", "updated_at", "modified_by", "auto_number"]);

/** Reads every table of a Feishu base, as `kol db import` copies it. */
export async function readFeishu(lark: Lark, baseToken: string, project: string, onTable?: (name: string, n: number) => void): Promise<Snapshot> {
  const list = await lark.json(["base", "+table-list", "--base-token", baseToken, "--format", "json", "--as", "user"]);
  const tables: { name: string; id: string }[] = (list?.tables ?? list?.items ?? []).map((t: any) => ({ name: String(t.name), id: String(t.id ?? t.table_id ?? "") }));
  const snap: Snapshot = { version: 1, project, exportedAt: new Date().toISOString(), tables: [], fields: [], records: [] };
  for (const [i, t] of tables.entries()) {
    const defs: FieldDef[] = (await lark.json(["base", "+field-list", "--base-token", baseToken, "--table-id", t.id || t.name, "--format", "json", "--as", "user"]))?.fields ?? [];
    snap.tables.push({ name: t.name, feishu_id: t.id, position: i + 1 });
    defs.forEach((d, j) => snap.fields.push({ tbl: t.name, name: d.name, position: j + 1, type: d.type, def: d }));
    const created = defs.find((d) => d.type === "created_at")?.name;
    const updated = defs.find((d) => d.type === "updated_at")?.name;
    const tz = "+08:00";
    const rows = await lark.records(t.id || t.name, { baseToken });
    for (const r of rows) {
      const fields: Record<string, unknown> = {};
      for (const d of defs) if (!NOT_STORED.has(d.type) && r[d.name] != null && r[d.name] !== "") fields[d.name] = r[d.name];
      const c = created ? cellTime(r[created], tz) : null;
      const u = updated ? cellTime(r[updated], tz) : null;
      snap.records.push({ tbl: t.name, id: r.record_id, fields, created_at: new Date(c ?? u ?? Date.now()).toISOString(), updated_at: new Date(u ?? c ?? Date.now()).toISOString() });
    }
    onTable?.(t.name, rows.length);
  }
  return snap;
}

export async function ensureSchema(sql: Sql & { exec(text: string): Promise<void> }): Promise<void> {
  await sql.exec(SCHEMA_SQL);
}

/** How many rows each table of the project has in the database (empty when it has none). */
export async function projectCounts(sql: Sql, project: string): Promise<Record<string, number>> {
  const rows = await sql.query(
    "select t.name, count(r.id)::int as n from kol.tables t left join kol.records r on r.project = t.project and r.tbl = t.name where t.project = $1 group by t.name, t.position order by t.position", [project]);
  return Object.fromEntries(rows.map((r) => [r.name, r.n]));
}

/** Puts a snapshot in the database as the project's data; with `replace`, what the project had is removed first. */
export async function loadSnapshot(sql: Sql, snap: Snapshot, project: string, replace: boolean): Promise<void> {
  await sql.tx(async (q) => {
    const [{ n }] = await q.query("select count(*)::int as n from kol.tables where project = $1", [project]);
    if (n && !replace) throw new Error(`数据库里已经有项目「${project}」的数据。要整个换掉，加 --replace（会先删掉库里这个项目的全部数据）`);
    for (const t of ["records", "fields", "tables"]) await q.query(`delete from kol.${t} where project = $1`, [project]);
    for (const t of snap.tables) await q.query("insert into kol.tables (project, name, feishu_id, position) values ($1, $2, $3, $4)", [project, t.name, t.feishu_id, t.position]);
    for (const f of snap.fields) {
      await q.query("insert into kol.fields (project, tbl, name, position, type, def) values ($1, $2, $3, $4, $5, $6::text::jsonb)", [project, f.tbl, f.name, f.position, f.type, JSON.stringify(f.def)]);
    }
    for (let i = 0; i < snap.records.length; i += 500) {
      await q.query(`insert into kol.records (project, tbl, id, fields, created_at, updated_at)
        select $1, e->>'tbl', e->>'id', e->'fields', (e->>'created_at')::timestamptz, (e->>'updated_at')::timestamptz
        from jsonb_array_elements($2::text::jsonb) with ordinality as x(e, n) order by n`,
      [project, JSON.stringify(snap.records.slice(i, i + 500))]);
    }
  });
}

export async function exportProject(sql: Sql, project: string): Promise<Snapshot> {
  const [tables, fields, records] = await Promise.all([
    sql.query("select name, feishu_id, position from kol.tables where project = $1 order by position", [project]),
    sql.query("select tbl, name, position, type, def from kol.fields where project = $1 order by tbl, position", [project]),
    sql.query("select tbl, id, fields, created_at, updated_at from kol.records where project = $1 order by tbl, seq", [project]),
  ]);
  const at = (v: any) => new Date(v).toISOString();
  return {
    version: 1, project, exportedAt: new Date().toISOString(),
    tables: tables.map((t) => ({ name: t.name, feishu_id: t.feishu_id ?? "", position: t.position })),
    fields: fields.map((f) => ({ tbl: f.tbl, name: f.name, position: f.position, type: f.type, def: f.def })),
    records: records.map((r) => ({ tbl: r.tbl, id: r.id, fields: r.fields, created_at: at(r.created_at), updated_at: at(r.updated_at) })),
  };
}

const KEEP_BACKUPS = 30;

export function backupDir(project: string): string {
  const dir = join(dataDir(), "backups", project.replace(/[^\w一-鿿-]/g, "_"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Writes the project's whole database copy to ~/.kol-ops/backups/<project>/<date>.json.gz and keeps the newest 30. */
export async function backup(sql: Sql, project: string, dir = backupDir(project), name = dayOf(Date.now())): Promise<{ file: string; rows: number }> {
  const snap = await exportProject(sql, project);
  const file = join(dir, `${name}.json.gz`);
  writeFileSync(file, gzipSync(JSON.stringify(snap)), { mode: 0o600 });
  const old = readdirSync(dir).filter((f) => f.endsWith(".json.gz")).sort().reverse().slice(KEEP_BACKUPS);
  for (const f of old) unlinkSync(join(dir, f));
  return { file, rows: snap.records.length };
}

export function hasBackupToday(project: string): boolean {
  return existsSync(join(backupDir(project), `${dayOf(Date.now())}.json.gz`));
}

/**
 * Replaces the project's data with a backup. The file is read first, as it may be today's backup, which the
 * backup of what is there now would otherwise overwrite; that backup gets a name of its own.
 */
export async function restore(sql: Sql, project: string, file: string): Promise<{ before: string | null; counts: Record<string, number> }> {
  const snap = readBackup(file);
  const name = `${new Date().toISOString().slice(0, 19).replace(/:/g, "")}-恢复前`;
  const before = await backup(sql, project, undefined, name).catch(() => null);
  await loadSnapshot(sql, { ...snap, project }, project, true);
  await createViews(sql, project);
  return { before: before?.file ?? null, counts: await projectCounts(sql, project) };
}

export function readBackup(file: string): Snapshot {
  const snap = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
  if (snap?.version !== 1 || !Array.isArray(snap.records)) throw new Error(`${file} 不是 kol db backup 生成的备份`);
  return snap;
}

// --- Views for analysis ---

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The column a field becomes in its table's view, typed so it can be filtered, summed and joined in SQL. */
function column(f: FieldDef): string | null {
  const v = `fields->${lit(f.name)}`;
  const t = `fields->>${lit(f.name)}`;
  switch (f.type) {
    case "text": return t;
    case "number": return `kol.num(${t})`;
    case "checkbox": return `kol.bool(${t})`;
    case "datetime": return `kol.ts(${t})`;
    case "created_at": return "created_at";
    case "updated_at": return "updated_at";
    case "select":
      return f.multiple === false
        ? `case when jsonb_typeof(${v}) = 'array' then ${v}->>0 else ${t} end`
        : `case when jsonb_typeof(${v}) = 'array' then array(select jsonb_array_elements_text(${v})) end`;
    case "link": return `case when jsonb_typeof(${v}) = 'array' then array(select x->>'id' from jsonb_array_elements(${v}) x) end`;
    case "formula": case "lookup": return null;
    default: return v;
  }
}

/**
 * One view per table, named "<project>/<table>" in the kol schema, with a typed column per field and the row's
 * id as record_id: `select 阶段, count(*) from kol."tafu/KOL 跟进" group by 1`. Lookup formulas are left out;
 * join the linked table instead.
 */
export async function createViews(sql: Sql, project: string): Promise<string[]> {
  const [tables, fields] = await Promise.all([
    sql.query("select name from kol.tables where project = $1 order by position", [project]),
    sql.query("select tbl, name, def from kol.fields where project = $1 order by tbl, position", [project]),
  ]);
  const made: string[] = [];
  for (const t of tables) {
    const view = `kol.${ident(`${project}/${t.name}`)}`;
    const used = new Set(["record_id"]);
    const cols = fields.filter((f) => f.tbl === t.name).flatMap((f) => {
      const expr = column(f.def);
      if (!expr || used.has(f.name)) return [];
      used.add(f.name);
      return [`${expr} as ${ident(f.name)}`];
    });
    await sql.query(`drop view if exists ${view}`);
    await sql.query(`create view ${view} as select id as record_id${cols.map((c) => `, ${c}`).join("")} from kol.records where project = ${lit(project)} and tbl = ${lit(t.name)}`);
    made.push(`kol.${ident(`${project}/${t.name}`)}`);
  }
  return made;
}
