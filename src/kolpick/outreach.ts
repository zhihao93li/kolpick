/**
 * Invitations and follow-ups. Neither picks people: everyone with an email who hasn't been contacted gets an
 * invitation, everyone who hasn't answered gets the follow-ups the settings say. Both end as one group card.
 */
import { addLog, type Ctx, type Project } from "./ctx.js";
import { one } from "./db/db.js";
import { replySubject } from "./mail.js";
import { openGroup, proposeDecision, proposeGroup, proposeMail } from "./proposals.js";
import { mailboxLimit, type MailboxRow } from "./rules.js";
import { dayStart } from "./ctx.js";

/** Open mail cards block new ones for the same KOL. */
const NO_OPEN = `not exists (select 1 from proposals pr where pr.kol_id = k.id and pr.to_addr is not null
  and pr.status in ('drafting','pending','approved','running','unknown'))`;

const ANGLE_WORDS: Record<string, string[]> = { 伴侣: ["伴侶", "伴侣"], 亲子: ["親子", "亲子"], 职场: ["職場", "职场"], 自我探索: ["自我探索"] };

export async function activeTemplates(ctx: Ctx, p: Project, purpose: string): Promise<any[]> {
  return ctx.db.query("select * from templates where project_id = $1 and purpose = $2 and status = 'active' and draft_of is null order by id", [p.id, purpose]);
}

/** The invitation template for a KOL's invite angle; the first one when none names it. */
export function pickTemplate(list: any[], angle: string | null): any | undefined {
  const words = angle ? ANGLE_WORDS[angle] ?? [angle] : [];
  return list.find((t) => words.some((w) => t.name.includes(w))) ?? list.find((t) => t.name.includes("自我探索")) ?? list[0];
}

/** How many more people each enabled mailbox may write to today. */
async function roomToday(ctx: Ctx, p: Project): Promise<{ address: string; room: number }[]> {
  const boxes = await ctx.db.query<MailboxRow>("select * from mailboxes where project_id = $1 and enabled order by id", [p.id]);
  const today = dayStart(ctx.now(), p.settings.timezone);
  const out = [];
  for (const b of boxes) {
    const used = await one<{ n: number }>(ctx.db, "select count(distinct lower(to_addr))::int as n from messages where project_id = $1 and direction = 'out' and lower(mailbox) = lower($2) and at >= $3", [p.id, b.address, today]);
    const queued = await one<{ n: number }>(ctx.db, "select count(*)::int as n from proposals where project_id = $1 and status in ('pending','approved') and kind = 'invite' and lower(mailbox) = lower($2)", [p.id, b.address]);
    out.push({ address: b.address, room: Math.max(0, mailboxLimit(b, ctx.now(), p.settings.timezone) - (used?.n ?? 0) - (queued?.n ?? 0)) });
  }
  return out;
}

/**
 * One invitation batch: everyone not yet contacted who has an email, up to today's room in the mailboxes (or
 * `limit`). Each person gets the active 邀约 template matching their invite angle.
 */
