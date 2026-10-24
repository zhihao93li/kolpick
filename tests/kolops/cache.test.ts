import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { Base } from "../../src/kolops/base.js";
import { cachedRecords } from "../../src/kolops/cache.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { FakeLark } from "./fake.js";
import { BASE } from "./project.js";

let lark: FakeLark;
let base: Base;
let reads: { filtered: boolean; rows: number }[];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kol-test-"));
  process.env.KOL_DATA_DIR = dir;
  lark = new FakeLark();
  const records = lark.records.bind(lark);
  reads = [];
  lark.records = async (table, opts = {}) => {
    const rows = await records(table, opts);
    reads.push({ filtered: Boolean(opts.filter), rows: rows.length });
    return rows;
  };
  base = new Base(lark, BASE);
  for (let i = 0; i < 5; i++) lark.add(T.profiles, { 账号: `kol${i}`, 公开邮箱: `kol${i}@example.com` });
});

const read = () => cachedRecords(base, T.profiles, ["账号", "公开邮箱"], "+08:00");
const cacheFile = () => join(dir, "cache", BASE, "KOL_档案.json");

it("reads everything once, then only what changed, and sees edits and new rows", async () => {
  expect(await read()).toHaveLength(5);
  expect(reads.at(-1)).toEqual({ filtered: false, rows: 5 });

  const first = lark.table(T.profiles)[0].record_id;
  await lark.json(["base", "+record-batch-update", "--table-id", T.profiles, "--json", JSON.stringify({ update_records: { [first]: { 公开邮箱: "new@example.com" } } })]);
  lark.add(T.profiles, { 账号: "kol5", 公开邮箱: "kol5@example.com" });

  const rows = await read();
  expect(reads.at(-1)!.filtered).toBe(true);
  expect(rows).toHaveLength(6);
  expect(rows.find((r) => r.record_id === first)!["公开邮箱"]).toBe("new@example.com");
});

it("drops rows deleted in Feishu at the next full read, at least daily", async () => {
  await read();
  lark.tables[T.profiles].splice(0, 1);
  expect(await read()).toHaveLength(5); // still cached between full reads
  const c = JSON.parse(readFileSync(cacheFile(), "utf8"));
  writeFileSync(cacheFile(), JSON.stringify({ ...c, fullAt: Date.now() - 21 * 3600_000 }));
  expect(await read()).toHaveLength(4);
  expect(reads.at(-1)!.filtered).toBe(false);
});

it("reads in full when asked for different fields, or when the table has no 更新时间", async () => {
  await read();
  await cachedRecords(base, T.profiles, ["账号"], "+08:00");
  expect(reads.at(-1)!.filtered).toBe(false);

  for (const r of lark.table(T.followups)) delete r["更新时间"];
  lark.add(T.followups, { 账号名称: "x" });
  delete lark.table(T.followups)[0]["更新时间"];
  await cachedRecords(base, T.followups, ["账号名称"], "+08:00");
  await cachedRecords(base, T.followups, ["账号名称"], "+08:00");
  expect(reads.slice(-2).map((r) => r.filtered)).toEqual([false, false]);
});
