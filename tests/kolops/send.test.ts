import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/kolops/config.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { isApproved, sendApproved } from "../../src/kolops/send.js";
import { FakeLark } from "./fake.js";

const cfg = loadConfig(join(import.meta.dirname, "../../plugins/kol-ops"));
const T = cfg.tables;

let lark: FakeLark;
let ctx: Ctx;
let fid: string;

function review(fields: Record<string, any> = {}): string {
  return lark.add(T.reviews, {
    状态: ["待你审核"], 类型: ["回复邮件"], 处理: ["发／同意"], 确认发出: true, 发送渠道: ["hello@tafu.me"],
    收件人: "anan@example.com", 邮件草稿: "呂爸您好，\n\n当然可以。", KOL: [{ id: fid }], 审核项: "安安的回信", ...fields,
  });
}

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  lark = new FakeLark();
  lark.add(T.control, { 暂停所有发送: false });
  const pid = lark.add(T.profiles, { 账号名称: "安安媽咪日常", 公开邮箱: "anan@example.com", 联系许可: ["可联系"] });
  fid = lark.add(T.followups, { 账号名称: "安安媽咪日常", 档案: [{ id: pid }], 阶段: ["已回复"], 联系渠道: ["hello@tafu.me"] });
  lark.inbox["hello@tafu.me"] = [{ message_id: "in1", from: "呂爸 <anan@example.com>", subject: "合作", date: "2026-10-20T22:14:00+08:00" }];
  ctx = makeCtx(cfg, lark, { id: "ou_me", name: "测试运营" }, "测试", false, async () => {});
});

describe("isApproved", () => {
  it("needs a yes and the 确认发出 tick, and any no wins", () => {
    expect(isApproved({ record_id: "a", 处理: ["发／同意"], 确认发出: true })).toBe(true);
    expect(isApproved({ record_id: "a", 处理: ["发／同意"], 确认发出: false })).toBe(false);
    expect(isApproved({ record_id: "a", 审核结果: ["确认发送"], 确认发出: true })).toBe(true);
    expect(isApproved({ record_id: "a", 处理: ["发／同意"], 审核结果: ["先不发"], 确认发出: true })).toBe(false);
  });
});

describe("sendApproved", () => {
  it("replies in the KOL's thread and writes the result back", async () => {
    const rid = review();
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.sent).toHaveLength(1);
    expect(lark.sent[0].args).toContain("+reply");
    expect(lark.sent[0].args).toContain("in1");
    const rev = lark.table(T.reviews).find((x) => x.record_id === rid)!;
    expect(rev["状态"]).toEqual(["已执行"]);
    const contact = lark.table(T.contacts)[0];
    expect(contact["方向"]).toEqual(["发出"]);
    expect(contact["KOL"]).toEqual([{ id: fid }]);
    expect(lark.table(T.followups)[0]["当前轮到谁"]).toEqual(["KOL"]);
  });

  it("dry run sends nothing and changes nothing", async () => {
    review();
    const r = await sendApproved(ctx, { dryRun: true });
    expect(r.sent).toHaveLength(1);
    expect(lark.sent).toHaveLength(0);
    expect(lark.table(T.contacts)).toHaveLength(0);
  });

  it("never sends to a do-not-contact KOL", async () => {
    lark.table(T.profiles)[0]["联系许可"] = ["永不联系"];
    review();
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.sent).toHaveLength(0);
    expect(r.skipped[0].reason).toMatch(/永不联系/);
    expect(lark.sent).toHaveLength(0);
  });

  it("refuses a recipient that isn't the KOL's", async () => {
    review({ 收件人: "someone@else.com" });
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.skipped[0].reason).toMatch(/不是这位 KOL/);
  });

  it("stops everything when the pause switch is on", async () => {
    lark.table(T.control)[0]["暂停所有发送"] = true;
    review();
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.sent).toHaveLength(0);
    expect(r.skipped[0].reason).toMatch(/暂停/);
  });

  it("does not send the same approval twice", async () => {
    review();
    await sendApproved(ctx, { dryRun: false });
    // Pretend the write-back of 状态 was lost.
    lark.table(T.reviews)[0]["状态"] = ["待执行"];
    const again = await sendApproved(ctx, { dryRun: false });
    expect(again.sent).toHaveLength(0);
    expect(lark.sent).toHaveLength(1);
  });

  it("an interrupted send is reported, not retried", async () => {
    review();
    lark.failSend = new Error("socket hang up");
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.failed[0].reason).toMatch(/结果不明/);
    lark.failSend = null;
    lark.table(T.reviews)[0]["状态"] = ["待执行"];
    const again = await sendApproved(ctx, { dryRun: false });
    expect(again.sent).toHaveLength(0);
    expect(lark.sent).toHaveLength(0);
  });

  it("respects the mailbox's daily limit", async () => {
    const mb = cfg.mailboxes[0];
    for (let i = 0; i < mb.dailyExternal; i++) {
      lark.add(T.contacts, { 方向: ["发出"], 渠道: [mb.channel], 日期: `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)} 09:00`, KOL: [{ id: `other${i}` }] });
    }
    review();
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.skipped[0].reason).toMatch(/额度/);
  });
});
