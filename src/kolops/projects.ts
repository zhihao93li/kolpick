import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lark } from "./lark.js";
import { dataDir } from "./ops.js";

/**
 * The projects this computer works on: a name and the Feishu base holding that project's KOLs, settings
 * and templates. Kept locally (with any secrets) because the base is shared with the whole team.
 */
export interface Project {
  name: string;
  baseToken: string;
  /** Key for the project's business data API (体验码, orders), when it has one. */
  dataApiKey?: string;
  /** The separate key that may create and extend trial codes through that API. */
  trialKey?: string;
  partnerKey?: string;
}

interface Registry {
  default?: string;
  projects: Record<string, Omit<Project, "name">>;
}

function file(): string {
  return join(dataDir(), "projects.json");
}

function load(): Registry {
  return existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : { projects: {} };
}

function save(r: Registry): void {
  writeFileSync(file(), JSON.stringify(r, null, 2));
}

export function listProjects(): Project[] {
  return Object.entries(load().projects).map(([name, p]) => ({ name, ...p }));
}

/** Accepts a base token or any Feishu link to the base (…/base/<token>?table=…). */
export function baseTokenFrom(input: string): string {
  const m = input.match(/\/base\/([A-Za-z0-9]+)/);
  const token = m ? m[1] : input.trim();
  if (!/^[A-Za-z0-9]{10,}$/.test(token)) {
    throw new Error(`「${input}」看起来不是飞书多维表格的链接。请在飞书里打开这张表，复制浏览器地址栏里的链接（带 /base/ 或 /wiki/ 的都可以）`);
  }
  return token;
}

/**
 * The base token behind a link. A knowledge-base (/wiki/) link names a wiki page, not the table, so it is
 * looked up first; the page has to hold a 多维表格.
 */
export async function resolveBaseLink(lark: Lark, input: string): Promise<string> {
  if (!/\/wiki\//.test(input)) return baseTokenFrom(input);
  const node = await lark.json(["wiki", "+node-get", "--node-token", input.trim(), "--as", "user", "--format", "json"]);
  if (node?.obj_type !== "bitable" || !node?.obj_token) {
    throw new Error(`这个知识库页面「${node?.title ?? input}」不是多维表格（是 ${node?.obj_type ?? "未知"}），请给项目 KOL 总表的链接`);
  }
  return String(node.obj_token);
}

export function addProject(name: string, baseToken: string): Project {
  if (!name.trim()) throw new Error("项目名不能是空的");
  const r = load();
  r.projects[name] = { ...r.projects[name], baseToken: baseTokenFrom(baseToken) };
  r.default ??= name;
  save(r);
  // Never echo the stored API key: this result is printed and read back in conversations.
  return { name, baseToken: r.projects[name].baseToken };
}

export function setDefaultProject(name: string): void {
  const r = load();
  if (!r.projects[name]) throw new Error(`没有登记叫「${name}」的项目`);
  r.default = name;
  save(r);
}

export function removeProject(name: string): void {
  const r = load();
  if (!r.projects[name]) throw new Error(`没有登记叫「${name}」的项目`);
  delete r.projects[name];
  if (r.default === name) r.default = Object.keys(r.projects)[0];
  save(r);
}

export function setDataApiKey(name: string, key: string, which: "dataApiKey" | "trialKey" | "partnerKey" = "dataApiKey"): void {
  const r = load();
  if (!r.projects[name]) throw new Error(`没有登记叫「${name}」的项目`);
  r.projects[name][which] = key.trim();
  save(r);
}

/** The project a command runs on: the one named, else the default, else the only one. */
export function resolveProject(name?: string): Project {
  const r = load();
  const names = Object.keys(r.projects);
  if (!names.length) {
    throw new Error("这台电脑还没有登记项目。请运行 kol project add <项目名> <飞书表链接>，链接是这个项目的 KOL 总表");
  }
  const chosen = name ?? r.default ?? (names.length === 1 ? names[0] : undefined);
  if (!chosen) throw new Error(`登记了好几个项目（${names.join("、")}），请用 --project 指定用哪个`);
  const p = r.projects[chosen];
  if (!p) throw new Error(`没有登记叫「${chosen}」的项目。已登记的：${names.join("、")}`);
  return { name: chosen, ...p };
}
