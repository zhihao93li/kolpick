import type { Lark, Row } from "../../src/kolops/lark.js";

/** An in-memory base and mailbox behind the same lark-cli argument shapes the commands use. */
export class FakeLark implements Lark {
  tables: Record<string, Row[]> = {};
  inbox: Record<string, { message_id: string; from: string; subject: string; date: string; thread_id?: string }[]> = {};
  sent: { args: string[] }[] = [];
  failSend: Error | null = null;
  /** How many sends fail with `failSend` before they start working again. */
  failSendTimes = Infinity;
  options: Record<string, string[]> = { 邀约批次: ["第三十九批·新版"], 入库批次: ["第三十批"] };
  private n = 0;

  table(name: string): Row[] {
    return (this.tables[name] ??= []);
  }

  add(name: string, fields: Record<string, any>): string {
    const id = `rec${++this.n}`;
    this.table(name).push({ record_id: id, ...fields });
    return id;
  }

  async records(table: string, opts: { filter?: any; fields?: string[] } = {}): Promise<Row[]> {
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
        Object.assign(row, f);
      }
      return {};
    }
    if (svc === "base" && cmd === "+field-list") {
      return { fields: Object.entries(this.options).map(([name, opts]) => ({ name, type: "select", options: opts.map((o) => ({ name: o })) })) };
    }
    if (svc === "mail" && cmd === "+triage") {
      const filter = JSON.parse(flag("--filter"));
      let list = this.inbox[flag("--mailbox")] ?? [];
      if (filter.from) list = list.filter((m) => filter.from.includes(m.from.replace(/.*</, "").replace(">", "")));
      return { messages: list };
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

function matches(r: Row, filter: any): boolean {
  if (!filter) return true;
  return filter.conditions.every(([field, op, value]: [string, string, any]) => {
    const v = r[field];
    if (op === "intersects") return (Array.isArray(v) ? v : [v]).some((x) => value.includes(x));
    if (op === "==" && typeof value === "string" && value.startsWith("ExactDate(")) return String(v ?? "").slice(0, 10) === value.slice(10, 20);
    if (op === ">=" && typeof value === "string" && value.startsWith("ExactDate(")) return String(v ?? "").slice(0, 10) >= value.slice(10, 20);
    if (op === "==") return v === value || (Array.isArray(v) && v.includes(value));
    return true;
  });
}
