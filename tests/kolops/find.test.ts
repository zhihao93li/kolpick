import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { find, type FindOpts } from "../../src/kolops/find.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

let lark: FakeLark;
let ctx: Ctx;
const opts = (over: Partial<FindOpts> = {}): FindOpts => ({
  platform: "instagram", keywords: ["伴侶", "感情"], seeds: ["love.notes.tw"], handles: [], minFollowers: null, maxFollowers: null,
  budget: 5, batch: "第三十批", job: "t", youtubeHidden: false, dryRun: true, ...over,
});

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-find-"));
  lark = new FakeLark();
  ctx = makeCtx(seedProject(lark), lark, { id: "ou", name: "测试" }, "找 KOL", false, async () => {});
});

it("shares a target out over the keywords and seed accounts", async () => {
  const r: any = await find(ctx, opts({ target: 150 }));
  expect(r.参数).toMatchObject({ perKeyword: 50, perSeed: 50 });
});

it("refuses a batch the base doesn't have unless told to add it", async () => {
  await expect(find(ctx, opts({ batch: "第四十一批" }))).rejects.toThrow("--add-batch");
  const r: any = await find(ctx, opts({ batch: "第四十一批", addBatch: true }));
  expect(r.会新加入库批次).toBe("第四十一批");
});
