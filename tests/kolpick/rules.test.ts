import { describe, expect, it } from "vitest";
import { one } from "../../src/kolpick/db/db.js";
import { resolveUnknown, runApproved } from "../../src/kolpick/execute.js";
import { approve, editProposal, proposeMail, reject, requestRevision, Stale, undo } from "../../src/kolpick/proposals.js";
import { addKol, card, world, type World } from "./helpers.js";

const run = (w: World) => runApproved(w.ctx, w.p, { grace: -1000 });

async function approved(w: World, kolId: number, o: Record<string, unknown> = {}) {
  const { id } = await proposeMail(w.ctx, w.p, { kind: "mail", kolId, subject: "Hi {稱呼}", body: "{稱呼} 您好", ...o });
  const c = await card(w, id);
  await approve(w.ctx, w.p, id, c.content_hash);
  return id;
}

describe("one open mail per KOL", () => {
  it("refuses a second draft while one is open, and allows one after it is withdrawn", async () => {
    const w = await world();
    const k = await addKol(w);
    const { id } = await proposeMail(w.ctx, w.p, { kind: "mail", kolId: k, subject: "a", body: "b" });
    await expect(proposeMail(w.ctx, w.p, { kind: "mail", kolId: k, subject: "c", body: "d" })).rejects.toThrow(/已经有一封待发的信/);
    await reject(w.ctx, w.p, id);
    await expect(proposeMail(w.ctx, w.p, { kind: "mail", kolId: k, subject: "c", body: "d" })).resolves.toBeTruthy();
  });

  it("fills the salutation when the card is made", async () => {
    const w = await world();
    const k = await addKol(w, { salutation: "鹿鹿" });
    const { id } = await proposeMail(w.ctx, w.p, { kind: "mail", kolId: k, subject: "給 {稱呼}", body: "{稱呼} 您好" });
    expect((await card(w, id)).body).toBe("鹿鹿 您好");
  });

  it("refuses never-contact KOLs", async () => {
    const w = await world();
    const k = await addKol(w, { never_contact: true });
    await expect(proposeMail(w.ctx, w.p, { kind: "mail", kolId: k, subject: "a", body: "b" })).rejects.toThrow(/永不联系/);
  });
});

describe("approval is for the version shown", () => {
  it("rejects an approval of an older version", async () => {
    const w = await world();
    const k = await addKol(w);
    const { id } = await proposeMail(w.ctx, w.p, { kind: "mail", kolId: k, subject: "a", body: "b" });
    const old = (await card(w, id)).content_hash;
    await editProposal(w.ctx, w.p, id, { body: "changed" });
    await expect(approve(w.ctx, w.p, id, old)).rejects.toBeInstanceOf(Stale);
  });

  it("an edit after approval takes the approval back", async () => {
    const w = await world();
    const k = await addKol(w);
    const id = await approved(w, k);
    await editProposal(w.ctx, w.p, id, { body: "new text" });
    expect((await card(w, id)).status).toBe("pending");
    await run(w);
    expect(w.mail.sent).toHaveLength(0);
  });

  it("undo before sending puts the card back", async () => {
    const w = await world();
    const k = await addKol(w);
    const id = await approved(w, k);
    await undo(w.ctx, w.p, id);
    expect((await card(w, id)).status).toBe("pending");
  });

  it("让它改 hands the card to the agent and keeps the KOL's slot", async () => {
    const w = await world();
    const k = await addKol(w);
    const { id } = await proposeMail(w.ctx, w.p, { kind: "mail", kolId: k, subject: "a", body: "b" });
    await requestRevision(w.ctx, w.p, id, "短一点");
    expect((await card(w, id)).status).toBe("drafting");
    const job = await one<any>(w.db, "select * from agent_jobs where proposal_id = $1", [id]);
    expect(job.kind).toBe("revise");
    await expect(proposeMail(w.ctx, w.p, { kind: "mail", kolId: k, subject: "c", body: "d" })).rejects.toThrow(/已经有一封/);
  });
});

