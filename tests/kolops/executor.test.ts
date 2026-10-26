import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../src/kolops/config.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { ExecutorBusy, ExecutorLock, lockHolder, machine, notExecutor } from "../../src/kolops/executor.js";
import { stamp } from "../../src/kolops/ops.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { sendApproved } from "../../src/kolops/send.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

let dir = "";
let lark: FakeLark;
let cfg: Config;
let ctx: Ctx;
let fid = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kol-exec-"));
  process.env.KOL_DATA_DIR = dir;
  lark = new FakeLark();
  cfg = seedProject(lark);
  const pid = lark.add(T.profiles, { 账号名称: "安安", 公开邮箱: "anan@example.com", 联系许可: ["可联系"] });
  fid = lark.add(T.followups, { 账号名称: "安安", 档案: [{ id: pid }], 阶段: ["已回复"], 联系渠道: ["hello@tafu.me"] });
  ctx = makeCtx(cfg, lark, { id: "ou", name: "测试运营" }, "测试", false, async () => {});
});

function review(fields: Record<string, any> = {}): string {
  return lark.add(T.reviews, {
    状态: ["待你审核"], 类型: ["回复邮件"], 处理: ["发／同意"], 发送渠道: ["hello@tafu.me"],
    收件人: "anan@example.com", 邮件草稿: "主题：合作\n安安您好", KOL: [{ id: fid }], 审核项: "安安的回信", ...fields,
  });
}

describe("the executor lock", () => {
  it("lets one run in at a time and frees the lock when it ends", async () => {
    const lock = await ExecutorLock.acquire("发出已批准的信");
    expect(lockHolder()?.what).toBe("发出已批准的信");
    await expect(ExecutorLock.acquire("收信同步", { waitMs: 0 })).rejects.toThrow(ExecutorBusy);
    lock.release();
    expect(lockHolder()).toBeNull();
    await expect(ExecutorLock.run("收信同步", async () => "ok")).resolves.toBe("ok");
  });

  it("takes over a lock whose run died", async () => {
    writeFileSync(join(dir, "executor.lock"), JSON.stringify({ pid: 999_999_999, machine: "x", what: "旧的", since: 0, beat: Date.now() }));
    expect(lockHolder()).toBeNull();
    const lock = await ExecutorLock.acquire("新的", { waitMs: 0 });
    expect(lockHolder()?.what).toBe("新的");
    lock.release();
  });

  it("waits for the holder to finish", async () => {
    const first = await ExecutorLock.acquire("先来的");
    let slept = 0;
    const second = ExecutorLock.acquire("后来的", { waitMs: 60_000, sleep: async () => { slept++; first.release(); } });
    await expect(second).resolves.toBeInstanceOf(ExecutorLock);
    expect(slept).toBe(1);
    (await second).release();
  });
});

describe("the executing computer", () => {
  it("lets any computer run while 设置.执行电脑 is empty, and only the named one after", () => {
    const me = machine();
    expect(notExecutor({ ...cfg, executor: "" })).toBe("");
    expect(notExecutor({ ...cfg, executor: `我的电脑（${me.id}）` })).toBe("");
    expect(notExecutor({ ...cfg, executor: "运营电脑（abcd1234）" })).toContain("不是这个项目的执行电脑");
  });
});

describe("carrying out approved items", () => {
  it("marks an item 执行中 before sending and 已执行 after", async () => {
    const rid = review();
    const seen: string[] = [];
    const orig = lark.json.bind(lark);
    lark.json = async (args: string[]) => {
      if (args[1] === "+reply" || args[1] === "+send") seen.push(String(lark.table(T.reviews).find((r) => r.record_id === rid)!["执行结果"]));
      return orig(args);
    };
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.sent).toHaveLength(1);
    expect(seen[0]).toMatch(/^执行中（/);
    expect(lark.table(T.reviews).find((x) => x.record_id === rid)!["状态"]).toEqual(["已执行"]);
  });

  it("leaves an item another run is carrying out right now", async () => {
    review({ 状态: ["待执行"], 执行结果: "执行中（别的电脑（x））", 执行时间: stamp(Date.now()) });
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.sent).toHaveLength(0);
    expect(r.skipped[0].reason).toContain("另一处正在执行");
    expect(lark.sent).toHaveLength(0);
  });

  it("never repeats an item whose run died midway", async () => {
    const rid = review({ 状态: ["待执行"], 执行结果: "执行中（别的电脑（x））", 执行时间: stamp(Date.now() - 3600_000) });
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.failed[0].reason).toContain("中断");
    expect(lark.sent).toHaveLength(0);
    expect(lark.table(T.reviews).find((x) => x.record_id === rid)!["状态"]).toEqual(["执行失败"]);
  });

  it("stops midway when the pause switch is ticked", async () => {
    review({ 审核项: "第一封" });
    review({ 审核项: "第二封" });
    const orig = lark.json.bind(lark);
    lark.json = async (args: string[]) => {
      const out = await orig(args);
      if (args[1] === "+reply" || args[1] === "+send") lark.table(T.settings)[0]["暂停所有发送"] = true;
      return out;
    };
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.sent).toHaveLength(1);
    expect(r.skipped.map((s) => s.reason)).toContainEqual(expect.stringContaining("暂停所有发送"));
  });
});
