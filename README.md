# kolpick · KOL 平台

给多个项目共用的 KOL 平台：在后台按项目找 KOL、查联系邮箱、存进总库，运营在网页上审核名单。底层调用 Apify 上的现成 actor，支持 Instagram、YouTube、TikTok。

方案文档见 [KOL 邮箱批量查找：技术方案设计](https://claude.ai/code/artifact/c7eb3650-c9dc-484b-80b7-322d68f2bae0)。现在是第一阶段（库和找人）；agent 工具和发信在后两个阶段。

## 现在能做什么

- **项目**：每个项目有自己的地区、语言、找人默认条件、飞书通知群。新项目在后台新建，不用改代码。
- **找人任务**：选平台，填关键词、种子账号（Instagram）或已知账号，提交后在后台排队运行。花费到预算上限就停，已找到的照样保存。服务重启后任务会接着跑，已经跑完的 Apify 步骤不会重复付费。
- **查邮箱**：按实测定下的顺序，从便宜到贵，找到就停：

  | 平台 | 找人 | 查邮箱 |
  | --- | --- | --- |
  | Instagram | 相似账号（种子扩展）+ 短关键词搜索 | 商业号联系邮箱字段和简介 → 简介外链页面 |
  | YouTube | 频道关键词搜索 | 简介 → 外链页面 → 隐藏商务邮箱（可选，找到一个约 12 美分） |
  | TikTok | 用户关键词搜索（效果差，建议直接填已知账号） | 简介 → 外链页面 |

  每个邮箱都记来源、来源链接和发现时间，并做免费的基础检查（格式和对方域名能否收信）。
- **KOL 总库**：同一个账号只存一份，所有项目共用；项目只记自己的状态。同一个项目里已有的人，再跑任务时不会重复花钱去查。
- **名单审核**：按状态、平台、有无邮箱筛选，勾选后批量通过或排除，记录审核人。可以导出 CSV（Excel 直接打开）。
- **飞书通知**：任务完成或失败时发到项目的飞书群。

## 部署到 Zeabur

1. 在 Zeabur 里新建一个项目，添加 **PostgreSQL** 服务。
2. 再添加一个服务，选 GitHub 里的 `kolpick` 仓库。Zeabur 会用仓库里的 `Dockerfile` 构建。以后代码推到这个分支，Zeabur 会自动重新部署。
3. 在这个服务的「环境变量」里填：

   | 变量 | 填什么 |
   | --- | --- |
   | `DATABASE_URL` | `${POSTGRES_CONNECTION_STRING}`（原样填，Zeabur 会换成数据库地址） |
   | `ADMIN_PASSWORD_HASH` | 登录密码的哈希：本地运行 `npm run hash-password -- '你的密码'`，把输出整行填进来 |
   | `SESSION_SECRET` | 一串足够长的随机字符 |
   | `APIFY_TOKEN` | Apify Console > Settings > API & Integrations 里的令牌 |
   | `PUBLIC_URL` | 网站地址，例如 `https://kol.zeabur.app`，飞书通知里的链接会用到 |

4. 在服务的「网络」里绑一个域名，打开就能登录。数据库表会在启动时自动建好。

飞书群机器人：群设置 > 群机器人 > 添加自定义机器人，复制 Webhook 地址填到项目设置里。如果开了安全设置，选「自定义关键词」并填 `KOL`（每条通知都以它开头），不要选「签名校验」。

## 本地开发

需要 Node.js 22 和一个 PostgreSQL。

```bash
npm install
cp .env.example .env   # 填好里面的值；本地可以用 ADMIN_PASSWORD=明文密码 代替哈希
npm run dev            # http://localhost:8080
```

测试：

```bash
npm test                                                           # 不需要数据库的部分
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/kolpick_test npm test   # 全部（会清空这个库）
npm run typecheck
```

## 代码结构

| 位置 | 内容 |
| --- | --- |
| `src/discovery/` | 找人和查邮箱：actor 列表和价格（`apify.ts`）、各平台步骤（`pipeline.ts`）、整体流程（`run.ts`） |
| `src/jobs.ts` | 后台任务队列（pg-boss，用同一个 PostgreSQL） |
| `src/store.ts` | 把结果写进 KOL 总库和项目名单 |
| `src/web/` | 后台网页（服务端渲染，没有前端构建步骤） |
| `migrations/` | 数据库表结构，按文件名顺序自动执行 |