describe("sending", () => {
  it("sends the approved text once and records it", async () => {
    const w = await world();
    const k = await addKol(w, { salutation: "鹿鹿", stage: "new" });
    const id = await approved(w, k);
    await run(w);
    await run(w);
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0].body).toBe("鹿鹿 您好");
    expect((await card(w, id)).status).toBe("done");
    const kol = await one<any>(w.db, "select * from kols where id = $1", [k]);
    expect(kol.stage).toBe("invited");
    expect(kol.whose_turn).toBe("kol");
    expect(await one<any>(w.db, "select count(*)::int as n from messages where kol_id = $1 and direction = 'out'", [k])).toEqual({ n: 1 });
  });

  it("does nothing while sending is paused, and goes once the pause is lifted", async () => {
    const w = await world();
    const k = await addKol(w);
    const id = await approved(w, k);
    await w.db.query("update projects set paused = true");
    const r = await run(w);
    expect(r.waiting).toBe(1);
    expect(w.mail.sent).toHaveLength(0);
    expect((await card(w, id)).status).toBe("approved");
    await w.db.query("update projects set paused = false");
    await run(w);
    expect(w.mail.sent).toHaveLength(1);
  });

  it("never writes to an address that belongs to a never-contact KOL", async () => {
    const w = await world();
    const k = await addKol(w, { email: "shared@gmail.com" });
    const id = await approved(w, k);
    await addKol(w, { email: "shared@gmail.com", never_contact: true, name: "另一个号" });
    await run(w);
    expect(w.mail.sent).toHaveLength(0);
    expect((await card(w, id)).status).toBe("failed");
  });

  it("holds mail to an address with an unhandled bounce", async () => {
    const w = await world();
    const k = await addKol(w, { email: "gone@gmail.com" });
    await w.db.query("insert into messages (project_id, direction, mailbox, to_addr, at, bounce) values (1, 'in', 'hello@tafu.me', 'gone@gmail.com', now(), true)");
    const id = await approved(w, k);
    await run(w);
    expect(w.mail.sent).toHaveLength(0);
    expect((await card(w, id)).result).toMatch(/退信/);
  });

  it("keeps to the mailbox's daily limit and waits for tomorrow", async () => {
    const w = await world();
    await w.db.query("update mailboxes set daily_limit = 1 where address = 'hello@tafu.me'");
    const a = await addKol(w), b = await addKol(w);
    await approved(w, a);
    const second = await approved(w, b);
    await run(w);
    expect(w.mail.sent).toHaveLength(1);
    expect((await card(w, second)).result).toMatch(/额度/);
    expect((await card(w, second)).status).toBe("approved");
  });

  it("refuses domains that take no mail", async () => {
    const w = await world();
    const k = await addKol(w, { email: "x@nowhere.invalid" });
    const id = await approved(w, k);
    await run(w);
    expect((await card(w, id)).status).toBe("failed");
  });

  it("a send with no clear answer is never retried by itself", async () => {
    const w = await world();
    const k = await addKol(w);
    const id = await approved(w, k);
    w.mail.failNext = "timeout";
    await run(w);
    expect((await card(w, id)).status).toBe("unknown");
    await w.db.query("update proposals set status = 'approved' where id = $1", [id]);
    await run(w);
    expect(w.mail.sent).toHaveLength(0);
    expect((await card(w, id)).status).toBe("unknown");
  });

  it("the operator confirms an unknown send went out: it is recorded, not sent again", async () => {
    const w = await world();
    const k = await addKol(w);
    const id = await approved(w, k);
    w.mail.failNext = "timeout";
    await run(w);
    await resolveUnknown(w.ctx, w.p, id, true);
    expect((await card(w, id)).status).toBe("done");
    expect(w.mail.sent).toHaveLength(0);
    expect(await one<any>(w.db, "select count(*)::int as n from messages where proposal_id = $1", [id])).toEqual({ n: 1 });
  });

  it("the operator says it didn't go out: it needs a fresh approval, then sends", async () => {
    const w = await world();
    const k = await addKol(w);
    const id = await approved(w, k);
    w.mail.failNext = "timeout";
    await run(w);
    await resolveUnknown(w.ctx, w.p, id, false);
    const c = await card(w, id);
    expect(c.status).toBe("pending");
    await approve(w.ctx, w.p, id, c.content_hash);
    await run(w);
    expect(w.mail.sent).toHaveLength(1);
  });
});