export async function prepareInvites(ctx: Ctx, p: Project, o: { limit?: number; batch?: string; kolIds?: number[] } = {}): Promise<{ group?: number; items: number; skipped: string[] }> {
  const templates = await activeTemplates(ctx, p, "邀约");
  if (!templates.length) throw new Error("没有在用的「邀约」模板：先在设置里批准一个");
  const room = await roomToday(ctx, p);
  const total = room.reduce((s, b) => s + b.room, 0);
  const limit = Math.min(o.limit ?? total, total);
  if (!room.length) throw new Error("没有启用的发信邮箱");
  if (limit <= 0) return { items: 0, skipped: ["今天各邮箱的额度已经排满了"] };
  const kols = await ctx.db.query<any>(
    `select k.* from kols k where k.project_id = $1 and k.stage = 'new' and not k.never_contact and k.email is not null and k.email like '%@%' and ${NO_OPEN}
       and ($3::int[] is null or k.id = any($3::int[]))
       and not exists (select 1 from messages m where m.project_id = k.project_id and m.direction = 'out' and lower(m.to_addr) = lower(k.email))
       and not exists (select 1 from kols n where n.project_id = k.project_id and n.never_contact and lower(n.email) = lower(k.email))
     order by k.created_at, k.id limit $2`, [p.id, limit * 2, o.kolIds ?? null]);
  const batch = o.batch ?? `邀约 ${new Date(ctx.now()).toISOString().slice(0, 10)}`;
  const group = await proposeGroup(ctx, p, { kind: "invite_batch", title: `邀约一批：${batch}`, why: "有邮箱、还没联系过的人都邀约；发前每封都会再查额度、冷却、永不联系、退信和邮箱域名" });
  const skipped: string[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const k of kols) {
    if (n >= limit) break;
    const email = k.email.toLowerCase();
    if (seen.has(email)) {
      skipped.push(`${k.name}：邮箱和这批里另一位相同`);
      continue;
    }
    seen.add(email);
    const box = room.find((b) => b.room > 0);
    if (!box) break;
    const t = pickTemplate(templates, k.invite_angle);
    try {
      await proposeMail(ctx, p, {
        kind: "invite", kolId: k.id, parentId: group.id, mailbox: box.address, to: email, subject: t.subject ?? "", body: t.body,
        title: k.name, why: `模板「${t.name}」`, action: { step: "invite", batch }, who: "tool",
      });
      box.room--;
      n++;
    } catch (err: any) {
      skipped.push(`${k.name}：${err.message}`);
    }
  }
  const items = await openGroup(ctx, p, group.id);
  return { group: items ? group.id : undefined, items, skipped };
}

/**
 * The follow-up scan: who is due a first or second follow-up, and who should be closed for no answer. Drafts come
 * from the active 催信 1 / 催信 2 templates; closes carry no mail. One group card per scan.
 */
export async function scanFollowups(ctx: Ctx, p: Project): Promise<{ group?: number; followups: number; closes: number; skipped: string[] }> {
  const s = p.settings;
  const day = 86_400_000;
  const now = ctx.now();
  const boxes = (await ctx.db.query<{ address: string }>("select address from mailboxes where project_id = $1", [p.id])).map((b) => b.address);
  const rows = await ctx.db.query<any>(
    `select k.*, (select count(*)::int from messages m where m.kol_id = k.id and m.direction = 'out' and m.at > coalesce(k.last_inbound_at, 'epoch')) as sent_since,
            (select subject from messages m where m.kol_id = k.id and m.subject is not null order by m.at desc limit 1) as last_subject
     from kols k
     where k.project_id = $1 and k.stage = 'invited' and k.whose_turn = 'kol' and not k.never_contact and k.email is not null
       and k.last_contact_at is not null and (k.next_followup_at is null or k.next_followup_at <= $2) and ${NO_OPEN}
       and ($3 = '' or k.first_invited_at >= ($3 || 'T00:00:00' || $8)::timestamptz)
       and k.mailbox = any($4::text[])
       and not (coalesce(k.level, '') = any($5::text[])) and not (coalesce(k.demand, '') = any($6::text[])) and not (k.mailbox = any($7::text[]))`,
    [p.id, new Date(now).toISOString(), s.followupFrom, boxes, s.noFollowupLevels, s.noFollowupDemands, s.noFollowupChannels, s.timezone]);
  const t1 = (await activeTemplates(ctx, p, "催信 1"))[0];
  const t2 = (await activeTemplates(ctx, p, "催信 2"))[0];
  const skipped: string[] = [];
  const due = rows.filter((k) => {
    const idle = now - Date.parse(k.last_contact_at);
    if (k.sent_since <= 1) return idle >= s.followup1Days * day;
    if (k.sent_since === 2) return idle >= s.followup2Days * day;
    return idle >= s.closeDays * day;
  });
  if (!due.length) return { followups: 0, closes: 0, skipped };
  const group = await proposeGroup(ctx, p, { kind: "followup_group", title: `催信和结案 ${new Date(now).toISOString().slice(0, 10)}`, why: `第一次催信 ${s.followup1Days} 天、第二次 ${s.followup2Days} 天、再 ${s.closeDays} 天没回结案` });
  let followups = 0, closes = 0;
  for (const k of due) {
    try {
      if (k.sent_since >= 3) {
        await proposeDecision(ctx, p, { kind: "close", parentId: group.id, kolId: k.id, title: `${k.name}：无回应结案`, why: `发了 ${k.sent_since} 封都没回`, action: { step: "close", after: { close_reason: "无回应" } }, who: "tool" });
        closes++;
        continue;
      }
      const t = k.sent_since <= 1 ? t1 : t2;
      if (!t) {
        skipped.push(`${k.name}：没有在用的「${k.sent_since <= 1 ? "催信 1" : "催信 2"}」模板`);
        continue;
      }
      await proposeMail(ctx, p, {
        kind: "followup", kolId: k.id, parentId: group.id, mailbox: k.mailbox, to: k.email,
        subject: k.last_subject ? replySubject(k.last_subject) : t.subject ?? "", body: t.body, title: `${k.name}：${t.purpose}`,
        why: `上次联系 ${String(k.last_contact_at).slice(0, 10)}，已发 ${k.sent_since} 封`, who: "tool",
        action: { step: k.sent_since <= 1 ? "followup1" : "followup2", after: { next_followup_days: k.sent_since <= 1 ? s.followup2Days : s.closeDays } },
      });
      followups++;
    } catch (err: any) {
      skipped.push(`${k.name}：${err.message}`);
    }
  }
  const items = await openGroup(ctx, p, group.id);
  await addLog(ctx, p, { kind: "scan", who: "tool", summary: `催信扫描：催 ${followups}，结案 ${closes}${skipped.length ? `，跳过 ${skipped.length}` : ""}` });
  return { group: items ? group.id : undefined, followups, closes, skipped };
}

