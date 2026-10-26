import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cellTime, dayOf, onOrAfter, type Base } from "./base.js";
import type { Row } from "./lark.js";
import { dataDir } from "./ops.js";
import { StoreLark } from "./store/pg.js";

/** The system modified-time field every cached table needs (type updated_at). */
export const MODIFIED = "更新时间";
/** A full read at least this often, which is also how rows deleted in Feishu leave the cache. */
const FULL_EVERY_MS = 20 * 3600_000;
/** Look back a little before the last read, so an edit saved while that read was running isn't missed. */
const OVERLAP_MS = 10 * 60_000;

interface CacheFile {
  fields: string[];
  /** When the last read (full or incremental) started. */
  readAt: number;
  fullAt: number;
  rows: Record<string, Row>;
}

/**
 * Reads a whole table through a local copy kept in ~/.kol-ops/cache: a full read the first time, at least every
 * 20 hours and whenever the wanted fields change; otherwise only the rows whose 更新时间 changed since the last
 * read, merged into the copy. Rows deleted in Feishu stay in the copy until the next full read, which is harmless
 * for what the copy is used for (finding people and their addresses, never writing back to a deleted row).
 * A table without 更新时间 is read in full every time.
 */
export async function cachedRecords(base: Base, table: string, fields: string[], tz: string): Promise<Row[]> {
  const want = [...new Set([...fields, MODIFIED])].sort();
  // A project kept in a database has its own local copy, which also notices deleted and restored rows; a second
  // copy on top, keyed on 更新时间 days, would keep serving old values for up to a day after a restore.
  if (base.lark instanceof StoreLark && base.lark.storeFor(base.token)) return base.records(table, { fields: want });
  const dir = join(dataDir(), "cache", base.token);
  // The copy holds KOL names and addresses, so only this user may read it.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${table.replace(/[^\w一-鿿-]/g, "_")}.json`);
  const now = Date.now();
  let cache: CacheFile | null = null;
  try {
    cache = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    cache = null;
  }
  const usable = cache && cache.fields.join("\n") === want.join("\n") && now - cache.fullAt < FULL_EVERY_MS;

  if (usable) {
    const since = cache!.readAt - OVERLAP_MS;
    const changed = await base.records(table, { fields: want, filter: { logic: "and", conditions: [onOrAfter(MODIFIED, dayOf(since, tz))] } });
    for (const r of changed) {
      const at = cellTime(r[MODIFIED], tz);
      if (at == null || at >= since) cache!.rows[r.record_id] = r;
    }
    save(file, { ...cache!, readAt: now });
    return Object.values(cache!.rows);
  }

  const all = await base.records(table, { fields: want });
  // Feishu ignores an unknown field name instead of failing, so check the modified time actually came back.
  const hasModified = all.length === 0 || all.some((r) => MODIFIED in r);
  if (hasModified) save(file, { fields: want, readAt: now, fullAt: now, rows: Object.fromEntries(all.map((r) => [r.record_id, r])) });
  return all;
}

function save(file: string, data: CacheFile): void {
  // Write then rename, so a run killed mid-write leaves the previous copy rather than half a file.
  writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
