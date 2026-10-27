import postgres from "postgres";
import { MIGRATIONS } from "./migrations.js";

/** The little kolpick needs from a Postgres driver; the app uses `postgres`, tests use PGlite. */
export interface Db {
  query<T = any>(text: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (q: Db) => Promise<T>): Promise<T>;
  exec(text: string): Promise<void>;
  end(): Promise<void>;
}

export function connect(url: string): Db {
  const sql = postgres(url, { max: 4, onnotice: () => {}, connect_timeout: 15, types: { bigint: postgres.BigInt } as any });
  const wrap = (q: any): Db => ({
    query: async (text, params = []) => [...(await q.unsafe(text, params as any[]))] as any[],
    tx: (fn) => (q === sql ? sql.begin((t) => fn(wrap(t))) : fn(wrap(q))) as any,
    exec: async (text) => void (await q.unsafe(text)),
    end: () => sql.end({ timeout: 5 }),
  });
  return wrap(sql);
}

/** Brings the database up to the latest migration. Safe to run every start. */
export async function migrate(db: Db): Promise<number> {
  await db.exec("create table if not exists schema_migrations (version int primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query<{ version: number }>("select version from schema_migrations")).map((r) => Number(r.version)));
  let applied = 0;
  for (const [i, sql] of MIGRATIONS.entries()) {
    const version = i + 1;
    if (done.has(version)) continue;
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query("insert into schema_migrations (version) values ($1)", [version]);
    });
    applied++;
  }
  return applied;
}

export async function one<T = any>(db: Db, text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await db.query<T>(text, params))[0];
}
