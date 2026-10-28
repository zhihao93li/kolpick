/**
 * Read-only views the console shows (docs/design.md §三 决策台): the KOL list with what each row needs at a
 * glance, the record of everything that happened, and today's sending quota.
 */
import { dayStart, type Ctx, type Project } from "./ctx.js";
import { mailboxLimit, type MailboxRow } from "./rules.js";

/** Filters the list's "needs attention" chips stand for. */
export const KOL_FLAGS: Record<string, string> = {
  us: "k.whose_turn = 'us' and k.stage <> 'closed'",
  expiry: `exists (select 1 from codes c where c.kol_id = k.id and c.kind = 'trial' and coalesce(c.active, true)
             and c.expires_at between now() and now() + interval '3 days')`,
  late: "k.stage = 'publish_agreed' and k.publish_due_at < now()",
  bounce: `exists (select 1 from messages m where m.project_id = k.project_id and m.bounce and m.resolved_at is null
             and (m.kol_id = k.id or lower(m.to_addr) = lower(k.email)))`,
  posted: "exists (select 1 from posts po where po.kol_id = k.id)",
};

const SORTS: Record<string, string> = {
  recent: "greatest(k.last_inbound_at, k.last_contact_at) desc nulls last, k.id desc",
  wait: "(k.whose_turn = 'us') desc, k.last_inbound_at asc nulls last",
  fans: "k.followers desc nulls last",
};

export interface KolQuery {
  q?: string | null;
  stage?: string | null;
  flag?: string | null;
  sort?: string | null;
  page?: number;
}

/** One page of the KOL list: each row carries its last message, codes, posts and open card. */
export async function kolList(ctx: Ctx, p: Project, o: KolQuery) {
  const where = ["k.project_id = $1"];
  const args: unknown[] = [p.id];
  if (o.q) {
    args.push(o.q);
    where.push(`(k.name ilike '%'||$${args.length}||'%' or k.handle ilike '%'||$${args.length}||'%' or k.email ilike '%'||$${args.length}||'%')`);
  }
  if (o.stage) {
    args.push(o.stage);
    where.push(`k.stage = $${args.length}`);
  }
  if (o.flag && KOL_FLAGS[o.flag]) where.push(KOL_FLAGS[o.flag]);
  const order = SORTS[o.sort ?? "recent"] ?? SORTS.recent;
  args.push((o.page ?? 0) * 50);
  const rows = await ctx.db.query<any>(
    `select k.id, k.name, k.handle, k.platform, k.url, k.market, k.email, k.followers, k.stage, k.whose_turn, k.next_step,
            k.last_contact_at, k.last_inbound_at, k.publish_due_at, k.never_contact, k.close_reason,
            (${KOL_FLAGS.expiry}) as flag_expiry, (${KOL_FLAGS.late}) as flag_late, (${KOL_FLAGS.bounce}) as flag_bounce,
            (select json_build_object('direction', m.direction, 'at', m.at, 'subject', m.subject, 'text', left(coalesce(m.summary, m.body, ''), 160))
               from messages m where m.kol_id = k.id and m.direction <> 'note' order by m.at desc limit 1) as last_message,
            (select json_agg(json_build_object('kind', c.kind, 'code', c.code, 'used', c.used, 'max_uses', c.max_uses, 'expires_at', c.expires_at,
                     'paid_orders', c.paid_orders, 'visitors', c.visitors) order by c.created_at)
               from codes c where c.kol_id = k.id) as codes,
            (select json_agg(json_build_object('url', po.url, 'format', po.format, 'platform', po.platform, 'published_at', po.published_at,
                     'metrics', po.metrics) order by po.published_at desc nulls last)
               from posts po where po.kol_id = k.id) as posts,
            (select pr.id from proposals pr where pr.kol_id = k.id and pr.status in ('pending', 'unknown', 'failed') and pr.parent_id is null
               order by pr.id limit 1) as open_card
     from kols k where ${where.join(" and ")} order by ${order} limit 50 offset $${args.length}`, args);
  return rows;
}

