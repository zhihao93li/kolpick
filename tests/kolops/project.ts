import { configFrom, type Config } from "../../src/kolops/config.js";
import { TABLES } from "../../src/kolops/schema.js";
import type { FakeLark } from "./fake.js";

export const BASE = "baseTestToken001";

/** A project set up the way TAFU's base is: its 设置 row, two mailboxes and approved templates. */
export const SETTINGS = {
  项目名称: "测试项目", 时区: "+08:00", 全公司每日上限: 450, 每分钟上限: 30, 退信率暂停线: 6,
  第一次催信天数: 5, 第二次催信天数: 7, 结案天数: 7, 自动催信起始日: "2026-10-22 00:00",
  不催级别: "S、A", 不催的对方要求: "只接固定费、固定费加分润", 不催渠道: "IG 私信、tafuofficial Gmail",
  跨项目冷却天数: 90, 暂停所有发送: false,
};

export const MAILBOXES = [
  { 邮箱: "hello@tafu.me", 渠道名: "hello@tafu.me", 每日上限: 150, 启用: true },
  { 邮箱: "mei@tafu.me", 渠道名: "mei@tafu.me", 每日上限: 150, 启用: true },
  { 邮箱: "old@tafu.me", 渠道名: "old@tafu.me", 每日上限: 150, 启用: false },
];

export const TEMPLATES = [
  { 名称: "邀约-新版-伴侶", 用途: ["邀约"], 状态: ["已批准"], 主旨: "想送 {稱呼} 和另一半一份免費的關係合盤", 正文: "{稱呼} 您好：\n\n想送您 3 次免費的完整體驗。" },
  { 名称: "邀约-草稿", 用途: ["邀约"], 状态: ["待审核"], 主旨: "還沒批", 正文: "{稱呼} 您好" },
  { 名称: "催信-1", 用途: ["催信 1"], 状态: ["已批准"], 主旨: "想送 {稱呼} 3 次免費的完整體驗", 正文: "{稱呼} 您好：\n\n再輕輕提醒一次。" },
  { 名称: "催信-2", 用途: ["催信 2"], 状态: ["已批准"], 主旨: "最後一次打擾：{稱呼} 的免費體驗", 正文: "{稱呼} 您好：\n\n這是最後一次打擾。" },
];

/** Fills the fake base's settings tables and returns the Config a command would load from them. */
export function seedProject(lark: FakeLark, over: Partial<typeof SETTINGS> = {}): Config {
  const settings = { ...SETTINGS, ...over };
  lark.add(TABLES.settings, settings);
  MAILBOXES.forEach((m) => lark.add(TABLES.mailboxes, m));
  TEMPLATES.forEach((t) => lark.add(TABLES.templates, t));
  return configFrom("测试项目", BASE, { record_id: "set1", ...settings }, MAILBOXES.map((m, i) => ({ record_id: `mb${i}`, ...m })));
}
