# KOL 运营插件的共同规则

## 怎么调用脚本

所有批量操作都用插件自带的脚本，不要自己逐封调 lark-cli 发信：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kol.mjs" <命令> [选项]
```

命令：`today`、`sync`、`inbox`、`send`、`invite`、`remind`、`find`、`classify`、`metrics`、`codes`、`trial-followup`、`trial-check`、`notify`、`whoami`、`check`、`project`、`setup-base`。`--help` 看完整参数。

## 项目

插件可以给好几个项目用，每个项目一张飞书表。命令默认用这台电脑的默认项目，同事说的是别的项目就加 `--project <项目名>`。
脚本报「这台电脑还没有登记项目」时，请同事给出这个项目 KOL 总表的飞书链接，运行 `kol.mjs project add <项目名> <链接>`。
报「读不到设置表」时，这张飞书表还没升级：先 `setup-base --dry-run` 把要加的表讲给同事，同意后再去掉 `--dry-run`。

脚本报「飞书授权缺少权限」时，先跑 `check`，把缺哪些权限、怎么补讲给同事，不要自己去登录或改授权。

结果是 JSON，读完用中文、按人名讲给同事听，不要把 JSON 原样贴出来。

## 先试跑，再正式跑

会发信或改表的命令（`send`、`invite`、`remind`、`find`、`sync`、`inbox --apply`）第一次一律先加 `--dry-run`（`classify --apply` 只补档案字段，找人后直接跑，见 kol-find），把会做什么（发给谁、几封、跳过谁和原因、花多少钱）讲清楚，同事说「发」或「跑」之后再去掉 `--dry-run` 正式跑。定时任务除外，见 kol-daily。

## 不能绕开的规则

- 给 KOL 的邮件只能经过这个插件的脚本发。不要用通用的 lark-mail 技能或 `lark-cli mail +send` 直接发，否则就没有永不联系、额度、防重复这些检查，也不会留接触记录。
- 回复和协议必须先写进「审核队列」，同事在飞书里批准（「处理」选「发／同意」；「确认发出」不再需要，「审核结果」里留着「先不发」「退回修改」「不同意」的仍然不发）后，才由 `kol send` 发出。Claude 自己不能替同事批准。
- 邀约要先有一条已批准的审核记录（类型「决定」，审核项里写明邀约批次名），才能 `kol invite`。
- 体验码只能通过审核队列里批准过的「发码」「延期」来建和延，由 `kol send` 执行。不要去 TAFU 后台或用别的办法建码，那样不会留在跟进记录里。
- 脚本报「结果不明，不会自动重发」时，不要重跑这封；请同事去飞书邮箱「已发送」里确认。
- 「设置」表里勾了「暂停所有发送」时，脚本什么都不发。只有同事明确要求才能去改这个开关。
- 发信规则（额度、催信天数、谁不催）、发信邮箱和邮件模板都在项目飞书表的「设置」「发信邮箱」「模板」里。同事要改规则，就去改那几张表，不要改插件。模板只有「已批准」的才会被用，Claude 不能替同事把模板改成「已批准」。
- 改表的结构（加字段、加选项、改表名）要先问项目负责人；`setup-base` 只加表和字段，也要先试跑给同事看。邀约批次、入库批次的新选项请同事在飞书里手动加。
- KOL 的邮箱、来信原文不要贴到项目外面。

## 表和字段

表名和字段名、选项见同目录下的 `fields.md`。写入时字段名和选项必须完全一致，选项写成数组，例如 `{"阶段":["已回复"]}`。

单条读写用 lark-cli（base token 用 `kol.mjs project list` 查，表可以直接用表名）：

```bash
lark-cli base +record-list --base-token <token> --table-id "KOL 跟进" --format json --limit 50 --as user \
  --filter-json '{"logic":"and","conditions":[["账号名称","intersects","某某"]]}'
lark-cli base +record-batch-update --base-token <token> --table-id "KOL 跟进" --as user \
  --json '{"update_records":{"recXXXX":{"下一步":"..."}}}'
lark-cli base +record-batch-create --base-token <token> --table-id "审核队列" --as user \
  --json '{"create_records":[{...}]}'
```

文字包含用 `intersects` 加字符串，选项用 `intersects` 加数组。返回里有 `ignored_fields` 说明有字段名写错了，要改正再写一次。
