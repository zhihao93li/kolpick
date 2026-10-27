/**
 * The checks every outgoing mail and code action passes right before it happens (docs/design.md §4). Each returns
 * the reason it may not happen, or "" when it may. Tools never skip them.
 */
import { dayOf, dayStart, type Ctx, type Project } from "./ctx.js";
import { one } from "./db/db.js";
import { undeliverable } from "./mx.js";

export interface MailboxRow {
  address: string;
  enabled: boolean;
  daily_limit: number;
  warmup_from: string | null;
  warmup_start: number | null;
  warmup_step: number | null;
}

/** Today's limit of a mailbox, counting warm-up. */
export function mailboxLimit(m: MailboxRow, now: number, tz = "+08:00"): number {
  if (!m.warmup_from || m.warmup_start == null) return m.daily_limit;
  // Whole days in the project's zone: the limit steps up at its midnight.
  const from = (m.warmup_from as unknown) instanceof Date ? (m.warmup_from as unknown as Date).toISOString().slice(0, 10) : String(m.warmup_from).slice(0, 10);
  const days = Math.max(0, Math.round((Date.parse(dayOf(now, tz)) - Date.parse(from)) / 86_400_000));
  return Math.min(m.daily_limit, m.warmup_start + days * (m.warmup_step ?? 0));
}

export async function pausedReason(ctx: Ctx, p: Project): Promise<string> {
  const row = await one<{ paused: boolean }>(ctx.db, "select paused from projects where id = $1", [p.id]);
  return row?.paused ? "「暂停所有发送」开着" : "";
}

/** Bounce rate of a mailbox over the window, in percent, and how many it sent. */
export async function bounceRate(ctx: Ctx, p: Project, mailbox: string): Promise<{ sent: number; bounced: number; rate: number }> {
  const since = new Date(ctx.now() - p.settings.bounceWindowDays * 86_400_000).toISOString();
  const r = await one<{ sent: number; bounced: number }>(ctx.db,
    `select count(*) filter (where direction = 'out')::int as sent, count(*) filter (where bounce)::int as bounced
     from messages where project_id = $1 and lower(mailbox) = lower($2) and at >= $3`, [p.id, mailbox, since]);
  const sent = r?.sent ?? 0, bounced = r?.bounced ?? 0;
  return { sent, bounced, rate: sent ? (bounced / sent) * 100 : 0 };
}

export interface SendIntent {
  kolId: number;
  to: string;
  mailbox: string;
  /** Invitations to new people also obey the cross-project cooldown. */
  invite?: boolean;
}

const domains = new Map<string, Promise<string>>();

/** Everything that must hold before one mail goes out. */
export async function sendBlock(ctx: Ctx, p: Project, s: SendIntent): Promise<string> {
  const paused = await pausedReason(ctx, p);
  if (paused) return paused;
  const to = s.to.trim().toLowerCase();
  if (!to || !to.includes("@")) return "没有收件人邮箱";

  const mb = await one<MailboxRow>(ctx.db, "select * from mailboxes where project_id = $1 and lower(address) = lower($2)", [p.id, s.mailbox]);
  if (!mb) return `${s.mailbox} 不是这个项目的发信邮箱`;
  if (!mb.enabled) return `发信邮箱 ${mb.address} 停用了`;

  const kol = await one<any>(ctx.db, "select never_contact, email, other_emails from kols where id = $1 and project_id = $2", [s.kolId, p.id]);
  if (!kol) return "找不到这位 KOL";
  if (kol.never_contact) return "这位 KOL 是永不联系";
  const never = await one(ctx.db, "select 1 from kols where project_id = $1 and never_contact and (lower(email) = $2 or $2 = any(regexp_split_to_array(lower(coalesce(other_emails, '')), '[\s,，、;；]+')))", [p.id, to]);
  if (never) return `${to} 属于一位永不联系的 KOL，本项目不再往这个邮箱发信`;

  const bounce = await one(ctx.db, "select 1 from messages where project_id = $1 and bounce and resolved_at is null and lower(to_addr) = $2", [p.id, to]);
  if (bounce) return `发往 ${to} 的信有未处理的退信，处理后才能再发`;

  const br = await bounceRate(ctx, p, mb.address);
  if (br.sent >= p.settings.bounceMinSent && br.rate >= p.settings.bounceRate) {
    return `${mb.address} 最近 ${p.settings.bounceWindowDays} 天退信率 ${br.rate.toFixed(1)}%（${br.bounced}/${br.sent}），已暂停这个邮箱`;
  }

  // Quotas count people, not mails: a second mail to someone already written to today doesn't use more.
  const today = dayStart(ctx.now(), p.settings.timezone);
  const already = await one(ctx.db, "select 1 from messages where project_id = $1 and kol_id = $2 and direction = 'out' and at >= $3", [p.id, s.kolId, today]);
  if (!already) {
    const proj = await one<{ n: number }>(ctx.db, "select count(distinct kol_id)::int as n from messages where project_id = $1 and direction = 'out' and at >= $2", [p.id, today]);
    if ((proj?.n ?? 0) >= p.settings.dailyLimit) return `项目今天联系的人数已到上限（${p.settings.dailyLimit}）`;
    const box = await one<{ n: number }>(ctx.db, "select count(distinct lower(to_addr))::int as n from messages where project_id = $1 and direction = 'out' and lower(mailbox) = lower($2) and at >= $3", [p.id, mb.address, today]);
    const limit = mailboxLimit(mb, ctx.now(), p.settings.timezone);
    if ((box?.n ?? 0) >= limit) return `${mb.address} 今天的额度（${limit} 人）用完了`;
  }

  if (s.invite) {
    const since = new Date(ctx.now() - p.settings.cooldownDays * 86_400_000).toISOString();
    const other = await one<{ name: string }>(ctx.db,
      `select pr.name from messages m join projects pr on pr.id = m.project_id
       where m.project_id <> $1 and m.direction = 'out' and lower(m.to_addr) = $2 and m.at >= $3 limit 1`, [p.id, to, since]);
    if (other) return `${to} 在 ${p.settings.cooldownDays} 天内被项目「${other.name}」联系过（跨项目冷却）`;
    const before = await one(ctx.db, "select 1 from messages where project_id = $1 and direction = 'out' and lower(to_addr) = $2 and kol_id <> $3 limit 1", [p.id, to, s.kolId]);
    if (before) return `${to} 已经以另一位 KOL 的身份被邀约过`;
  }

  const mx = await undeliverable(to, domains);
  if (mx) return mx;
  return "";
}
