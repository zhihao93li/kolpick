# KOL 运营插件（kol-ops）

给运营同事装在 Claude 桌面版里用。数据在飞书「tafu 台湾 KOL 总表」，发信用飞书邮箱，都经过本机的 lark-cli。

## 安装

### 准备

- 电脑上装好 Node.js 22 或更新的版本（终端里 `node --version` 能看到 v22 以上）。
- 电脑上装好 lark-cli，并用公司飞书账号登录过。
- 你的 GitHub 账号能访问私有仓库 zhihao93li/kolpick，没有权限就找 Emma 加。

### 管理员先开通权限（整个公司只做一次）

lark-cli 登录用的是公司的一个飞书应用，`lark-cli auth status` 里的 appId 就是它。这个应用现在只开通了云文档和多维表格权限，还没有邮箱和通讯录权限。在开通之前，同事怎么登录都拿不到这些权限。

请飞书管理员到飞书开放平台，打开这个应用的「权限管理」，开通下面这些用户权限，然后发布一个新版本：

- 通讯录：`contact:user.basic_profile:readonly`
- 邮箱：`mail:user_mailbox:readonly`、`mail:user_mailbox.message:readonly`、`mail:user_mailbox.message.address:read`、`mail:user_mailbox.message.subject:read`、`mail:user_mailbox.message.body:read`、`mail:user_mailbox.message:modify`、`mail:user_mailbox.message:send`

用插件发信的同事，还要在飞书邮箱里有 hello@tafu.me 和 mei@tafu.me 这两个公共邮箱的权限。

### 每位同事

1. 重新授权 lark-cli。在终端运行下面这条命令，它会给出一个链接，在浏览器里打开并同意：
   ```
   lark-cli auth login --scope "base:record:read base:record:create base:record:update base:field:read contact:user.basic_profile:readonly mail:user_mailbox:readonly mail:user_mailbox.message:readonly mail:user_mailbox.message.address:read mail:user_mailbox.message.subject:read mail:user_mailbox.message.body:read mail:user_mailbox.message:modify mail:user_mailbox.message:send"
   ```
   用同一串权限运行 `lark-cli auth check --scope "…"`，结果里 `missing` 是空的，就说明授权齐了。
2. 在 Claude 桌面版的 Code 里运行：
   ```
   /plugin marketplace add zhihao93li/kolpick
   /plugin install kol-ops@kolpick
   ```
   以前按 `zhihao93li/kolpick#claude/project-thread-eps57k` 装过的，先用 `/plugin marketplace remove kolpick` 删掉旧的，再运行上面两条。
3. 新开一个会话试一下：对 Claude 说「今天有什么事」。插件只在新会话里生效。如果它说飞书授权缺少权限，就照它给的提示补，或者让它跑一下 `kol.mjs check`，看缺了哪些。

## 能做的事

| 对 Claude 说 | 技能 |
|---|---|
| 今天有什么事 / 处理来信 | kol-today |
| 批好了，发吧 | kol-send |
| 发一批邀约 | kol-invite |
| 找一批新 KOL | kol-find |
| 查某位 KOL / 改进度 / 永不联系 / 问数字 | kol-update |
| 每日例行（定时任务） | kol-daily |

共同规则见 `reference/rules.md`。

## 改动

脚本源码在仓库的 `src/kolops/`。改完先运行 `npm run build:plugin`，重新打包 `scripts/kol.mjs`；再运行 `npm test`，测试里会直接运行打包后的脚本，确认它能正常启动。然后把 `plugin.json` 的版本号加一，同事那边更新插件就能拿到。邮件模板直接改 `templates/` 里的文本文件。
