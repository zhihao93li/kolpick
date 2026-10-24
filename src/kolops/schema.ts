/**
 * The standard base every project uses: table names, the fields the commands read and write, and the
 * three tables that hold a project's own settings. A new project copies an existing project's base
 * without records; `kol setup-base` adds the settings tables to a base that lacks them, and `kol check`
 * reports anything missing.
 */

export const TABLES = {
  profiles: "KOL 档案",
  followups: "KOL 跟进",
  contacts: "接触记录",
  reviews: "审核队列",
  oplog: "操作日志",
  runs: "运行记录",
  posts: "发布内容",
  settlements: "月度结算",
  settings: "设置",
  mailboxes: "发信邮箱",
  templates: "模板",
} as const;

export type TableKey = keyof typeof TABLES;

export interface FieldDef {
  name: string;
  type: "text" | "number" | "checkbox" | "datetime" | "select" | "user" | "updated_at";
  options?: string[];
  multiple?: boolean;
}

export const TEMPLATE_PURPOSES = ["邀约", "催信 1", "催信 2", "体验跟进", "其他"] as const;
export const TEMPLATE_STATES = ["草稿", "待审核", "已批准", "停用"] as const;

/** The settings tables, in creation order. The first field of each is its primary field. */
export const SETTINGS_TABLES: Record<"settings" | "mailboxes" | "templates", FieldDef[]> = {
  settings: [
    { name: "项目名称", type: "text" },
    { name: "暂停所有发送", type: "checkbox" },
    { name: "时区", type: "text" },
    { name: "找人国家", type: "text" },
    { name: "找人语言", type: "text" },
    { name: "全公司每日上限", type: "number" },
    { name: "每分钟上限", type: "number" },
    { name: "退信率暂停线", type: "number" },
    { name: "第一次催信天数", type: "number" },
    { name: "第二次催信天数", type: "number" },
    { name: "结案天数", type: "number" },
    { name: "自动催信起始日", type: "datetime" },
    { name: "不催级别", type: "text" },
    { name: "不催的对方要求", type: "text" },
    { name: "不催渠道", type: "text" },
    { name: "跨项目冷却天数", type: "number" },
    { name: "飞书群机器人", type: "text" },
    { name: "业务数据接口", type: "text" },
    { name: "说明", type: "text" },
  ],
  mailboxes: [
    { name: "邮箱", type: "text" },
    { name: "渠道名", type: "text" },
    { name: "每日上限", type: "number" },
    { name: "启用", type: "checkbox" },
    { name: "退信率暂停线", type: "number" },
    { name: "说明", type: "text" },
  ],
  templates: [
    { name: "名称", type: "text" },
    { name: "用途", type: "select", options: [...TEMPLATE_PURPOSES], multiple: false },
    { name: "方向", type: "text" },
    { name: "语言", type: "text" },
    { name: "主旨", type: "text" },
    { name: "正文", type: "text" },
    { name: "状态", type: "select", options: [...TEMPLATE_STATES], multiple: false },
    { name: "审核人", type: "user", multiple: false },
    { name: "审核时间", type: "datetime" },
    { name: "备注", type: "text" },
  ],
};

/** System fields the commands rely on in the big tables: 更新时间 lets them read only what changed (cache.ts). */
export const SYSTEM_FIELDS: Partial<Record<TableKey, FieldDef[]>> = {
  profiles: [{ name: "更新时间", type: "updated_at" }],
  followups: [{ name: "更新时间", type: "updated_at" }],
};

/** Defaults written into a new 设置 row, and used when a cell is left empty. */
export const SETTING_DEFAULTS = {
  时区: "+08:00",
  全公司每日上限: 450,
  每分钟上限: 30,
  退信率暂停线: 6,
  第一次催信天数: 5,
  第二次催信天数: 7,
  结案天数: 7,
  跨项目冷却天数: 90,
} as const;

/** Fields of the existing tables that the commands can't work without; `kol check` looks for these. */
export const REQUIRED_FIELDS: Partial<Record<TableKey, string[]>> = {
  profiles: ["账号", "账号名称", "称呼", "主页链接", "公开邮箱", "其他邮箱", "联系许可", "联系许可原因", "粉丝数",
    "主要平台", "内容类型", "市场", "語言", "合作邀约方向", "入库批次", "跟进记录", "备注", "更新时间"],
  followups: ["账号名称", "档案", "阶段", "当前轮到谁", "级别", "对方要求", "联系渠道", "邀约批次", "首次邀约日期",
    "下次跟进日期", "最近联系日期", "最后来信日期", "下一步", "结案原因", "更新时间"],
  contacts: ["方向", "渠道", "Message ID", "摘要", "内容", "日期", "待处理", "KOL"],
  reviews: ["类型", "状态", "处理", "审核结果", "确认发出", "KOL", "收件人", "发送渠道", "邮件草稿", "审核项", "要你定什么",
    "执行时间", "执行结果"],
  oplog: ["类型", "结果", "操作", "说明", "收件人明细", "邮件正文", "发送数", "时间", "KOL", "所属运行"],
  runs: ["运行", "方式", "结果", "开始时间", "结束时间", "处理来信", "发出邮件", "新增待审", "问题与备注"],
  settings: SETTINGS_TABLES.settings.map((f) => f.name),
  mailboxes: SETTINGS_TABLES.mailboxes.map((f) => f.name),
  templates: SETTINGS_TABLES.templates.map((f) => f.name),
};
