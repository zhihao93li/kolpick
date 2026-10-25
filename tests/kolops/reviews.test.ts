import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { applyRevisions, reviewState, toRevise } from "../../src/kolops/reviews.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { sendApproved } from "../../src/kolops/send.js";
import { todayLists } from "../../src/kolops/today.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

let lark: FakeLark;
let ctx: Ctx;
let wrote: string, waiting: string;
const dir = () => mkdtempSync(join(tmpdir(), "kol-test-"));

function review(fid: string, fields: Record<string, unknown>) {
  return lark.add(T.reviews, { 状态: ["待你审核"], 类型: ["回复邮件"], 发送渠道: ["hello@tafu.me"], KOL: [{ id: fid }], 审核项: "回复", 邮件草稿: "您好", ...fields });
}

beforeEach(() => {
  process.env.KOL_DATA_DIR = dir();
  lark = new FakeLark();
  const cfg = seedProject(lark);
  const p1 = lark.add(T.profiles, { 账号名称: "来信的", 公开邮箱: "a@example.com", 联系许可: ["可联系"] });
  const p2 = lark.add(T.profiles, { 账号名称: "等回的", 公开邮箱: "b@example.com", 联系许可: ["可联系"] });
  // 来信的 wrote last; 等回的 was nudged by us last.
  wrote = lark.add(T.followups, { 账号名称: "来信的", 档案: [{ id: p1 }], 阶段: ["已回复"], 当前轮到谁: ["等你审核"], 最后来信日期: "2026-10-24 10:00", 最近联系日期: "2026-10-20 10:00" });
  waiting = lark.add(T.followups, { 账号名称: "等回的", 档案: [{ id: p2 }], 阶段: ["体验中"], 当前轮到谁: ["等你审核"], 最后来信日期: "2026-10-10 10:00", 最近联系日期: "2026-10-12 10:00" });
  ctx = makeCtx(cfg, lark, { id: "ou", name: "测试" }, "测试", false, async () => {});
});

it("reads 处理 first and the older 审核结果 after", () => {
  expect(reviewState({ record_id: "r", 处理: ["发／同意"] })).toBe("approved");
  expect(reviewState({ record_id: "r", 处理: ["改"] })).toBe("revise");
  expect(reviewState({ record_id: "r", 审核结果: ["退回修改"] })).toBe("revise");
  expect(reviewState({ record_id: "r", 处理: ["发／同意"], 审核结果: ["先不发"] })).toBe("declined");
  expect(reviewState({ record_id: "r" })).toBe("pending");
});

it("withdraws 不发 items and hands their KOLs back", async () => {
  const a = review(wrote, { 处理: ["不发"], 你的意见: "先不回" });
  const b = review(waiting, { 处理: ["不发"], 审核项: "[体验未用] 等回的 x" });
  const r = await sendApproved(ctx, { dryRun: false });
  expect(r.withdrawn.sort()).toEqual(["来信的", "等回的"].sort());
  expect(lark.sent).toHaveLength(0);
  const rows = lark.table(T.reviews);
  expect(rows.find((x) => x.record_id === a)).toMatchObject({ 状态: ["已撤回"], 执行结果: "审核选了不发，没有发出（先不回）" });
  expect(rows.find((x) => x.record_id === b)!["状态"]).toEqual(["已撤回"]);
  const f = (id: string) => lark.table(T.followups).find((x) => x.record_id === id)!;
  expect(f(wrote)["当前轮到谁"]).toEqual(["无需动作"]);
  expect(f(waiting)["当前轮到谁"]).toEqual(["KOL"]);
});

it("leaves a KOL waiting on review while another item for them is still open", async () => {
  review(wrote, { 处理: ["不发"] });
  review(wrote, {});
  await sendApproved(ctx, { dryRun: false });
  expect(lark.table(T.followups).find((x) => x.record_id === wrote)!["当前轮到谁"]).toEqual(["等你审核"]);
});

it("lists 改 items with the reviewer's words and sends the rewrite back for review", async () => {
  const rid = review(wrote, { 处理: ["改"], 你的意见: "语气再软一点", 我的判断和建议: "对方问价格" });
  const today = await todayLists(ctx);
  expect(today.要改.map((x) => x.意见)).toEqual(["语气再软一点"]);
  expect(today.等你审核).toEqual([]);
  expect((await toRevise(ctx)).要改[0]).toMatchObject({ review: rid, 意见: "语气再软一点", 草稿: "您好" });

  const file = join(dir(), "r.json");
  writeFileSync(file, JSON.stringify([{ review: rid, draft: "您好呀，", note: "开头改软" }]));
  expect((await applyRevisions(ctx, { file, dryRun: false })).写入).toBe(1);
  const r = lark.table(T.reviews).find((x) => x.record_id === rid)!;
  expect(r).toMatchObject({ 邮件草稿: "您好呀，", 处理: null, 你的意见: "", 状态: ["待你审核"] });
  expect(r["我的判断和建议"]).toMatch(/对方问价格\n.* 按意见改：语气再软一点 → 开头改软/);
  expect(reviewState(r)).toBe("pending");

  // Not a 改 item any more: a second submit is refused and changes nothing.
  expect((await applyRevisions(ctx, { file, dryRun: false })).问题).toHaveLength(1);
});

it("refuses a rewrite that drops the code placeholder", async () => {
  const rid = review(wrote, { 处理: ["改"], 体验码动作: ["发码"], 体验码: "abc", 邮件草稿: "碼 {體驗碼}" });
  const file = join(dir(), "r.json");
  writeFileSync(file, JSON.stringify([{ review: rid, draft: "沒有碼了" }]));
  const r = await applyRevisions(ctx, { file, dryRun: false });
  expect(r.问题![0]).toMatch(/\{體驗碼\}/);
  expect(lark.table(T.reviews).find((x) => x.record_id === rid)!["邮件草稿"]).toBe("碼 {體驗碼}");
});
