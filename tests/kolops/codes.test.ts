import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { syncCodes } from "../../src/kolops/codes.js";
import type { Config } from "../../src/kolops/config.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { addProject, setDataApiKey } from "../../src/kolops/projects.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { FakeLark } from "./fake.js";
import { BASE, seedProject } from "./project.js";

let lark: FakeLark;
let cfg: Config;
let ctx: Ctx;
let trial: string;
const requests: { auth: string; body: any }[] = [];
const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();

const api = (async (_url: string, init: any) => {
  const body = JSON.parse(init.body);
  requests.push({ auth: init.headers.Authorization, body });
  return new Response(JSON.stringify({ codes: [
    { code: "DEER3", found: true, kind: "trial", active: true, maxUses: 3, used: 1, expiresAt: inTwoDays },
    { code: "AMY-TAFU", found: true, kind: "partner", active: true, maxUses: null, used: 42, paidOrders: 40, refundedOrders: 2, visitors: 1830 },
    { code: "GONE", found: false },
  ] }));
}) as typeof fetch;

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  requests.length = 0;
  lark = new FakeLark();
  cfg = { ...seedProject(lark), dataApi: "https://api.example.com/api/kol-data/" };
  const p = lark.add(T.profiles, { 账号名称: "小鹿與阿哲" });
  trial = lark.add(T.followups, { 账号名称: "小鹿與阿哲", 档案: [{ id: p }], 阶段: ["体验中"], 体验码: "deer3", 体验码已用: 0 });
  lark.add(T.followups, { 账号名称: "Amy", 阶段: ["合作中"], 活动码: "AMY-TAFU" });
  lark.add(T.followups, { 账号名称: "已结案", 阶段: ["结案"], 体验码: "OLD" });
  lark.add(T.followups, { 账号名称: "打错码", 阶段: ["体验中"], 体验码: "GONE" });
  ctx = makeCtx(cfg, lark, { id: "ou", name: "测试" }, "体验码同步", true, async () => {});
});

it("needs the API address in 设置 and a key on this computer", async () => {
  await expect(syncCodes({ ...ctx, cfg: { ...cfg, dataApi: "" } }, { dryRun: true, fetchImpl: api })).rejects.toThrow(/业务数据接口/);
  await expect(syncCodes(ctx, { dryRun: true, fetchImpl: api })).rejects.toThrow(/project set-key/);
});

it("refreshes trial usage and expiry, and lists partial use, expiring trials and partner codes", async () => {
  addProject("测试项目", BASE);
  setDataApiKey("测试项目", "secret-key");
  const r = await syncCodes(ctx, { dryRun: false, fetchImpl: api });
  expect(requests[0].auth).toBe("Bearer secret-key");
  expect(requests[0].body.codes.sort()).toEqual(["AMY-TAFU", "GONE", "deer3"]);
  expect(lark.table(T.followups).find((f) => f.record_id === trial)).toMatchObject({ 体验码已用: 1, 体验码上限: 3 });
  expect(lark.table(T.followups).find((f) => f.record_id === trial)!["体验码到期"]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  expect(r.体验码用了一部分).toEqual([{ name: "小鹿與阿哲", 体验码: "deer3", 已用: 1, 上限: 3 }]);
  expect(r.体验码三天内到期.map((x) => x.name)).toEqual(["小鹿與阿哲"]);
  expect(r.活动码).toEqual([{ name: "Amy", 活动码: "AMY-TAFU", 付款订单: 40, 退款订单: 2, 访客: 1830 }]);
  expect(r.找不到的码).toEqual(["打错码：GONE"]);
});

it("keeps a trial and a partner code with the same name apart", async () => {
  addProject("测试项目", BASE);
  setDataApiKey("测试项目", "k");
  lark.add(T.followups, { 账号名称: "同名", 阶段: ["体验中"], 体验码: "SAME", 活动码: "same" });
  const both = (async () => new Response(JSON.stringify({ codes: [
    { code: "SAME", found: true, kind: "trial", maxUses: 3, used: 2, expiresAt: null },
    { code: "same", found: true, kind: "partner", maxUses: null, used: 9, paidOrders: 9, refundedOrders: 0, visitors: 50 },
  ] }))) as typeof fetch;
  const r = await syncCodes(ctx, { dryRun: true, fetchImpl: both });
  expect(r.体验码用了一部分).toEqual([{ name: "同名", 体验码: "SAME", 已用: 2, 上限: 3 }]);
  expect(r.活动码).toEqual([{ name: "同名", 活动码: "same", 付款订单: 9, 退款订单: 0, 访客: 50 }]);
});

it("tells whether a trial code name is free; a partner code of the same name doesn't block it", async () => {
  const { checkTrialName } = await import("../../src/kolops/codes.js");
  addProject("测试项目", BASE);
  setDataApiKey("测试项目", "k");
  const api = (async (_u: string, init: any) => {
    const code = JSON.parse(init.body).codes[0];
    const rows = code === "deer3" ? [{ code: "DEER3", found: true, kind: "trial", used: 1 }] : [{ code, found: true, kind: "partner", used: 4 }];
    return new Response(JSON.stringify({ codes: rows }));
  }) as typeof fetch;
  expect(await checkTrialName(ctx, "deer3", api)).toMatchObject({ 可用: false, 原因: "已经有这个码（体验码，用了 1 次）" });
  expect(await checkTrialName(ctx, "amy-tafu", api)).toEqual({ 码名: "amy-tafu", 可用: true });
});
