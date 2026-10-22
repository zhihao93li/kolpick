# KOL 运营插件（kol-ops）

给运营同事装在 Claude 桌面版里用。数据在飞书「tafu 台湾 KOL 总表」，发信用飞书邮箱，都经过本机的 lark-cli。

## 安装

1. 本机装好 lark-cli 并登录，权限要包含多维表格和邮箱：`lark-cli auth login --recommend`。登录后 `lark-cli mail +triage --mailbox hello@tafu.me --max 1` 能列出邮件就可以了。
2. 在 Claude 桌面版的 Code 里运行：
   ```
   /plugin marketplace add zhihao93li/kolpick
   /plugin install kol-ops@kolpick
   ```
   需要能访问 GitHub 仓库 zhihao93li/kolpick。
3. 试一下：对 Claude 说「今天有什么事」。

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

脚本源码在仓库的 `src/kolops/`，改完运行 `npm run build:plugin` 重新打包 `scripts/kol.mjs`，并把 `plugin.json` 的版本号加一，同事那边更新插件就能拿到。邮件模板直接改 `templates/` 里的文本文件。
