# KOL 运营插件（kol-ops）

给运营同事装在 Claude 桌面版里用，做 KOL 外联：找人、邀约、收信、审核后发信、催信和结案。

可以给多个项目用。每个项目一张飞书多维表格（它的 KOL 总表），项目自己的发信规则、发信邮箱和邮件模板也都放在这张表的「设置」「发信邮箱」「模板」里，插件里不写任何项目专属的内容。发信用飞书邮箱，所有读写都经过本机的 lark-cli。

## 安装

### 准备

- 电脑上装好 Node.js 22 或更新的版本（终端里 `node --version` 能看到 v22 以上）。
- lark-cli 用 1.0.73 到 1.0.98 之间的版本（`lark-cli --version`）。这两个版本都实测过；更新版本先让 Claude 跑一遍 `kol.mjs check` 和几个命令的 `--dry-run` 再用。
- 电脑上装好 lark-cli，并用公司飞书账号登录过。
- 你的 GitHub 账号能访问私有仓库 zhihao93li/kolpick，没有权限就找项目负责人加。

### 管理员先开通权限（整个公司只做一次）

lark-cli 登录用的是公司的一个飞书应用，`lark-cli auth status` 里的 appId 就是它。这个应用现在只开通了云文档和多维表格权限，还没有邮箱和通讯录权限。在开通之前，同事怎么登录都拿不到这些权限。

请飞书管理员到飞书开放平台，打开这个应用的「权限管理」，开通下面这些用户权限，然后发布一个新版本：

- 通讯录：`contact:user.basic_profile:readonly`
- 邮箱：`mail:user_mailbox:readonly`、`mail:user_mailbox.message:readonly`、`mail:user_mailbox.message.address:read`、`mail:user_mailbox.message.subject:read`、`mail:user_mailbox.message.body:read`、`mail:user_mailbox.message:modify`、`mail:user_mailbox.message:send`

用插件发信的同事，还要在飞书邮箱里有项目「发信邮箱」表里那些邮箱的权限（TAFU 是 hello@tafu.me 和 mei@tafu.me）。

### 每位同事

1. 重新授权 lark-cli。在终端运行下面这条命令，它会给出一个链接，在浏览器里打开并同意：
   ```
   lark-cli auth login --scope "base:record:read base:record:create base:record:update base:field:read contact:user.basic_profile:readonly mail:user_mailbox:readonly mail:user_mailbox.message:readonly mail:user_mailbox.message.address:read mail:user_mailbox.message.subject:read mail:user_mailbox.message.body:read mail:user_mailbox.message:modify mail:user_mailbox.message:send"
   ```
   用同一串权限运行 `lark-cli auth check --scope "…"`，结果里 `missing` 是空的，就说明授权齐了。
2. 在 Claude 桌面版的 Code 里运行：
   ```
   /plugin marketplace add zhihao93li/kolpick#stable
   /plugin install kol-ops@kolpick
   ```
   `#stable` 是验证过的发布版；不带它装的是开发中的版本。以前按 `zhihao93li/kolpick` 或 `zhihao93li/kolpick#claude/project-thread-eps57k` 装过的，先用 `/plugin marketplace remove kolpick` 删掉旧的，再运行上面两条。之后有新版本，运行 `/plugin marketplace update kolpick` 再新开一个会话就行。
3. 新开一个会话（插件只在新会话里生效），对 Claude 说「登记项目 TAFU，飞书表是 <链接>」。链接就是在飞书里打开这个项目 KOL 总表时浏览器地址栏里带 `/base/` 的那个。这一步每台电脑每个项目做一次。
4. 试一下：对 Claude 说「今天有什么事」。如果它说飞书授权缺少权限，就照它给的提示补，或者让它跑一下 `kol.mjs check`，看缺了哪些。

### 接入一个新项目

1. 在飞书里打开一个现有项目的 KOL 总表，用「创建副本」复制一份，不带记录。
2. 按上面第 3 步登记新项目，然后让 Claude 跑 `kol.mjs setup-base --dry-run --project <新项目名>`。表是从现有项目复制来的话，通常什么都不用加；缺「设置」「发信邮箱」「模板」时它会列出来，同意后去掉 `--dry-run` 就会加上，并写一行默认设置。这一步要求登录的账号有建表权限（`base:table:create`、`base:field:create`）。
3. 在新表里填好：
   - 「设置」：找人国家和语言、催信规则、自动催信起始日；
   - 「发信邮箱」：每个邮箱一行，勾「启用」；
   - 「模板」：邀约和催信模板，状态改成「已批准」。
