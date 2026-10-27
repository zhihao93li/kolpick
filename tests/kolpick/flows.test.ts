import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runJobs, type AgentExec } from "../../src/kolpick/agent.js";
import { one } from "../../src/kolpick/db/db.js";
import { runApproved } from "../../src/kolpick/execute.js";
import { importSnapshot, projectCounts } from "../../src/kolpick/importer/import.js";
import { catchUp, recordOne } from "../../src/kolpick/inbox.js";
import { prepareInvites, scanFollowups } from "../../src/kolpick/outreach.js";
import { approve, proposeMail } from "../../src/kolpick/proposals.js";
import { callTool } from "../../src/kolpick/tools.js";
import { addKol, card, pglite, world, type World } from "./helpers.js";
import { migrate } from "../../src/kolpick/db/db.js";

const run = (w: World) => runApproved(w.ctx, w.p, { grace: -1000 });

describe("inbox", () => {
  it("records a KOL's mail once, queues a reply draft and supersedes an open draft", async () => {
    const w = await world();
    const k = await addKol(w, { email: "deer@gmail.com" });
    const { id: old } = await proposeMail(w.ctx, w.p, { kind: "followup", kolId: k, subject: "Re: 邀請", body: "還在嗎" });
    w.mail.deliver("hello@tafu.me", { from: "deer@gmail.com", body: "我想試試！\n\n在 2026年10月1日 寫道：\n> 原信" });
    const r1 = await catchUp(w.ctx, w.p);
    const r2 = await catchUp(w.ctx, w.p);
    expect(r1[0].replies).toBe(1);
    expect(r2[0].recorded).toBe(0);
    expect((await card(w, old)).status).toBe("superseded");
    const kol = await one<any>(w.db, "select * from kols where id = $1", [k]);
    expect(kol.stage).toBe("replied");
    expect(kol.whose_turn).toBe("us");
    const jobs = await w.db.query<any>("select kind, kol_id from agent_jobs");
    expect(jobs).toEqual([{ kind: "reply", kol_id: k }]);
  });

  it("an unknown sender goes to the agent to identify; automated mail is ignored", async () => {
    const w = await world();
    w.mail.deliver("hello@tafu.me", { from: "agent@talent.tw", body: "我是經紀人" });
    w.mail.deliver("hello@tafu.me", { from: "noreply@instagram.com", body: "notification" });
    const [r] = await catchUp(w.ctx, w.p);
    expect(r.unmatched).toBe(1);
    expect(r.recorded).toBe(1);
    expect((await w.db.query<any>("select kind from agent_jobs"))[0].kind).toBe("unmatched");
  });

  it("a bounce is tied to the KOL it bounced from and blocks that address", async () => {
    const w = await world();
    const k = await addKol(w, { email: "gone@gmail.com" });
    await w.db.query("insert into messages (project_id, kol_id, direction, mailbox, to_addr, at) values (1, $1, 'out', 'hello@tafu.me', 'gone@gmail.com', now() - interval '1 hour')", [k]);
    w.mail.deliver("hello@tafu.me", { from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", body: "Your message to gone@gmail.com couldn't be delivered." });
    const [r] = await catchUp(w.ctx, w.p);
    expect(r.bounces).toBe(1);
    const job = await one<any>(w.db, "select kind, kol_id from agent_jobs");
    expect(job).toEqual({ kind: "bounce", kol_id: k });
    const { id } = await proposeMail(w.ctx, w.p, { kind: "mail", kolId: k, subject: "a", body: "b" });
    await approve(w.ctx, w.p, id, (await card(w, id)).content_hash);
    await run(w);
    expect(w.mail.sent).toHaveLength(0);
  });

  it("the live watcher's message is recorded like a catch-up, once", async () => {
    const w = await world();
    await addKol(w, { email: "deer@gmail.com" });
    const m = w.mail.deliver("hello@tafu.me", { from: "deer@gmail.com", body: "hi" });
    expect(await recordOne(w.ctx, w.p, "hello@tafu.me", m.messageId)).toBe("reply");
    expect(await recordOne(w.ctx, w.p, "hello@tafu.me", m.messageId)).toBe("skip");
    expect((await catchUp(w.ctx, w.p))[0].recorded).toBe(0);
  });
});

describe("invites and follow-ups", () => {
  it("invites everyone new with an email, once per address, using the template for their angle", async () => {
    const w = await world();
    await w.db.query(`insert into templates (project_id, name, purpose, subject, body, status) values
      (1, '邀约-親子', '邀约', '給 {稱呼} 的親子合盤', '親子 {稱呼}', 'active'), (1, '邀约-自我探索', '邀约', '給 {稱呼}', '自我 {稱呼}', 'active')`);
    await addKol(w, { stage: "new", name: "A", invite_angle: "亲子", email: "a@gmail.com" });
    await addKol(w, { stage: "new", name: "B", email: "b@gmail.com" });
    await addKol(w, { stage: "new", name: "B2", email: "b@gmail.com" });
    await addKol(w, { stage: "new", name: "C" , email: null });
    await addKol(w, { stage: "new", name: "D", email: "d@gmail.com", never_contact: true });
    const r = await prepareInvites(w.ctx, w.p);
    expect(r.items).toBe(2);
    const items = await w.db.query<any>("select k.name, p.subject, p.body from proposals p join kols k on k.id = p.kol_id where p.parent_id = $1 order by k.name", [r.group]);
    expect(items).toEqual([{ name: "A", subject: "給 A 的親子合盤", body: "親子 A" }, { name: "B", subject: "給 B", body: "自我 B" }]);
    const group = (await w.db.query<any>("select id from proposals where id = $1", [r.group]))[0];
    const { groupHash } = await import("../../src/kolpick/proposals.js");
    const pending = await w.db.query<any>("select id, content_hash from proposals where parent_id = $1 and status = 'pending' order by id", [group.id]);
    await approve(w.ctx, w.p, group.id, groupHash(pending), [pending[1].id]);
    await run(w);
    expect(w.mail.sent.map((m) => m.to)).toEqual(["a@gmail.com"]);
    const a = await one<any>(w.db, "select stage, first_invited_at, next_followup_at from kols where name = 'A'");
    expect(a.stage).toBe("invited");
    expect(a.first_invited_at).toBeTruthy();
    expect(a.next_followup_at).toBeTruthy();
  });

  it("follows up after the set days, closes after the third silence, skips levels not to chase", async () => {
    const w = await world({ settings: { noFollowupLevels: ["S"] } });
    await w.db.query(`insert into templates (project_id, name, purpose, body, status) values (1, '催1', '催信 1', '還在嗎 {稱呼}', 'active'), (1, '催2', '催信 2', '最後一次 {稱呼}', 'active')`);
    const day = 86_400_000;
    const mk = async (name: string, sent: number, idleDays: number, extra: Record<string, unknown> = {}) => {
      const k = await addKol(w, { name, whose_turn: "kol", last_contact_at: new Date(Date.now() - idleDays * day).toISOString(), first_invited_at: new Date().toISOString(), ...extra });
      for (let i = 0; i < sent; i++) await w.db.query("insert into messages (project_id, kol_id, direction, mailbox, subject, at) values (1, $1, 'out', 'hello@tafu.me', '邀請', now() - interval '20 days')", [k]);
      return k;
    };
    await mk("first", 1, 6);
    await mk("tooSoon", 1, 2);
    await mk("second", 2, 8);
    await mk("close", 3, 8);
    await mk("vip", 1, 9, { level: "S" });
    const r = await scanFollowups(w.ctx, w.p);
    expect(r.followups).toBe(2);
    expect(r.closes).toBe(1);
    const items = await w.db.query<any>("select k.name, p.kind, p.subject, p.body from proposals p join kols k on k.id = p.kol_id where p.parent_id = $1 order by k.name", [r.group]);
    expect(items).toEqual([
      { name: "close", kind: "close", subject: null, body: null },
      { name: "first", kind: "followup", subject: "Re: 邀請", body: "還在嗎 first" },
      { name: "second", kind: "followup", subject: "Re: 邀請", body: "最後一次 second" },
    ]);
  });
});

describe("background agent", () => {
  it("a reply job reserves the KOL's slot and the agent fills it through the tools", async () => {
    const w = await world();
    const k = await addKol(w, { email: "deer@gmail.com", salutation: "鹿鹿" });
    w.mail.deliver("hello@tafu.me", { from: "deer@gmail.com", subject: "想體驗", body: "想試試" });
    await catchUp(w.ctx, w.p);
    let prompt = "";
    const exec: AgentExec = async (o) => {
      prompt = o.prompt;
      const job = await one<any>(w.db, "select * from agent_jobs");
      await callTool(w.ctx, "draft_mail", { kind: "reply", kol_id: k, in_reply_to: job.message_id, proposal_id: job.proposal_id, body: "{稱呼} 您好，碼是 {體驗碼}",
        code: { type: "trial_create", code: "deer_jay", maxUses: 3, days: 14 }, after: { next_followup_days: 5 } }, "agent", "t");
      await callTool(w.ctx, "job_done", { job_id: job.id }, "agent", "t");
      return { ok: true, sessionId: "s-1", output: "ok" };
    };
    expect(await runJobs(w.ctx, w.p, "http://x/mcp", exec)).toBe(1);
    expect(prompt).toMatch(/draft_mail/);
    const c = await one<any>(w.db, "select * from proposals where kol_id = $1", [k]);
    expect(c.status).toBe("pending");
    expect(c.subject).toBe("Re: 想體驗");
    expect(c.body).toBe("鹿鹿 您好，碼是 {體驗碼}");
    expect(await one<any>(w.db, "select status, session_id from agent_jobs")).toEqual({ status: "done", session_id: "s-1" });
  });

  it("a job the agent leaves unfinished is stuck, and its empty card goes away", async () => {
    const w = await world();
    const k = await addKol(w, { email: "deer@gmail.com" });
    w.mail.deliver("hello@tafu.me", { from: "deer@gmail.com", body: "hi" });
    await catchUp(w.ctx, w.p);
    await runJobs(w.ctx, w.p, "http://x/mcp", async () => ({ ok: false, sessionId: "", output: "boom" }));
    expect((await one<any>(w.db, "select status from agent_jobs")).status).toBe("stuck");
    expect((await one<any>(w.db, "select status from proposals where kol_id = $1", [k])).status).toBe("dropped");
  });
});

describe("tools", () => {
  it("query is read-only", async () => {
    const w = await world();
    await expect(callTool(w.ctx, "query", { sql: "delete from kols" }, "agent", "t")).rejects.toThrow();
    await expect(callTool(w.ctx, "query", { sql: "select 1 as x; delete from kols" }, "agent", "t")).rejects.toThrow();
    expect(await callTool(w.ctx, "query", { sql: "select count(*)::int as n from kols" }, "agent", "t")).toMatchObject({ rows: [{ n: 0 }] });
  });

  it("there is no tool that sends or approves", async () => {
    const { TOOLS } = await import("../../src/kolpick/tools.js");
    expect(TOOLS.map((t) => t.name).filter((n) => /^(send|approve|mail_send)|_send$|_approve/.test(n))).toEqual([]);
  });

  it("settings_set checks and stores a value", async () => {
    const w = await world();
    await callTool(w.ctx, "settings_set", { key: "noFollowupLevels", value: "S、A" }, "operator", "t");
    expect((await one<any>(w.db, "select settings->'noFollowupLevels' as v from projects")).v).toEqual(["S", "A"]);
    await expect(callTool(w.ctx, "settings_set", { key: "dailyLimit", value: "abc" }, "operator", "t")).rejects.toThrow(/数字/);
  });
});

describe("importer", () => {
  function snapshot(): string {
    const dir = mkdtempSync(join(tmpdir(), "kolpick-snap-"));
    mkdirSync(dir, { recursive: true });
    const put = (t: string, rows: any[]) => writeFileSync(join(dir, `${t}.json`), JSON.stringify({ table: t, rows }));
    put("设置", [{ record_id: "s1", 暂停所有发送: true, 全公司每日上限: 300, 不催级别: "S、A", 活动码市场: "台湾=TW，其他=GLOBAL", 自动催信起始日: "2026-10-22T00:00:00.000+08:00" }]);
    put("发信邮箱", [{ record_id: "m1", 邮箱: "hello@tafu.me", 启用: true, 每日上限: 50 }]);
    put("模板", [{ record_id: "t1", 名称: "催信-1", 用途: ["催信 1"], 正文: "還在嗎", 状态: ["已批准"] }]);
    put("KOL 档案", [
      { record_id: "p1", 账号名称: "小鹿", 账号: "@deer", 公开邮箱: " Deer@Gmail.com ", 主页链接: "[https://ig.com/deer](https://ig.com/deer)", 主要平台: ["Instagram"], 联系许可: ["可联系"], 跟进记录: [{ id: "f1" }] },
      { record_id: "p2", 账号名称: "不要", 联系许可: ["永不联系"], 联系许可原因: "拒绝" },
    ]);
    put("KOL 跟进", [{ record_id: "f1", 档案: [{ id: "p1" }], 阶段: ["体验中"], 当前轮到谁: ["KOL"], 联系渠道: ["hello@tafu.me"], 体验码: "deer", 体验码上限: 3, 体验码已用: 1, 备注: "老备注" }]);
    put("接触记录", [
      { record_id: "c1", KOL: [{ id: "f1" }], 方向: ["发出"], 渠道: ["hello@tafu.me"], 日期: "2026-10-01T10:00:00.000+08:00", "Message ID": "m-1", 内容: "主旨：邀請\n寄件人：hello@tafu.me\n收件人：deer@gmail.com\n\n內文" },
      { record_id: "c2", KOL: [{ id: "f1" }], 方向: ["发出"], 渠道: ["hello@tafu.me"], 日期: "2026-10-01T10:00:00.000+08:00", "Message ID": "m-1" },
    ]);
    put("发布内容", [{ record_id: "po1", KOL: [{ id: "f1" }], 内容链接: "https://instagram.com/reel/abc", 第1天播放: 100, 平台: ["Instagram"] }]);
    put("审核队列", [{ record_id: "r1", KOL: [{ id: "f1" }], 状态: ["待你审核"], 审核项: "旧的", 类型: ["决定"] }]);
    put("运行记录", [{ record_id: "run1", 运行: "10/5", 结果: ["完成"], 开始时间: "2026-10-05T19:05:00.000+08:00" }]);
    put("操作日志", [{ record_id: "o1", 时间: "2026-10-05T14:29:00.000+08:00", 类型: ["发出邮件"], 操作: "发了", KOL: [{ id: "f1" }] }]);
    return dir;
  }

  it("imports everything and changes nothing when run again", async () => {
    const db = pglite();
    await migrate(db);
    const dir = snapshot();
    await importSnapshot(db, dir, { project: "tafu", disableMailboxes: true });
    const first = await projectCounts(db, "tafu");
    await importSnapshot(db, dir, { project: "tafu", disableMailboxes: true });
    expect(await projectCounts(db, "tafu")).toEqual(first);
    expect(first).toEqual({ kols: 2, messages: 1, codes: 1, posts: 1, proposals: 1, log: 2, templates: 1, mailboxes: 1, followups: 1 });
    const kol = await one<any>(db, "select * from kols where legacy_profile = 'p1'");
    expect(kol).toMatchObject({ email: "deer@gmail.com", url: "https://ig.com/deer", stage: "trial", whose_turn: "kol", mailbox: "hello@tafu.me" });
    expect(kol.notes).toMatch(/跟进备注：老备注/);
    expect((await one<any>(db, "select never_contact from kols where legacy_profile = 'p2'")).never_contact).toBe(true);
    expect(await one<any>(db, "select enabled from mailboxes")).toEqual({ enabled: false });
    const proj = await one<any>(db, "select paused, settings from projects");
    expect(proj.paused).toBe(true);
    expect(proj.settings).toMatchObject({ dailyLimit: 300, noFollowupLevels: ["S", "A"], partnerMarkets: { 台湾: "TW" }, partnerMarketDefault: "GLOBAL", followupFrom: "2026-10-22" });
    expect(await one<any>(db, "select subject, to_addr from messages")).toEqual({ subject: "邀請", to_addr: "deer@gmail.com" });
    expect(await one<any>(db, "select status from templates")).toEqual({ status: "active" });
  });
});

describe("console API", () => {
  it("routes every call the page makes", async () => {
    const { App } = await import("../../src/kolpick/server.js");
    const w = await world();
    const app = new App(w.ctx);
    const call = (method: string, path: string, body?: unknown) => app.api(method, new URL(`http://127.0.0.1/api${path}`), body);
    const k = await addKol(w, { email: "deer@gmail.com" });
    expect(await call("GET", "/state")).toMatchObject({ project: "t", env: "test" });
    expect(await call("POST", "/tool/settings_get", {})).toMatchObject({ settings: { dailyLimit: 450 } });
    expect(await call("POST", "/tool/pause_sending", { on: true })).toEqual({ paused: true });
    expect(await call("GET", `/kols/${k}`)).toMatchObject({ kol: { id: k } });
    await call("POST", `/kols/${k}`, { fields: { salutation: "鹿鹿" } });
    const card = (await call("POST", `/kols/${k}/mail`, { subject: "Hi", body: "{稱呼} 好" })) as { id: number };
    const cards = (await call("GET", "/cards?view=approved")) as any[];
    expect(cards.map((c) => [c.id, c.body])).toEqual([[card.id, "鹿鹿 好"]]);
    await call("POST", `/cards/${card.id}/undo`, {});
    expect(((await call("GET", "/cards?view=pending")) as any[]).map((c) => c.id)).toContain(card.id);
    expect(await call("GET", "/jobs")).toEqual([]);
    expect(await call("GET", "/local")).toMatchObject({ env: "test" });
    await expect(call("GET", "/nope")).rejects.toThrow(/没有这个接口/);
  });
});
