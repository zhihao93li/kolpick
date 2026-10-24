import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { isApproved, sendApproved } from "../../src/kolops/send.js";
import { LarkError } from "../../src/kolops/lark.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";
import { TABLES } from "../../src/kolops/schema.js";
import type { Config } from "../../src/kolops/config.js";

const T = TABLES;
let cfg: Config;

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
  cfg = seedProject(lark);
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
    lark.table(T.settings)[0]["暂停所有发送"] = true;
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

describe("sending across the team", () => {
  it("waits while another computer's run is sending, unless that run is long dead", async () => {
    review();
    const other = lark.add(T.runs, { 运行: "催信和结案（同事）", 结果: ["进行中"], 开始时间: Date.now() - 5 * 60_000 });
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.sent).toHaveLength(0);
    expect(r.skipped[0].reason).toMatch(/正在发信/);
    expect(lark.sent).toHaveLength(0);

    lark.table(T.runs).find((x) => x.record_id === other)!["开始时间"] = Date.now() - 2 * 3600_000;
    const later = await sendApproved(ctx, { dryRun: false });
    expect(later.sent).toHaveLength(1);
  });

  it("retries Feishu's concurrent-draft conflict, which never sends anything", async () => {
    review();
    lark.failSend = new LarkError('lark-cli mail +reply 失败：{"code":1236006,"msg":"failed to create draft: Concurrent write conflict"}', true);
    lark.failSendTimes = 2;
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.failed).toHaveLength(0);
    expect(r.sent).toHaveLength(1);
    expect(lark.sent).toHaveLength(1);
  });

  it("gives up on the conflict after a few tries and says so", async () => {
    review();
    lark.failSend = new LarkError('lark-cli mail +reply 失败：{"code":1236006}', true);
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.sent).toHaveLength(0);
    expect(r.failed[0].reason).toMatch(/1236006/);
  });
});

describe("bounce-rate gate", () => {
  const today = () => `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)} 09:00`;
  function history(sent: number, bounced: number) {
    for (let i = 0; i < sent; i++) lark.add(T.contacts, { 方向: ["发出"], 渠道: ["hello@tafu.me"], 日期: today(), 摘要: "[邀约] x", KOL: [{ id: `old${i}` }] });
    for (let i = 0; i < bounced; i++) lark.add(T.contacts, { 方向: ["收到"], 渠道: ["hello@tafu.me"], 日期: today(), 摘要: `[退信] x${i}@example.com` });
  }

  it("stops a mailbox whose recent bounces reach its line", async () => {
    history(20, 2); // 10% against the 6% line
    review();
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.sent).toHaveLength(0);
    expect(r.skipped[0].reason).toMatch(/退信率 10\.0%.*暂停线 6%/);
  });

  it("lets it send below the line, or before there's enough history to judge", async () => {
    history(10, 3); // 30%, but only 10 sent
    review();
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.sent).toHaveLength(1);
  });
});

describe("reply subjects", () => {
  it("strip stacked reply prefixes in any language and add one plain Re:", async () => {
    const { replySubject } = await import("../../src/kolops/mail.js");
    expect(replySubject("Re: 回复：RE：想送 Emma 一份合盤")).toBe("Re: 想送 Emma 一份合盤");
    expect(replySubject("合作")).toBe("Re: 合作");
  });

  it("an approved reply without its own subject goes out as Re: of the KOL's mail, in its thread", async () => {
    review();
    await sendApproved(ctx, { dryRun: false });
    const args = lark.sent[0].args;
    expect(args).toContain("+reply");
    expect(args[args.indexOf("--message-id") + 1]).toBe("in1");
    expect(args[args.indexOf("--subject") + 1]).toBe("Re: 合作");
  });
});
