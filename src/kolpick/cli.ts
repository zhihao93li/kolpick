#!/usr/bin/env node
/**
 * kolpick command line. The same tools the MCP server offers, plus setup, migration and import.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { databaseUrl, home, loadConfig, saveConfig } from "./config.js";
import { connect, migrate } from "./db/db.js";
import { exportBase } from "./importer/export.js";
import { importSnapshot, projectCounts } from "./importer/import.js";

const HELP = `kolpick <命令>

  db migrate                      建表 / 升级当前数据库
  db use test|prod                切换当前数据库
  import export <飞书 base> [目录]  把旧飞书表导出成本机快照
  import load <目录> [--project tafu] [--keep-mailboxes]
                                  把快照导入当前数据库（可重复跑；测试库默认停用所有发信邮箱）
  import counts [--project tafu]  数各类条数
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<void> {
  const [group, cmd, ...rest] = argv;
  const cfg = loadConfig();
  const project = flag(rest, "--project") ?? cfg.project;
  if (group === "db" && cmd === "use") {
    if (rest[0] !== "test" && rest[0] !== "prod") throw new Error("用法：kolpick db use test|prod");
    cfg.env = rest[0];
    saveConfig(cfg);
    console.log(`当前数据库：${cfg.env}`);
    return;
  }
  if (group === "import" && cmd === "export") {
    const dir = rest[1] ?? join(home(), "snapshots", `feishu-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`);
    await exportBase(rest[0], dir);
    console.log(`已导出到 ${dir}`);
    return;
  }
  if (group === "db" && cmd === "migrate") {
    const db = connect(databaseUrl(cfg));
    try {
      console.log(`[${cfg.env}] 新执行迁移 ${await migrate(db)} 个`);
    } finally {
      await db.end();
    }
    return;
  }
  if (group === "import" && (cmd === "load" || cmd === "counts")) {
    const db = connect(databaseUrl(cfg));
    try {
      if (cmd === "load") {
        const dir = rest[0]?.replace(/^~/, homedir());
        if (!dir) throw new Error("用法：kolpick import load <快照目录>");
        await migrate(db);
        const keep = rest.includes("--keep-mailboxes");
        if (keep && cfg.env === "test") throw new Error("测试库不保留发信邮箱");
        await importSnapshot(db, dir, { project, disableMailboxes: !keep, log: (l) => console.log(l) });
      }
      console.log(`[${cfg.env}] ${project}：`, await projectCounts(db, project));
    } finally {
      await db.end();
    }
    return;
  }
  console.log(HELP);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
