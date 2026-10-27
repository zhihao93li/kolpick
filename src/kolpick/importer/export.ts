/**
 * Dumps the old Feishu base to a folder of JSON files (one per table: field definitions + every record), so the
 * importer can run against the same snapshot as many times as needed. Usage: kolpick import export <base> <dir>
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LarkCli, matrixRows } from "../../kolops/lark.js";

export const FEISHU_TABLES = ["KOL 档案", "KOL 跟进", "接触记录", "发布内容", "审核队列", "运行记录", "操作日志", "设置", "发信邮箱", "模板"];

export async function exportBase(baseToken: string, dir: string, log = console.log): Promise<void> {
  const lark = new LarkCli(baseToken);
  await mkdir(dir, { recursive: true });
  const list = await lark.json(["base", "+table-list", "--base-token", baseToken, "--as", "user"]);
  for (const name of FEISHU_TABLES) {
    const table = list.tables.find((t: any) => t.name === name);
    if (!table) throw new Error(`飞书表里没有「${name}」`);
    const fields = await lark.json(["base", "+field-list", "--base-token", baseToken, "--table-id", table.id, "--format", "json", "--as", "user"]);
    const rows = [];
    for (let offset = 0; ; offset += 200) {
      const page = await lark.json(["base", "+record-list", "--base-token", baseToken, "--table-id", table.id,
        "--format", "json", "--limit", "200", "--offset", String(offset), "--as", "user"]);
      rows.push(...matrixRows(page));
      if (!page?.has_more) break;
    }
    await writeFile(path.join(dir, `${name}.json`), JSON.stringify({ table: name, tableId: table.id, fields, rows }));
    log(`${name}: ${rows.length} 条`);
  }
  await writeFile(path.join(dir, "exported-at.txt"), new Date().toISOString());
}

if (process.argv[1]?.endsWith("export.ts")) {
  exportBase(process.argv[2], process.argv[3]).catch((e) => { console.error(e); process.exit(1); });
}
