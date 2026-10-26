import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "./pg.js";

/** A row as kept in kol.records, with times in milliseconds. */
export interface RawRow {
  id: string;
  fields: Record<string, any>;
  created_at: number;
  updated_at: number;
  seq: number;
}

/** A full read at least this often, as a safety net. */
const FULL_EVERY_MS = 24 * 3600_000;
/** Look back a little before the last read, so a write whose transaction began earlier but committed later isn't missed. */
const OVERLAP_MS = 5 * 60_000;
/** Within one run, a table checked this recently is not checked again (writes made here clear it at once). */
const FRESH_MS = 3000;

interface CacheFile {
  /** Database time when the last read started. */
  readAt: number;
  fullAt: number;
  rows: RawRow[];
}

/**
 * Whole tables of a database-kept project, through a local copy in ~/.kol-ops/cache: a database far away takes
 * seconds to send a table of thousands of rows, so after the first read only the rows whose updated_at moved are
 * fetched. Every write sets updated_at, so changes made from any computer show up. The row count and the first and
 * last seq are checked against the database on each read; when they differ (rows deleted, or the project restored
 * or imported again) the table is read in full.
 */
export class RowCache {
  private mem = new Map<string, CacheFile>();
  private checked = new Map<string, number>();

  constructor(private dir: string) {}

  /** Forget that tables were just checked, so the next read sees this run's own writes. */
  invalidate(): void {
    this.checked.clear();
  }

  async rows(sql: Sql, project: string, tbl: string): Promise<RawRow[]> {
    const file = join(this.dir, `${tbl.replace(/[^\w一-鿿-]/g, "_")}.json`);
    let cache = this.mem.get(tbl) ?? readCache(file);
    if (cache && Date.now() - (this.checked.get(tbl) ?? 0) < FRESH_MS) return cache.rows;

    const read = await sql.tx(async (q) => {
      // One snapshot for the check and the changed rows, so a write landing in between can't make them disagree.
      await q.query("set transaction isolation level repeatable read");
      const [s] = await q.query(
        "select now() as now, count(*)::int as n, coalesce(min(seq), 0)::text as lo, coalesce(max(seq), 0)::text as hi from kol.records where project = $1 and tbl = $2", [project, tbl]);
      const now = new Date(s.now).getTime();
      const usable = cache && now - cache.fullAt < FULL_EVERY_MS;
      const since = usable ? new Date(cache!.readAt - OVERLAP_MS).toISOString() : null;
      const rows = await q.query(
        `select id, fields, created_at, updated_at, seq::text as seq from kol.records where project = $1 and tbl = $2${since ? " and updated_at >= $3" : ""} order by seq`,
        since ? [project, tbl, since] : [project, tbl]);
      return { now, n: s.n as number, lo: Number(s.lo), hi: Number(s.hi), full: !since, rows: rows.map(raw) };
    });

    let next: CacheFile | null = null;
    if (!read.full) {
      const byId = new Map(cache!.rows.map((r) => [r.id, r]));
      for (const r of read.rows) byId.set(r.id, r);
      const merged = [...byId.values()].sort((a, b) => a.seq - b.seq);
      const same = merged.length === read.n && (merged[0]?.seq ?? 0) === read.lo && (merged.at(-1)?.seq ?? 0) === read.hi;
      if (same) next = { ...cache!, readAt: read.now, rows: merged };
    }
    if (!next) {
      next = read.full
        ? { readAt: read.now, fullAt: read.now, rows: read.rows }
        : await this.full(sql, project, tbl);
    }
    this.mem.set(tbl, next);
    this.checked.set(tbl, Date.now());
    // Only rewrite the file when something came in; an unchanged readAt just makes the next look-back a bit longer.
    if (read.full || read.rows.length || next.fullAt === next.readAt) save(this.dir, file, next);
    return next.rows;
  }

  private async full(sql: Sql, project: string, tbl: string): Promise<CacheFile> {
    const [{ now }] = await sql.query("select now() as now");
    const rows = await sql.query("select id, fields, created_at, updated_at, seq::text as seq from kol.records where project = $1 and tbl = $2 order by seq", [project, tbl]);
    const at = new Date(now).getTime();
    return { readAt: at, fullAt: at, rows: rows.map(raw) };
  }
}

function raw(r: any): RawRow {
  return { id: r.id, fields: r.fields, created_at: new Date(r.created_at).getTime(), updated_at: new Date(r.updated_at).getTime(), seq: Number(r.seq) };
}

function readCache(file: string): CacheFile | null {
  try {
    const c = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(c?.rows) && typeof c.readAt === "number" ? c : null;
  } catch {
    return null;
  }
}

function save(dir: string, file: string, data: CacheFile): void {
  // The copy holds KOL names and addresses, so only this user may read it; write then rename so a killed run leaves the old copy.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
