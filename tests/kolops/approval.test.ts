import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../src/kolops/config.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { approveInConsole, fingerprint } from "../../src/kolops/reviews.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { sendApproved } from "../../src/kolops/send.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

let lark: FakeLark;
let cfg: Config;
let fid = "";

function ctxWith(over: Partial<Config> = {}): Ctx {
  return makeCtx({ ...cfg, ...over }, lark, { id: "ou", name: "林运营" }, "测试", false, async () => {});
}

function review(fields: Record<string, any> = {}): string {
  return lark.add(T.reviews, {
    状态: ["待你审核"], 类型: ["回复邮件"], 发送渠道: ["hello@tafu.me"], 收件人: "anan@example.com",
    邮件草稿: "主题：合作\n安安您好", KOL: [{ id: fid }], 审核项: "安安的回信", ...fields,
  });
}
const row = (id: string) => lark.table(T.reviews).find((r) => r.record_id === id)!;

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-approval-"));
  lark = new FakeLark();
  cfg = seedProject(lark);
  const pid = lark.add(T.profiles, { 账号名称: "安安", 公开邮箱: "anan@example.com", 联系许可: ["可联系"] });
  fid = lark.add(T.followups, { 账号名称: "安安", 档案: [{ id: pid }], 阶段: ["已回复"], 联系渠道: ["hello@tafu.me"] });
});

describe("approving in the console", () => {
  it("records who approved what, applying their last edits first", async () => {
    const id = review();
    await approveInConsole(ctxWith(), id, { 邮件草稿: "主题：合作\n安安您好，改过的" });
    const r = row(id);
    expect(r).toMatchObject({ 处理: ["发／同意"], 同意来源: "决策台", 同意人: "林运营", 邮件草稿: "主题：合作\n安安您好，改过的" });
    expect(r["内容指纹"]).toBe(fingerprint(r));
    expect((await sendApproved(ctxWith(), { dryRun: false })).sent).toHaveLength(1);
  });

  it("refuses an item that is already done", async () => {
    const id = review({ 状态: ["已执行"] });
    await expect(approveInConsole(ctxWith(), id)).rejects.toThrow("不能再同意");
  });
});

describe("carrying out only what was approved", () => {
  it("S-R10 sends back an item edited after approval instead of sending the new text", async () => {
    const id = review();
    await approveInConsole(ctxWith(), id);
    row(id)["邮件草稿"] = "主题：合作\n有人在飞书里改了这句";
    const r = await sendApproved(ctxWith(), { dryRun: false });
    expect(r.sent).toHaveLength(0);
    expect(lark.sent).toHaveLength(0);
    expect(row(id)).toMatchObject({ 处理: null, 同意来源: "", 状态: ["待你审核"] });
    expect(row(id)["执行结果"]).toContain("同意之后内容被改过");
  });

  it("S-R19 once only console approvals count, ignores an item approved in Feishu", async () => {
    const feishu = review({ 处理: ["发／同意"], 审核项: "飞书里批的" });
    const consoleId = review({ 审核项: "决策台批的" });
    await approveInConsole(ctxWith(), consoleId);
    const r = await sendApproved(ctxWith({ consoleOnlyApprovals: true }), { dryRun: false });
    expect(r.sent).toHaveLength(1);
    expect(r.skipped.find((s) => s.key === feishu)?.reason).toContain("只认决策台");
    expect(row(feishu)["状态"]).toEqual(["待你审核"]);
  });

  it("still carries out Feishu approvals before the switch is ticked", async () => {
    review({ 处理: ["发／同意"] });
    expect((await sendApproved(ctxWith(), { dryRun: false })).sent).toHaveLength(1);
  });
});
