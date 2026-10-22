# KOL 运营插件的共同规则

## 怎么调用脚本

所有批量操作都用插件自带的脚本，不要自己逐封调 lark-cli 发信：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kol.mjs" <命令> [选项]
```

命令：`today`、`sync`、`send`、`invite`、`remind`、`find`、`whoami`。`--help` 看完整参数。
结果是 JSON，读完用中文、按人名讲给同事听，不要把 JSON 原样贴出来。

## 先试跑，再正式跑

会发信或改表的命令（`send`、`invite`、`remind`、`find`、`sync`）第一次一律先加 `--dry-run`，把会做什么（发给谁、几封、跳过谁和原因、花多少钱）讲清楚，同事说「发」或「跑」之后再去掉 `--dry-run` 正式跑。定时任务除外，见 kol-daily。

## 不能绕开的规则

- 给 KOL 的邮件只能经过这个插件的脚本发。不要用通用的 lark-mail 技能或 `lark-cli mail +send` 直接发，否则就没有永不联系、额度、防重复这些检查，也不会留接触记录。
- 回复和协议必须先写进「审核队列」，同事在飞书里批准（处理 选「发／同意」并勾「确认发出」）后，才由 `kol send` 发出。Claude 自己不能替同事批准。
- 邀约要先有一条已批准的审核记录（类型「决定」，审核项里写明邀约批次名），才能 `kol invite`。
- 脚本报「结果不明，不会自动重发」时，不要重跑这封；请同事去飞书邮箱「已发送」里确认。
- 「控制」表里勾了「暂停所有发送」时，脚本什么都不发。只有同事明确要求才能去改这个开关。
- 改表的结构（加字段、加选项、改表名）要先问 Emma。邀约批次、入库批次的新选项请同事在飞书里手动加。
- KOL 的邮箱、来信原文不要贴到项目外面。

## 表和字段

表名和字段名、选项见同目录下的 `fields.md`。写入时字段名和选项必须完全一致，选项写成数组，例如 `{"阶段":["已回复"]}`。

单条读写用 lark-cli（base token 见 `fields.md` 开头，表可以直接用表名）：

```bash
lark-cli base +record-list --base-token <token> --table-id "KOL 跟进" --format json --limit 50 --as user \
  --filter-json '{"logic":"and","conditions":[["账号名称","intersects","某某"]]}'
lark-cli base +record-batch-update --base-token <token> --table-id "KOL 跟进" --as user \
  --json '{"update_records":{"recXXXX":{"下一步":"..."}}}'
lark-cli base +record-batch-create --base-token <token> --table-id "审核队列" --as user \
  --json '{"create_records":[{...}]}'
```

文字包含用 `intersects` 加字符串，选项用 `intersects` 加数组。返回里有 `ignored_fields` 说明有字段名写错了，要改正再写一次。
