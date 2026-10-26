# KOL 运营插件的共同规则

## 怎么调用脚本

所有批量操作都用插件自带的脚本，不要自己逐封调 lark-cli 发信：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kol.mjs" <命令> [选项]
```

命令：`today`、`console`、`executor`、`sync`、`inbox`、`send`、`revise`、`invite`、`remind`、`find`、`classify`、`metrics`、`codes`、`trial-followup`、`posts`、`trial-check`、`notify`、`whoami`、`check`、`project`、`setup-base`。`--help` 看完整参数。同事说「打开决策台」时，用 `run_in_background` 运行 `console`（它会一直开着），把它打印的地址告诉同事。

## 项目

插件可以给好几个项目用，每个项目一套表，放在 Postgres 或飞书多维表格里（`kol.mjs db status` 看是哪边）。脚本的命令两边都能用，不用管表在哪。命令默认用这台电脑的默认项目，同事说的是别的项目就加 `--project <项目名>`。
脚本报「这台电脑还没有登记项目」时，请同事给出这个项目 KOL 总表的飞书链接，运行 `kol.mjs project add <项目名> <链接>`。
报「读不到设置表」时，这个项目的表还没升级：先 `setup-base --dry-run` 把要加的表讲给同事，同意后再去掉 `--dry-run`。

## 执行电脑和决策台

- 会碰外面的命令（`sync`、`send`、`invite`、`remind`、`find`、`posts`、`metrics`、`codes`、`trial-followup`）只在项目的执行电脑上跑，一次只跑一件。报「不是这个项目的执行电脑」时不要想办法绕过，告诉同事这件事要在执行电脑上做，或者到执行电脑的决策台里点；报「执行器正在做…」是另一件事还没做完，脚本会自己等最多 10 分钟。
- `kol executor` 看这台电脑是不是执行电脑。`kol executor claim` 会把执行电脑换成这台，只在同事明确要换时才跑。
- 决策台（`console`）是同事每天做决定的地方：同意、要改、不用回、关联陌生来信、暂停发信都在那里点，点了马上排队执行。
- 「设置」勾了「只认决策台的同意」以后，飞书审核队列里改的「发／同意」不再执行，`send` 会跳过并说明原因；同事要发，就请他在决策台里点同意。
- 一位 KOL 同时只能有一封待发的信。`inbox` 里「已有待发」不是空的，就把旧草稿的意思和新来信合并成一封，并在决定里写 `"replaces": "那条审核记录的 id"`。

脚本报「飞书授权缺少权限」时，先跑 `check`，把缺哪些权限、怎么补讲给同事，不要自己去登录或改授权。

结果是 JSON，读完用中文、按人名讲给同事听，不要把 JSON 原样贴出来。

## 先试跑，再正式跑

会发信或改表的命令（`send`、`invite`、`remind`、`find`、`sync`、`inbox --apply`）第一次一律先加 `--dry-run`（`classify --apply` 只补档案字段，找人后直接跑，见 kol-find），把会做什么（发给谁、几封、跳过谁和原因、花多少钱）讲清楚，同事说「发」或「跑」之后再去掉 `--dry-run` 正式跑。定时任务除外，见 kol-daily。

## 不能绕开的规则

- 给 KOL 的邮件只能经过这个插件的脚本发。不要用通用的 lark-mail 技能或 `lark-cli mail +send` 直接发，否则就没有永不联系、额度、防重复这些检查，也不会留接触记录。
- 回复和协议必须先写进「审核队列」，同事批准后才发出：在决策台里点「同意」（马上排队发出）；没勾「只认决策台的同意」时，在飞书里把「处理」选「发／同意」再由 `kol send` 发出也算。「审核结果」里留着「先不发」「退回修改」「不同意」的仍然不发。Claude 自己不能替同事批准。批准之后草稿、收件人或附带动作又被改过的，会退回重新审核。
- 邀约要先有一条已批准的审核记录（类型「决定」，审核项里写明邀约批次名），才能 `kol invite`。
- 体验码只能通过审核队列里批准过的「发码」「延期」来建和延，活动码只能通过批准过的「开活动码」来开，都由 `kol send` 执行。不要去 TAFU 后台或用别的办法建码，那样不会留在跟进记录里。要特殊条款（固定分润、别的优惠）的活动不走插件，请项目负责人在后台手动开，开完把码名填进跟进的「活动码」。
- 脚本报「结果不明，不会自动重发」时，不要重跑这封；请同事去飞书邮箱「已发送」里确认。
- 「设置」表里勾了「暂停所有发送」时，脚本什么都不发。只有同事明确要求才能去改这个开关。
- 发信规则（额度、催信天数、谁不催）、发信邮箱和邮件模板都在项目的「设置」「发信邮箱」「模板」表里，不在插件里。同事要改，按插件说明「改设置、发信邮箱、模板」去改，不要改插件。模板只有「已批准」的才会被用，Claude 不能替同事把模板改成「已批准」。
- 改表的结构（加字段、加选项、改表名）要先问项目负责人；`setup-base` 只加表和字段，也要先试跑给同事看。邀约批次、入库批次的新选项：飞书表上的项目请同事在飞书里手动加；Postgres 上的项目第一次写到就会自动加。
- KOL 的邮箱、来信原文不要贴到项目外面。

## 表和字段

表名和字段名、选项见同目录下的 `fields.md`。写入时字段名和选项必须完全一致，选项写成数组，例如 `{"阶段":["已回复"]}`。

**项目在 Postgres 上时，不要用下面的 lark-cli 命令**：它们读写的是已经冻结的飞书表，读到的是旧数据，写了也不会生效。这时只用脚本的命令；脚本做不到的单条读写，告诉同事这件事要在决策台里做。（给脚本加单条读写命令在待做里。）

项目在飞书表上时，单条读写用 lark-cli（base token 用 `kol.mjs project list` 查，表可以直接用表名）：

```bash
lark-cli base +record-list --base-token <token> --table-id "KOL 跟进" --format json --limit 50 --as user \
  --filter-json '{"logic":"and","conditions":[["账号名称","intersects","某某"]]}'
lark-cli base +record-batch-update --base-token <token> --table-id "KOL 跟进" --as user \
  --json '{"update_records":{"recXXXX":{"下一步":"..."}}}'
lark-cli base +record-batch-create --base-token <token> --table-id "审核队列" --as user \
  --json '{"create_records":[{...}]}'
```

文字包含用 `intersects` 加字符串，选项用 `intersects` 加数组。返回里有 `ignored_fields` 说明有字段名写错了，要改正再写一次。
