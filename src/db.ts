import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export type Sql = postgres.Sql;

export function connect(url: string): Sql {
  return postgres(url, { max: 10, onnotice: () => {} });
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Apply migrations/*.sql in name order, each once, inside a transaction. */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const body = readFileSync(join(dir, name), "utf8");
    await sql.begin(async (tx) => {
      // Serialize concurrent starts (two app instances deploying at once).
      await tx`SELECT pg_advisory_xact_lock(727274)`;
      const [again] = await tx`SELECT 1 FROM schema_migrations WHERE name = ${name}`;
      if (again) return;
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
      applied.push(name);
    });
  }
  return applied;
}
