import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startConsole } from "../../src/kolops/console/server.js";
import type { Jobs } from "../../src/kolops/console/actions.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

let lark: FakeLark;
let ctx: Ctx;
let url = "";
let close = () => {};
let jobs: Jobs;
let fid = "";
let pid = "";

const row = (table: string, id: string) => lark.table(table).find((r) => r.record_id === id)!;

async function call(path: string, body: unknown = {}, headers: Record<string, string> = { "x-kol-console": "1" }) {
  const r = await fetch(`${url}${path.slice(1)}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

async function settled() {
  for (let i = 0; i < 200 && jobs.list.some((j) => j.state === "排队中" || j.state === "进行中"); i++) await new Promise((r) => setTimeout(r, 10));
  return jobs.list[0];
}

beforeEach(async () => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-actions-"));
  lark = new FakeLark();
  const cfg = seedProject(lark);
  pid = lark.add(T.profiles, { 账号: "an", 账号名称: "安安", 公开邮箱: "anan@example.com", 联系许可: ["可联系"] });
  fid = lark.add(T.followups, { 账号名称: "安安", 档案: [{ id: pid }], 阶段: ["已回复"], 当前轮到谁: ["我们"], 联系渠道: ["hello@tafu.me"] });
  ctx = makeCtx(cfg, lark, { id: "ou", name: "林运营" }, "", false, async () => {});
  // A base set up for the console: 审核队列 and 设置 have the approval and executor fields.
  const fieldList = lark.json.bind(lark);
  lark.json = async (args: string[]) => (args[1] === "+field-list"
    ? { fields: ["同意来源", "同意人", "同意时间", "内容指纹", "执行电脑", "只认决策台的同意"].map((name) => ({ name, type: "text" })) }
    : fieldList(args));
  const started = await startConsole(ctx, { port: 0, openBrowser: false });
  url = started.url;
  jobs = started.jobs;
  close = () => { started.server.closeAllConnections(); started.server.close(); };
});
afterEach(() => close());

describe("writes from the console", () => {
  it("only accepts writes sent by its own page", async () => {
    expect((await call("/api/pause", { on: true }, {})).status).toBe(403);
    expect(lark.table(T.settings)[0]["暂停所有发送"]).toBe(false);
  });

  it("approves an item with the reviewer's edits and has the executor send it", async () => {
    const rid = lark.add(T.reviews, { 状态: ["待你审核"], 类型: ["回复邮件"], 发送渠道: ["hello@tafu.me"], 收件人: "anan@example.com",
      邮件草稿: "主题：合作\n安安您好", KOL: [{ id: fid }], 审核项: "安安的回信" });
    const r = await call("/api/approve", { id: rid, edits: { 邮件草稿: "主题：合作\n安安您好，改过", 状态: ["已执行"] } });
    expect(r.status).toBe(200);
    const job = await settled();
    expect(job).toMatchObject({ state: "做完了", note: expect.stringContaining("anan@example.com") });
    expect(row(T.reviews, rid)).toMatchObject({ 状态: ["已执行"], 同意来源: "决策台", 同意人: "林运营", 邮件草稿: "主题：合作\n安安您好，改过" });
    expect(lark.table(T.runs).at(-1)).toMatchObject({ 结果: ["完成"] });
  });

  it("fails the job, not the approval, on a computer that isn't the executor", async () => {
    lark.table(T.settings)[0]["执行电脑"] = "别的电脑（zzzz9999）";
    const rid = lark.add(T.reviews, { 状态: ["待你审核"], 类型: ["回复邮件"], 发送渠道: ["hello@tafu.me"], 收件人: "anan@example.com", 邮件草稿: "安安您好", KOL: [{ id: fid }] });
    await call("/api/approve", { id: rid });
    expect(await settled()).toMatchObject({ state: "没做成", note: expect.stringContaining("不是这个项目的执行电脑") });
    expect(lark.sent).toHaveLength(0);
    expect(row(T.reviews, rid)["同意来源"]).toBe("决策台");
  });

  it("sends an item back to Claude, or drops it", async () => {
    const a = lark.add(T.reviews, { 状态: ["待你审核"], 类型: ["回复邮件"], KOL: [{ id: fid }] });
    const b = lark.add(T.reviews, { 状态: ["待你审核"], 类型: ["回复邮件"], KOL: [{ id: fid }] });
    await call("/api/revise", { id: a, note: "语气轻一点" });
    await call("/api/drop", { id: b, note: "" });
    expect(row(T.reviews, a)).toMatchObject({ 处理: ["改"], 你的意见: "语气轻一点" });
    expect(row(T.reviews, b)).toMatchObject({ 处理: ["不发"], 状态: ["已撤回"] });
  });

  it("files mail as handled, or closes the KOL for good", async () => {
    const m1 = lark.add(T.contacts, { 方向: ["收到"], 待处理: true, KOL: [{ id: fid }] });
    const m2 = lark.add(T.contacts, { 方向: ["收到"], 待处理: true, KOL: [{ id: fid }] });
    await call("/api/mail-done", { id: m1 });
    expect(row(T.contacts, m1)["待处理"]).toBe(false);
    await call("/api/mail-never", { id: m2 });
    expect(row(T.followups, fid)).toMatchObject({ 阶段: ["结案"], 结案原因: ["拒绝"] });
    expect(row(T.profiles, pid)["联系许可"]).toEqual(["永不联系"]);
  });

  it("edits a followup, records a post, and refuses fields it doesn't own", async () => {
    await call("/api/followup", { id: fid, fields: { 下一步: "等她用完", 下次跟进日期: "2026-11-02", 当前轮到谁: "KOL" } });
    expect(row(T.followups, fid)).toMatchObject({ 下一步: "等她用完", 下次跟进日期: "2026-11-02 00:00", 当前轮到谁: ["KOL"] });
    expect((await call("/api/followup", { id: fid, fields: { 阶段: "已发布" } })).status).toBe(500);
    await call("/api/post", { id: fid, link: "https://www.instagram.com/p/abc/" });
    expect(lark.table(T.posts)[0]).toMatchObject({ 平台: ["Instagram"], 内容链接: "https://www.instagram.com/p/abc/" });
    expect(row(T.followups, fid)["阶段"]).toEqual(["已发布"]);
  });

  it("writes a mail in the reviewer's own words and sends it", async () => {
    await call("/api/write", { id: fid, subject: "近況", body: "安安您好，想問一下近況" });
    expect(await settled()).toMatchObject({ state: "做完了" });
    expect(lark.table(T.reviews).at(-1)).toMatchObject({ 审核项: "林运营在决策台写的信", 同意来源: "决策台", 状态: ["已执行"] });
  });

  it("links an unknown sender's mail to a KOL and remembers the address", async () => {
    const m = lark.add(T.contacts, { 方向: ["收到"], 待处理: true, 内容: "发件人：agent@mcn.tw", 日期: "2026-10-26 09:00" });
    await call("/api/mail-link", { id: m, followup: fid });
    expect(row(T.contacts, m)).toMatchObject({ KOL: [{ id: fid }], 待处理: true });
    expect(row(T.profiles, pid)["其他邮箱"]).toBe("agent@mcn.tw");
    expect(row(T.followups, fid)).toMatchObject({ 当前轮到谁: ["我们"], 最后来信日期: "2026-10-26 09:00" });
  });

  it("tells what happened since the last look", async () => {
    lark.add(T.oplog, { 时间: "2099-01-01 10:00", 类型: ["发出邮件"], 结果: ["完成"], 操作: "回复：安安", KOL: [{ id: fid }] });
    lark.add(T.posts, { KOL: [{ id: fid }], 内容标题: "新影片", 平台: ["YouTube"], 发布日期: "2099-01-01 09:00", 内容链接: "https://youtu.be/x" });
    await call("/api/refresh");
    const n = await (await fetch(`${url}api/news?since=${Date.parse("2098-12-31T00:00:00Z")}`)).json();
    expect(n.chips).toEqual(expect.arrayContaining([{ label: "新发布", n: 1, tone: "ok" }, { label: "发出的信", n: 1, tone: "" }]));
    expect(n.items.map((i: any) => i.text)).toEqual(["回复：安安", expect.stringContaining("「新影片」")]);
  });

  it("pauses and resumes sending", async () => {
    expect((await call("/api/pause", { on: true })).body).toMatchObject({ paused: true });
    expect(lark.table(T.settings)[0]["暂停所有发送"]).toBe(true);
    const o = await (await fetch(`${url}api/overview`)).json();
    expect(o.paused).toBe(true);
  });
});

it("only looks, and says why, on a base without the console's fields", async () => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-actions-"));
  const bare = new FakeLark();
  const cfg = seedProject(bare);
  const started = await startConsole(makeCtx(cfg, bare, { id: "ou", name: "林运营" }, "", false, async () => {}), { port: 0, openBrowser: false });
  try {
    const o = await (await fetch(`${started.url}api/overview`)).json();
    expect(o.setupNeeded).toContain("审核队列.同意来源");
    const r = await fetch(`${started.url}api/pause`, { method: "POST", headers: { "content-type": "application/json", "x-kol-console": "1" }, body: "{}" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain("kol setup-base");
  } finally {
    started.server.closeAllConnections();
    started.server.close();
  }
});