/** How many KOLs per stage and per attention chip, for the list's filters. */
export async function kolCounts(ctx: Ctx, p: Project) {
  // Each chip is its own count (one combined scan is far slower), all at once alongside the stage counts.
  const names = Object.keys(KOL_FLAGS);
  const [stages, ...ns] = await Promise.all([
    ctx.db.query<{ stage: string; n: number }>("select stage, count(*)::int as n from kols where project_id = $1 group by stage", [p.id]),
    ...names.map((name) => ctx.db.query<{ n: number }>(`select count(*)::int as n from kols k where k.project_id = $1 and ${KOL_FLAGS[name]}`, [p.id])),
  ]);
  const flags = Object.fromEntries(names.map((name, i) => [name, (ns[i] as { n: number }[])[0]?.n ?? 0]));
  return { stages: Object.fromEntries((stages as { stage: string; n: number }[]).map((s) => [s.stage, s.n])), flags };
}

/** Kinds of log rows that mean something went wrong. */
export const BAD_KINDS = ["send_failed", "unknown", "error", "agent_stuck"];

/** The record: everything that happened, newest first, without telling who did it apart. */
export async function logList(ctx: Ctx, p: Project, o: { q?: string | null; bad?: boolean; days?: number; before?: number | null; kol?: number | null }) {
  const since = new Date(ctx.now() - (o.days ?? 2) * 86_400_000).toISOString();
  const args: unknown[] = [p.id, since];
  let extra = "";
  if (o.q) {
    args.push(o.q);
    extra += ` and (l.summary ilike '%'||$${args.length}||'%' or k.name ilike '%'||$${args.length}||'%')`;
  }
  if (o.bad) {
    args.push(BAD_KINDS);
    extra += ` and l.kind = any($${args.length})`;
  }
  if (o.kol) {
    args.push(o.kol);
    extra += ` and l.kol_id = $${args.length}`;
  }
  if (o.before) {
    args.push(o.before);
    extra += ` and l.id < $${args.length}`;
  }
  return ctx.db.query(
    `select l.id, l.at, l.kind, l.summary, l.detail, l.kol_id, l.proposal_id, k.name as kol_name, l.kind = any($${args.length + 1}) as bad
     from log l left join kols k on k.id = l.kol_id
     where l.project_id = $1 and l.at >= $2${extra} order by l.at desc, l.id desc limit 200`, [...args, BAD_KINDS]);
}

/** Today's numbers for the top of the record and the quota bars. */
export async function usage(ctx: Ctx, p: Project) {
  const today = dayStart(ctx.now(), p.settings.timezone);
  const n = async (sql: string) => (await ctx.db.query<{ n: number }>(sql, [p.id, today]))[0]?.n ?? 0;
  const [boxes, contacted, incoming, sent, approved, revised, errors] = await Promise.all([
    ctx.db.query<MailboxRow & { id: number; used: number }>(
      `select mb.*, (select count(distinct lower(m.to_addr))::int from messages m where m.project_id = mb.project_id and m.direction = 'out'
         and lower(m.mailbox) = lower(mb.address) and m.at >= $2) as used
       from mailboxes mb where mb.project_id = $1 order by mb.id`, [p.id, today]),
    n("select count(distinct kol_id)::int as n from messages where project_id = $1 and direction = 'out' and at >= $2"),
    n("select count(*)::int as n from messages where project_id = $1 and direction = 'in' and at >= $2"),
    n("select count(*)::int as n from messages where project_id = $1 and direction = 'out' and at >= $2"),
    n("select count(*)::int as n from log where project_id = $1 and kind = 'approve' and at >= $2"),
    n("select count(*)::int as n from log where project_id = $1 and kind = 'revise' and at >= $2"),
    n(`select count(*)::int as n from log where project_id = $1 and at >= $2 and kind in (${BAD_KINDS.map((k) => `'${k}'`).join(",")})`),
  ]);
  return {
    mailboxes: boxes.map((b) => ({ ...b, limit_today: mailboxLimit(b, ctx.now(), p.settings.timezone) })),
    contacted, dailyLimit: p.settings.dailyLimit, incoming, sent, approved, revised, errors,
  };
}