/**
 * Codes about to expire (or just expired) and agreed posts that didn't come: each becomes a job for the agent,
 * which decides what to write. Each code expiry and each missed date is handed over once.
 */
export async function scanForAgent(ctx: Ctx, p: Project): Promise<{ expiring: number; missedPosts: number }> {
  const s = p.settings;
  const now = ctx.now();
  const soon = new Date(now + s.trialExpiryDays * 86_400_000).toISOString();
  const recent = new Date(now - 3 * 86_400_000).toISOString();
  const codes = await ctx.db.query<any>(
    `select c.*, k.name from codes c join kols k on k.id = c.kol_id
     where c.project_id = $1 and c.kind = 'trial' and c.expires_at between $2 and $3 and coalesce(c.active, true)
       and k.stage in ('trial', 'replied', 'report_seen') and not k.never_contact and ${NO_OPEN.replace(/k\.id/g, "c.kol_id")}`,
    [p.id, recent, soon]);
  let expiring = 0;
  for (const c of codes) {
    const key = `expiry:${c.id}:${c.expires_at instanceof Date ? c.expires_at.toISOString() : c.expires_at}`;
    const queued = await ctx.db.tx(async (q) => {
      if (!(await markOnce({ ...ctx, db: q }, p, key))) return false;
      await q.query("insert into agent_jobs (project_id, kind, kol_id, input) values ($1, 'code_expiry', $2, $3)", [p.id, c.kol_id, JSON.stringify({ code_id: c.id, code: c.code })]);
      return true;
    });
    if (queued) expiring++;
  }
  const missed = await ctx.db.query<any>(
    `select k.* from kols k where k.project_id = $1 and k.stage = 'publish_agreed' and k.publish_due_at < $2 and not k.never_contact
       and not exists (select 1 from posts po where po.kol_id = k.id) and ${NO_OPEN}`, [p.id, new Date(now - 86_400_000).toISOString()]);
  let missedPosts = 0;
  for (const k of missed) {
    const queued = await ctx.db.tx(async (q) => {
      if (!(await markOnce({ ...ctx, db: q }, p, `checkin:${k.id}:${new Date(k.publish_due_at).toISOString()}`))) return false;
      await q.query("insert into agent_jobs (project_id, kind, kol_id, input) values ($1, 'checkin', $2, '{}')", [p.id, k.id]);
      return true;
    });
    if (queued) missedPosts++;
  }
  return { expiring, missedPosts };
}

async function markOnce(ctx: Ctx, p: Project, key: string): Promise<boolean> {
  const r = await ctx.db.query("insert into state (project_id, key, value) values ($1, $2, 'true') on conflict do nothing returning key", [p.id, key]);
  return r.length > 0;
}
