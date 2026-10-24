import type { Lark, RecordQuery, Row } from "../../src/kolops/lark.js";

/** An in-memory base and mailbox behind the same lark-cli argument shapes the commands use. */
export class FakeLark implements Lark {
  tables: Record<string, Row[]> = {};
  inbox: Record<string, { message_id: string; from: string; subject: string; date: string; thread_id?: string }[]> = {};
  sent: { args: string[] }[] = [];
  failSend: Error | null = null;
  /** How many sends fail with `failSend` before they start working again. */
  failSendTimes = Infinity;
  options: Record<string, string[]> = { 邀约批次: ["第三十九批·新版"], 入库批次: ["第三十批"] };
  /** When set, only these tables exist (name -> field names), and table/field creation changes them. */
  schemas: Record<string, string[]> | null = null;
  /** Other projects' bases, by token, for reads that name one. */
  others: Record<string, FakeLark> = {};
  created: string[][] = [];
  /** Full text of inbox messages, for `mail +messages`. */
  bodies: Record<string, string> = {};
  private n = 0;

  table(name: string): Row[] {
    return (this.tables[name] ??= []);
  }

  /** Like Feishu, every create and update stamps the system field 更新时间. */
  add(name: string, fields: Record<string, any>): string {
    const id = `rec${++this.n}`;
    this.table(name).push({ record_id: id, 更新时间: Date.now(), ...fields });
    return id;
  }

  async records(table: string, opts: RecordQuery & { filter?: any } = {}): Promise<Row[]> {
    if (opts.baseToken && this.others[opts.baseToken]) return this.others[opts.baseToken].records(table, { ...opts, baseToken: undefined });
    return this.table(table).filter((r) => matches(r, opts.filter)).map((r) => ({ ...r }));
  }

  async json(args: string[]): Promise<any> {
    const flag = (name: string) => args[args.indexOf(name) + 1];
    const [svc, cmd] = args;
    if (svc === "base" && cmd === "+record-batch-create") {
      const ids = JSON.parse(flag("--json")).create_records.map((f: any) => this.add(flag("--table-id"), f));
      return { record_id_list: ids };
    }
    if (svc === "base" && cmd === "+record-batch-update") {
      for (const [id, f] of Object.entries<any>(JSON.parse(flag("--json")).update_records)) {
        const row = this.table(flag("--table-id")).find((r) => r.record_id === id);
        if (!row) throw new Error(`no record ${id}`);
        Object.assign(row, f, { 更新时间: Date.now() });
      }
      return {};
    }
    if (svc === "base" && cmd === "+field-list" && this.schemas) {
      const fields = this.schemas[flag("--table-id")];
      if (!fields) throw new Error(`table ${flag("--table-id")} not found`);
      return { fields: fields.map((name) => ({ name, type: "text" })) };
    }
    if (svc === "base" && cmd === "+table-create") {
      this.created.push(args);
      (this.schemas ??= {})[flag("--name")] = JSON.parse(flag("--fields")).map((f: any) => f.name);
      return {};
    }
    if (svc === "base" && cmd === "+field-create") {
      this.created.push(args);
      this.schemas![flag("--table-id")].push(JSON.parse(flag("--json")).name);
      return {};
    }
    if (svc === "base" && cmd === "+field-list") {
      return { fields: Object.entries(this.options).map(([name, opts]) => ({ name, type: "select", options: opts.map((o) => ({ name: o })) })) };
    }
    if (svc === "mail" && cmd === "+triage") {
      const filter = JSON.parse(flag("--filter"));
      let list = this.inbox[flag("--mailbox")] ?? [];
      if (filter.from) list = list.filter((m) => filter.from.includes(m.from.replace(/.*</, "").replace(">", "")));
      if (filter.time_range?.start_time) list = list.filter((m) => Date.parse(m.date) >= Date.parse(filter.time_range.start_time));
      return { messages: list };
    }
    if (svc === "mail" && cmd === "+messages") {
      return { messages: flag("--message-ids").split(",").map((id) => ({ message_id: id, body_plain_text: this.bodies[id] ?? "" })) };
    }
    if (svc === "mail" && (cmd === "+send" || cmd === "+reply")) {
      if (this.failSend && this.failSendTimes-- > 0) throw this.failSend;
      this.sent.push({ args });
      return { message_id: `msg${this.sent.length}`, thread_id: "t1" };
    }
    if (svc === "mail" && cmd === "user_mailbox.messages") return { results: [{ status: 4 }] };
    if (svc === "contact") return { user: { open_id: "ou_me", name: "测试运营" } };
    throw new Error(`fake lark: unhandled ${args.join(" ")}`);
  }
}

const dayOfCell = (v: unknown) => (typeof v === "number" ? new Date(v + 8 * 3600_000).toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));

function matches(r: Row, filter: any): boolean {
  if (!filter) return true;
  return filter.conditions.every(([field, op, value]: [string, string, any]) => {
    const v = r[field];
    // Like Feishu: ">=" on a date is rejected outright, and ">" compares whole days.
    if (op === ">=" && typeof value === "string" && value.startsWith("ExactDate(")) throw new Error("800010506 invalid_request: >= is not supported on dates");
    if (op === ">" && typeof value === "string" && value.startsWith("ExactDate(")) return dayOfCell(v) > value.slice(10, 20);
    if (op === "intersects") return (Array.isArray(v) ? v : [v]).some((x) => value.includes(x));
    if (op === "==" && typeof value === "string" && value.startsWith("ExactDate(")) return dayOfCell(v) === value.slice(10, 20);
    if (op === "==") return v === value || (Array.isArray(v) && v.includes(value));
    return true;
  });
}