describe("codes", () => {
  it("creates the trial code before the mail and fills it in", async () => {
    const w = await world();
    const k = await addKol(w, { stage: "replied" });
    const id = await approved(w, k, { body: "碼：{體驗碼}，{次數} 次，到 {到期日}", action: { code: { type: "trial_create", code: "deer_jay", maxUses: 3, days: 14 } } });
    await run(w);
    expect(w.tafu.calls).toEqual(["create deer_jay"]);
    expect(w.mail.sent[0].body).toMatch(/^碼：deer_jay，3 次，到 \d{4} 年/);
    expect((await one<any>(w.db, "select stage from kols where id = $1", [k])).stage).toBe("trial");
    expect(await one<any>(w.db, "select code, max_uses from codes where kol_id = $1", [k])).toEqual({ code: "deer_jay", max_uses: 3 });
    expect((await card(w, id)).status).toBe("done");
  });

  it("refuses a code card whose mail can't carry the code", async () => {
    const w = await world();
    const k = await addKol(w);
    await expect(proposeMail(w.ctx, w.p, { kind: "reply", kolId: k, subject: "a", body: "送你體驗",
      action: { code: { type: "trial_create", code: "deer_jay", maxUses: 3, days: 14 } } })).rejects.toThrow(/\{體驗碼\}/);
  });

  it("a refused code stops the mail; nothing is sent", async () => {
    const w = await world();
    const k = await addKol(w);
    const id = await approved(w, k, { body: "{體驗碼}", action: { code: { type: "trial_create", code: "deer_jay", maxUses: 3, days: 14 } } });
    w.tafu.failNext = "refuse";
    await run(w);
    expect(w.mail.sent).toHaveLength(0);
    expect((await card(w, id)).status).toBe("failed");
  });

  it("a code made but the send failed: approving again reuses the code, no second one", async () => {
    const w = await world();
    const k = await addKol(w);
    const id = await approved(w, k, { body: "{體驗碼}", action: { code: { type: "trial_create", code: "deer_jay", maxUses: 3, days: 14 } } });
    w.mail.failNext = "definite";
    await run(w);
    expect((await card(w, id)).status).toBe("failed");
    await w.db.query("update proposals set status = 'approved' where id = $1", [id]);
    await run(w);
    expect(w.tafu.calls).toEqual(["create deer_jay"]);
    expect(w.mail.sent).toHaveLength(1);
  });

  it("an extension with no clear answer is not redone; confirming reads the new expiry back", async () => {
    const w = await world();
    const k = await addKol(w, { stage: "trial" });
    await w.tafu.createTrial({ code: "deer_jay", maxUses: 3, days: 1 });
    w.tafu.calls = [];
    const id = await approved(w, k, { body: "延到 {到期日}", action: { code: { type: "trial_extend", code: "deer_jay", days: 7 } } });
    w.tafu.failNext = "timeout";
    await run(w);
    expect((await card(w, id)).status).toBe("unknown");
    await resolveUnknown(w.ctx, w.p, id, true);
    await run(w);
    expect(w.tafu.calls).toEqual(["extend deer_jay"]);
    expect(w.mail.sent[0].body).toMatch(/^延到 \d{4} 年/);
  });

  it("opens a partner campaign and puts the links in the mail", async () => {
    const w = await world();
    const k = await addKol(w, { stage: "trial" });
    await approved(w, k, { body: "{活動碼} {專屬連結} {粉絲折扣}", action: { code: { type: "partner_create", code: "deer", market: "TW", percentOff: 15, partnerName: "小鹿", contact: "deer@gmail.com" } } });
    await run(w);
    expect(w.mail.sent[0].body).toBe("deer https://tafu.me/p/deer 85 折");
    expect((await one<any>(w.db, "select stage from kols where id = $1", [k])).stage).toBe("partner");
  });
});

describe("review fixes", () => {
  it("a card edited after the run read its list is not sent", async () => {
    const w = await world();
    const a = await addKol(w), b = await addKol(w);
    await approved(w, a);
    const second = await approved(w, b);
    // While the first one sends, the operator edits the second.
    const orig = w.mail.send.bind(w.mail);
    w.mail.send = async (o) => {
      const r = await orig(o);
      if (w.mail.sent.length === 1) await editProposal(w.ctx, w.p, second, { body: "改过了" });
      return r;
    };
    await run(w);
    expect(w.mail.sent).toHaveLength(1);
    expect((await card(w, second)).status).toBe("pending");
  });

  it("pausing mid-run stops before the next code or send", async () => {
    const w = await world();
    const a = await addKol(w), b = await addKol(w);
    await approved(w, a);
    const second = await approved(w, b, { body: "{體驗碼}", action: { code: { type: "trial_create", code: "second_one", maxUses: 3, days: 14 } } });
    const orig = w.mail.send.bind(w.mail);
    w.mail.send = async (o) => {
      const r = await orig(o);
      await w.db.query("update projects set paused = true");
      return r;
    };
    await run(w);
    expect(w.mail.sent).toHaveLength(1);
    expect(w.tafu.calls).toEqual([]);
    expect((await card(w, second)).status).toBe("approved");
  });

  it("a reply whose approved recipient differs from the sender goes out as a new mail to the approved address", async () => {
    const w = await world();
    const k = await addKol(w, { email: "deer@gmail.com" });
    const m = await one<{ id: number }>(w.db, "insert into messages (project_id, kol_id, direction, mailbox, message_id, subject, from_addr, at) values (1, $1, 'in', 'hello@tafu.me', 'mid-1', '想體驗', 'agent@talent.tw', now()) returning id", [k]);
    const { id } = await proposeMail(w.ctx, w.p, { kind: "reply", kolId: k, inReplyTo: m!.id, to: "deer@gmail.com", body: "hi" });
    await approve(w.ctx, w.p, id, (await card(w, id)).content_hash);
    await run(w);
    expect(w.mail.sent[0]).toMatchObject({ to: "deer@gmail.com", replyTo: undefined, subject: "Re: 想體驗" });
  });

  it("other emails match whole addresses only", async () => {
    const w = await world();
    const k = await addKol(w, { email: "x@gmail.com", other_emails: "wang@gmail.com, b@x.tw" });
    const { sendBlock } = await import("../../src/kolpick/rules.js");
    await addKol(w, { email: "z@gmail.com", other_emails: "ang@gmail.com", never_contact: true });
    expect(await sendBlock(w.ctx, w.p, { kolId: k, to: "wang@gmail.com", mailbox: "hello@tafu.me" })).toBe("");
  });

  it("the timezone setting must be an offset", async () => {
    const { cleanSetting } = await import("../../src/kolpick/settings.js");
    expect(() => cleanSetting("timezone", "Asia/Taipei")).toThrow(/\+08:00/);
    expect(cleanSetting("timezone", "+08:00")).toBe("+08:00");
  });
});