4. 项目后台想让插件看到体验码、活动码的数据，就按仓库里 `docs/data-api.md` 开一个只读接口，把地址填进「设置」的「业务数据接口」，再让每位运营运行 `kol.mjs project set-key <项目名> <密钥>`。想让插件直接发体验码、帮 KOL 延期，后台再开建码接口，运营另外运行 `kol.mjs project set-trial-key <项目名> <写密钥>`。想让插件开合作活动码，后台再开活动码接口，运营运行 `kol.mjs project set-partner-key <项目名> <写密钥>`。不开也能用，只是这几步要手动做。
5. 让 Claude 跑 `kol.mjs check --project <新项目名>`，没有缺的表和字段、有启用的邮箱和已批准的模板，就可以用了。

### 加一个发信域名或发信邮箱

1. 飞书管理员在管理后台「邮箱 → 域名管理」加上新域名，按提示在域名的 DNS 里配好 MX、SPF（`v=spf1 +include:_netblocks.m.feishu.cn -all`）、DKIM，再加一条 DMARC（`_dmarc` 的 TXT，例如 `v=DMARC1; p=none; rua=mailto:<收报告的邮箱>`）。
2. 建一个公共邮箱（如 `hello@新域名`），把要用它的运营加为成员，让他们在 lark-cli 里能读写这个邮箱。
3. 在项目飞书表「发信邮箱」加一行：邮箱、渠道名、每日上限，勾「启用」。新域名先预热：「启用日期」填今天，「起步上限」20，「每天增加」10，大约两周到每日上限。
4. 让 Claude 跑 `kol.mjs setup-base --dry-run`：它会把新渠道名加进接触记录「渠道」、跟进「联系渠道」、审核队列「发送渠道」的选项，同意后去掉 `--dry-run`。
5. 再跑 `kol.mjs check`：「发信域名」里这个域名的「问题」应该是空的，「预热中」会显示今天的额度。

## 本地副本

为了不每次都把「KOL 档案」和「KOL 跟进」整张表读一遍，插件在 `~/.kol-ops/cache/` 里保存这两张表的副本，只有本机这个用户能读（里面有 KOL 的名字和邮箱）。每次运行只向飞书要「更新时间」在最近一两天的行；每 20 小时至少整表重读一次，飞书里删掉的行也在那时从副本里去掉。副本坏了或者想强制整表重读，删掉这个文件夹就行。

表里要有系统字段「更新时间」，没有的话 `setup-base` 会加上；没有这个字段时插件每次都整表读，只是慢一些。

## 能做的事

| 对 Claude 说 | 技能 |
|---|---|
| 打开决策台 | （见下面「决策台」） |
| 今天有什么事 / 处理来信 | kol-today |
| 批好了，发吧 | kol-send |
| 发一批邀约 | kol-invite |
| 找一批新 KOL | kol-find |
| 查某位 KOL / 改进度 / 永不联系 / 问数字 | kol-update |
| 每日例行（定时任务） | kol-daily |

共同规则见 `reference/rules.md`。

## 决策台

对 Claude 说「打开决策台」，或者在终端运行 `node "<插件目录>/scripts/kol.mjs" console`，会在这台电脑上打开一个页面（只有这台电脑能打开，按 Ctrl+C 关掉）：

- **待你决定**：Claude 准备好的回信、发码、邀约、模板，一件一件排好。点「同意」（可以先改草稿和码的参数）就排队执行；「要改」写一句意见交给 Claude 重写；「跳过」先放着。每个操作 5 秒内都能撤销。对不上人的来信可以关联到 KOL，过了约定日期没发布的可以直接记下帖子链接。
- **KOL**：按阶段分的列表，点名字看来往、改下一步、写信、结束跟进；右上角「找新人」。
- **执行记录**：系统做过的事。右上角的标签显示正在执行和没做成的事，「暂停所有发送」随时可以点。

## 执行电脑

发信、收信、建码、找人这些会碰外面的事，只在一台「执行电脑」上做，而且一次只做一件。在那台电脑上运行 `kol executor claim`，它的名字会写进项目「设置」表的「执行电脑」；别的电脑就只能看、写草稿、提交待决定。每天的定时任务也要设在这台电脑上。`kol executor` 看当前状态。

## 换成只用决策台批准

1. 在执行电脑上运行 `kol setup-base`（先 `--dry-run`），给项目飞书表补上「执行电脑」「只认决策台的同意」和审核队列的「同意来源」「同意人」「同意时间」「内容指纹」。
2. 运行 `kol executor claim`。
3. 跟运营同事说好哪天开始，那天在「设置」表勾上「只认决策台的同意」。之后在飞书审核队列里改「发／同意」不再执行，要在决策台里点。

## 改动

脚本源码在仓库的 `src/kolops/`。改完先运行 `npm run build:plugin`，重新打包 `scripts/kol.mjs`；再运行 `npm test`，测试里会直接运行打包后的脚本，确认它能正常启动。然后把 `plugin.json` 的版本号加一。同事装的是 `stable` 分支，要等 stable 推到这个版本（见仓库根目录 README 的「发布」）才会拿到。发信规则和邮件模板不在插件里，在每个项目飞书表的「设置」「发信邮箱」「模板」表里，改那里就行。
