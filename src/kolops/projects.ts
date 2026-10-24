import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    throw new Error(`「${input}」看起来不是飞书多维表格的链接。请在飞书里打开这张表，复制浏览器地址栏里带 /base/ 的链接`);
  }
  return token;
}

export function addProject(name: string, base: string): Project {
  if (!name.trim()) throw new Error("项目名不能是空的");
  const r = load();
  r.projects[name] = { ...r.projects[name], baseToken: baseTokenFrom(base) };
  r.default ??= name;
  save(r);
  return { name, ...r.projects[name] };
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

export function setDataApiKey(name: string, key: string): void {
  const r = load();
  if (!r.projects[name]) throw new Error(`没有登记叫「${name}」的项目`);
  r.projects[name].dataApiKey = key.trim();
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
