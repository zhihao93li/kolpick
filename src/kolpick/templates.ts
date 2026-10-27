/**
 * Templates. Changing one in use only makes a draft; the version in use keeps going out until the draft is
 * approved (in the console, comparing old and new), then the draft takes its place.
 */
import { type Ctx, type Project } from "./ctx.js";
import { one } from "./db/db.js";
import { proposeDecision } from "./proposals.js";

export const PURPOSES = ["邀约", "催信 1", "催信 2", "发体验码", "体验码延期", "体验跟进", "体验未用", "体验到期", "发活动码", "发布确认", "其他"];

export interface TemplateDraft {
  /** The template this draft changes; omit for a new one. */
  templateId?: number;
  name: string;
  purpose: string;
  language?: string;
  subject?: string;
  body: string;
  note?: string;
  why?: string;
  who?: string;
}

export async function draftTemplate(ctx: Ctx, p: Project, d: TemplateDraft): Promise<{ draft: number; card: number }> {
  if (!PURPOSES.includes(d.purpose)) throw new Error(`用途只能是 ${PURPOSES.join("、")}`);
  if (!d.body.trim()) throw new Error("模板正文是空的");
  let base: any;
  if (d.templateId) {
    base = await one<any>(ctx.db, "select * from templates where id = $1 and project_id = $2", [d.templateId, p.id]);
    if (!base) throw new Error(`没有编号 ${d.templateId} 的模板`);
  }
  // Editing a draft just rewrites it; editing an active template makes (or rewrites) its one draft.
  const target = base?.status === "draft" ? base : base ? await one<any>(ctx.db, "select * from templates where draft_of = $1", [base.id]) : undefined;
  let id: number;
  if (target) {
    await ctx.db.query("update templates set name=$2, purpose=$3, language=$4, subject=$5, body=$6, note=$7, updated_at=now() where id=$1",
      [target.id, d.name, d.purpose, d.language ?? null, d.subject ?? null, d.body, d.note ?? null]);
    id = target.id;
  } else {
    const r = await one<{ id: number }>(ctx.db,
      "insert into templates (project_id, name, purpose, language, subject, body, status, draft_of, note) values ($1,$2,$3,$4,$5,$6,'draft',$7,$8) returning id",
      [p.id, d.name, d.purpose, d.language ?? null, d.subject ?? null, d.body, base?.status === "active" ? base.id : null, d.note ?? null]);
    id = r!.id;
  }
  await ctx.db.query("update proposals set status='superseded', result='模板又改了', done_at=now() where project_id=$1 and kind='template' and status='pending' and (action->>'template_id')::int = $2", [p.id, id]);
  const card = await proposeDecision(ctx, p, { kind: "template", title: `模板「${d.name}」${base?.status === "active" ? "新版" : "待启用"}`, why: d.why, action: { template_id: id }, who: d.who });
  return { draft: id, card: card.id };
}

export async function listTemplates(ctx: Ctx, p: Project): Promise<any[]> {
  return ctx.db.query("select id, name, purpose, language, subject, body, status, draft_of, approved_at, note, updated_at from templates where project_id = $1 order by purpose, name, id", [p.id]);
}
