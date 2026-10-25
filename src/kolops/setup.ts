import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { option, text, type Base } from "./base.js";
import { EXTRA_FIELDS, REQUIRED_FIELDS, SETTING_DEFAULTS, SETTINGS_TABLES, TABLES, type FieldDef, type TableKey } from "./schema.js";
import { parseTemplateFile } from "./templates.js";

function fieldJson(f: FieldDef): Record<string, unknown> {
  return {
    name: f.name, type: f.type,
    ...(f.options ? { options: f.options.map((name) => ({ name })) } : {}),
    ...(f.multiple != null ? { multiple: f.multiple } : {}),
  };
}

/** What a template file's name says it is for: 邀约-… is an invitation, 催信-1 the first reminder, and so on. */
export function purposeOf(fileName: string): string {
  if (fileName.startsWith("邀约")) return "邀约";
  if (/^催信[-\s]?1/.test(fileName)) return "催信 1";
  if (/^催信[-\s]?2/.test(fileName)) return "催信 2";
  if (/^体验[-\s]?未用/.test(fileName)) return "体验未用";
  if (/^体验[-\s]?到期/.test(fileName)) return "体验到期";
  if (fileName.startsWith("体验码延期")) return "体验码延期";
  if (fileName.startsWith("发体验码")) return "发体验码";
  if (fileName.startsWith("体验")) return "体验跟进";
  return "其他";
}

export interface SetupReport {
  dryRun: boolean;
  建表: string[];
  加字段: string[];
  加选项: string[];
  写入默认设置: boolean;
  导入模板: string[];
  说明: string;
}

/**
 * `kol setup-base`: adds the 设置, 发信邮箱 and 模板 tables (and any of their fields) a base lacks, writes a
 * default 设置 row when there is none, and optionally imports template files as 待审核. Never changes or
 * deletes anything that is already there.
 */
