# 业务数据接口约定（v1）

插件不认识任何项目的后台。项目想让插件知道体验码用了几次、活动码带来多少订单和分润，就按这份约定开一个只读接口；不开也不影响找人、邀约、收信、发信和催信。

## 接入

- 项目「设置」表的「业务数据接口」填接口的根地址，例如 `https://api.example.com/api/kol-data`。
- 密钥只存在运营的电脑上：`kol project set-key <项目名> <密钥>`。插件每次请求都带 `Authorization: Bearer <密钥>`。
- 接口只读、只走 HTTPS，返回 JSON，响应头带 `Cache-Control: no-store`。密钥不对一律返回 401，不说明原因。
- 金额一律用主币单位的十进制数（NT$ 1,234.5 写成 `1234.5`），同时给 `currency`（ISO 4217，如 `TWD`）。
- 时间一律用带时区的 ISO 8601。

## POST /codes

查一批码的现状。插件每天同步一次，一次最多 200 个码。码不区分大小写。

请求：

```json
{ "codes": ["DEER3", "AMY-TAFU"] }
```

响应：

```json
{
  "codes": [
    {
      "code": "DEER3",
      "found": true,
      "kind": "trial",
      "active": true,
      "maxUses": 3,
      "used": 1,
      "startsAt": null,
      "expiresAt": "2026-11-15T23:59:59+08:00"
    },
    {
      "code": "AMY-TAFU",
      "found": true,
      "kind": "partner",
      "active": true,
      "maxUses": null,
      "used": 42,
      "expiresAt": null,
      "paidOrders": 40,
      "refundedOrders": 2,
      "visitors": 1830
    },
    { "code": "NOPE", "found": false }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `kind` | `trial`：送给 KOL 自己用的体验码。`partner`：KOL 分享给粉丝、带分润的活动码。`other`：其他码，插件不用。体验码和活动码可以同名，同名时各返回一条，插件按 `kind` 分别对应「体验码」「活动码」字段 |
| `maxUses` | 最多能用几次，`null` 表示不限 |
| `used` | 已经用掉的次数，包括已付款和占用中的订单，以项目自己的口径为准 |
| `paidOrders`、`refundedOrders`、`visitors` | 只有 `partner` 有：累计付款订单、退款订单、访客数（按访客去重） |

## POST /trial-codes、POST /trial-codes/{码}/extend

建体验码和延期，给「发体验码」「延期」这两种审核项用。可选：不开的话，这两步在项目后台手动做。

- 用另一把**写密钥**：插件里 `kol project set-trial-key <项目名> <写密钥>`，请求头同样是 `Authorization: Bearer <写密钥>`。只读密钥必须建不了码。
- 建码请求：

```json
{ "code": "deer_jay", "maxUses": 3, "days": 14, "kolName": "小鹿與阿哲", "followupId": "recXXXX", "operator": "钟嫣婷" }
```

  建出的码是 KOL 自己用的体验码（`kind: trial`），到期 = 现在 + `days`。同一个 `followupId` 用同一个码名再请求，要原样返回第一次建的码，不能建第二个（插件重试时依赖这一点）；码名被别的码占用返回 409。
- 延期请求：`{ "days": 7, "operator": "钟嫣婷" }`，从「现在」和「原到期」中较晚的一个往后加。延期不要求幂等，插件自己保证同一条审核只延一次。
- 两个接口都回 `{"code": {…}}`，形状和 `POST /codes` 里一条体验码相同（建码另有 `"created": true/false`）。
- 项目自己定上限并拒绝超出的请求，插件按 TAFU 的上限先检查：次数 1–10，天数 1–60。
- 错误时回 `{ "error": "代码", "message": "给人看的原因" }`，插件把 `message` 原样写进审核队列的执行结果。常见：`CODE_TAKEN`（409）、`DAILY_LIMIT`（429）、`NOT_A_TRIAL_CODE`（404）、`CODE_INACTIVE` / `NO_EXPIRY`（409）。

## POST /partner-codes

开合作活动码（KOL 的专属连结和粉丝优惠），给审核队列里批准过的「开活动码」用。可选：不开的话在项目后台手动建。

- 用第三把**写密钥**：插件里 `kol project set-partner-key <项目名> <写密钥>`。只读密钥和体验码写密钥都必须开不了活动码。
- 请求：

```json
{ "code": "deer_jay", "partnerName": "小鹿與阿哲", "contact": "deer@example.com", "market": "TW", "percentOff": 15,
  "followupId": "recXXXX", "operator": "钟嫣婷" }
```

  - `partnerName` 是合作页顶部显示的名称，`contact` 写进合作方的联系方式：只放这位 KOL 的联系邮箱，必须是批准内容里写明的那个，不放别的联系方式或资料（产品规则见 [design.md](design.md) 第八节）。
  - `market` 只能是项目支持的一个市场（TAFU：`CN` / `TW` / `GLOBAL`）。
  - `percentOff` 是粉丝折扣，TAFU 允许 10–20，插件默认 15。分润固定用项目的标准阶梯（TAFU：`tiered_paid_v1`，30% / 35% / 40%），这个接口不能改。
  - 从现在起生效，不设结束日期，不限次数。
- 同一个 `followupId` 用同一个码名再请求，原样返回第一次开的活动（`"created": false`），不能开第二个；码名被别的活动占用返回 409 `CODE_TAKEN`。
- 回 `{ "created": true, "code": {…} }`。`code` 和 `POST /codes` 里一条活动码的形状相同，另加：
  - `refLink`：KOL 分享用的专属连结（完整网址）；
  - `ledgerLink`：KOL 看自己业绩的只读账本（完整网址）。

  插件把这两个和码名填进信里的 `{活動碼}`、`{專屬連結}`、`{帳本連結}`，不自己拼网址。
- 错误同上：`{ "error": "代码", "message": "给人看的原因" }`。常见：`CODE_TAKEN`（409）、`INVALID_MARKET` / `INVALID_DISCOUNT`（400）、`DAILY_LIMIT`（429）。

## GET /settlements?month=YYYY-MM

某个月每个活动码的结算数字，用来填「月度结算」。插件暂时还没有用到这个接口，项目可以先不实现。

```json
{
  "month": "2026-10",
  "rows": [
    {
      "code": "AMY-TAFU",
      "orders": 12,
      "refunds": 1,
      "visitors": 340,
      "revenue": { "amount": 14880, "currency": "TWD" },
      "commission": { "amount": 5208, "currency": "TWD" },
      "rate": "35%",
      "cumulativeOrders": 40,
      "status": "estimated"
    }
  ]
}
```

`status` 是 `estimated`（这个月还没封账）或 `sealed`（已封账，数字不会再变）。

## 已实现的项目

- TAFU：`POST /codes` 已实现（tafu-nodejs `apps/api/src/routes/kol-data.ts`，密钥是环境变量 `KOL_DATA_API_KEY`）；建码和延期在 `apps/api/src/lib/kol/trial-codes.ts`，写密钥是 `KOL_TRIAL_CODE_KEY`，每个码最多 10 次、最长 60 天，24 小时内最多改 30 个码；`POST /partner-codes` 正在做（写密钥 `KOL_PARTNER_CODE_KEY`）；`GET /settlements` 还没做。

## 错误

| 状态码 | 什么时候 |
| --- | --- |
| 400 | 请求格式不对，或一次超过 200 个码；返回 `{ "error": "原因" }` |
| 401 | 没带密钥或密钥不对 |
| 429 | 请求太频繁，插件这次跳过，下次再同步 |
| 5xx | 项目后台出错，插件这次跳过，下次再同步 |
