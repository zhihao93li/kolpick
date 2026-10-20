import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { connect, migrate } from "./db.js";
import { startQueue } from "./jobs.js";
import { createApp } from "./web/app.js";

// One process serves the website and runs the background jobs (Zeabur: one app service + PostgreSQL).
const cfg = loadConfig();
if (!cfg.adminPasswordHash && !cfg.adminPassword) throw new Error("缺少环境变量 ADMIN_PASSWORD_HASH（或本地用的 ADMIN_PASSWORD）");
const sql = connect(cfg.databaseUrl);
const applied = await migrate(sql);
if (applied.length) console.log("migrations applied:", applied.join(", "));
const queue = await startQueue(sql, cfg);
const server = serve({ fetch: createApp(sql, cfg, queue).fetch, port: cfg.port }, (info) =>
  console.log(`listening on :${info.port}`));

async function shutdown() {
  server.close();
  // Running jobs are picked up again after restart; finished Apify runs are not paid for twice.
  await queue.stop();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