export async function setupBase(base: Base, o: { project: string; dryRun: boolean; importDir?: string; templateLanguage?: string }): Promise<SetupReport> {
  const report: SetupReport = { dryRun: o.dryRun, 建表: [], 加字段: [], 加选项: [], 写入默认设置: false, 导入模板: [], 说明: "" };
  const fresh = new Set<string>();

  for (const [key, defs] of Object.entries(SETTINGS_TABLES) as [keyof typeof SETTINGS_TABLES, FieldDef[]][]) {
    const table = TABLES[key];
    const have = await base.fieldNames(table);
    if (have == null) {
      report.建表.push(`${table}（${defs.map((f) => f.name).join("、")}）`);
      fresh.add(table);
      if (!o.dryRun) {
        await base.lark.json(["base", "+table-create", "--base-token", base.token, "--name", table,
          "--fields", JSON.stringify(defs.map(fieldJson)), "--as", "user"]);
      }
      continue;
    }
    for (const f of defs.filter((d) => !have.includes(d.name))) {
      report.加字段.push(`${table}.${f.name}`);
      if (!o.dryRun) {
        await base.lark.json(["base", "+field-create", "--base-token", base.token, "--table-id", table,
          "--json", JSON.stringify(fieldJson(f)), "--as", "user"]);
      }
    }
  }

  for (const [key, defs] of Object.entries(EXTRA_FIELDS) as [TableKey, FieldDef[]][]) {
    const have = await base.fieldNames(TABLES[key]);
    if (have == null) continue; // a base without this table is reported by check, not created here
    for (const f of defs.filter((d) => !have.includes(d.name))) {
      report.加字段.push(`${TABLES[key]}.${f.name}`);
      if (!o.dryRun) {
        await base.lark.json(["base", "+field-create", "--base-token", base.token, "--table-id", TABLES[key],
          "--json", JSON.stringify(fieldJson(f)), "--as", "user"]);
      }
    }
  }

  // Select fields the plugin owns gain any option a newer plugin needs (模板.用途 got 发体验码 and 体验码延期).
  const owned: [string, FieldDef][] = [
    ...Object.entries(SETTINGS_TABLES).flatMap(([k, defs]) => defs.map((f) => [TABLES[k as TableKey], f] as [string, FieldDef])),
    ...Object.entries(EXTRA_FIELDS).flatMap(([k, defs]) => defs!.map((f) => [TABLES[k as TableKey], f] as [string, FieldDef])),
  ].filter(([, f]) => f.type === "select" && f.options);
  for (const [table, f] of owned) {
    if (fresh.has(table) || report.加字段.includes(`${table}.${f.name}`)) continue;
    const have = await base.fieldOptions(table, f.name);
    const missing = have ? f.options!.filter((x) => !have.includes(x)) : [];
    if (!have || !missing.length) continue;
    report.加选项.push(...missing.map((x) => `${table}.${f.name}：${x}`));
    if (!o.dryRun) {
      // Feishu replaces a select's whole option list, so the existing options go first, unchanged.
      await base.lark.json(["base", "+field-update", "--base-token", base.token, "--table-id", table, "--field-id", f.name,
        "--json", JSON.stringify(fieldJson({ ...f, options: [...have, ...missing] })), "--as", "user", "--yes"]);
    }
  }

  const settingsRows = fresh.has(TABLES.settings) ? [] : await base.records(TABLES.settings);
  if (!settingsRows.length) {
    report.写入默认设置 = true;
    if (!o.dryRun) await base.create(TABLES.settings, [{ 项目名称: o.project, ...SETTING_DEFAULTS }]);
  }

  if (o.importDir) {
    if (!existsSync(o.importDir)) throw new Error(`找不到模板文件夹 ${o.importDir}`);
    const existing = fresh.has(TABLES.templates) ? [] : await base.records(TABLES.templates, { fields: ["名称"] });
    const names = new Set(existing.map((r) => text(r["名称"])));
    const rows = readdirSync(o.importDir).filter((f) => f.endsWith(".txt")).sort().flatMap((file) => {
      const name = file.slice(0, -4);
      if (names.has(name)) return [];
      const { subject, body } = parseTemplateFile(readFileSync(join(o.importDir!, file), "utf8"));
      report.导入模板.push(name);
      return [{ 名称: name, 用途: [purposeOf(name)], 主旨: subject, 正文: body, 状态: ["待审核"],
        ...(o.templateLanguage ? { 语言: o.templateLanguage } : {}) }];
    });
    if (!o.dryRun && rows.length) await base.create(TABLES.templates, rows);
  }

  report.说明 = report.写入默认设置
    ? "「设置」里写了默认值。还要人工填：找人国家、找人语言、自动催信起始日、不催的级别/要求/渠道；在「发信邮箱」里加发信邮箱并勾「启用」；在「模板」里把要用的模板改成「已批准」"
    : "已有的设置没有改动";
  return report;
}

export interface BaseCheck {
  缺少的表: string[];
  缺少的字段: string[];
  启用的发信邮箱: number;
  已批准的模板: string[];
}

/** For `kol check`: whether the base has every table and field the commands use. */
export async function checkBase(base: Base): Promise<BaseCheck> {
  const out: BaseCheck = { 缺少的表: [], 缺少的字段: [], 启用的发信邮箱: 0, 已批准的模板: [] };
  for (const [key, fields] of Object.entries(REQUIRED_FIELDS) as [TableKey, string[]][]) {
    const have = await base.fieldNames(TABLES[key]);
    if (have == null) out.缺少的表.push(TABLES[key]);
    else out.缺少的字段.push(...fields.filter((f) => !have.includes(f)).map((f) => `${TABLES[key]}.${f}`));
  }
  if (!out.缺少的表.includes(TABLES.mailboxes)) {
    out.启用的发信邮箱 = (await base.records(TABLES.mailboxes)).filter((r) => r["启用"] === true).length;
  }
  if (!out.缺少的表.includes(TABLES.templates)) {
    out.已批准的模板 = (await base.records(TABLES.templates))
      .filter((r) => option(r["状态"]) === "已批准").map((r) => `${text(r["名称"])}（${option(r["用途"])}）`);
  }
  return out;
}
