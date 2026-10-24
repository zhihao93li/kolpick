# 业务数据接口约定（v1）

插件不认识任何项目的后台。项目想让插件知道体验码用了几次、活动码带来多少订单和分润，就按这份约定开一个只读接口；不开也不影响找人、邀约、收信、发信和催信。

## 接入

- 项目飞书表「设置」的「业务数据接口」填接口的根地址，例如 `https://api.example.com/api/kol-data`。
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
| `kind` | `trial`：送给 KOL 自己用的体验码。`partner`：KOL 分享给粉丝、带分润的活动码 |
| `maxUses` | 最多能用几次，`null` 表示不限 |
| `used` | 已经用掉的次数，包括已付款和占用中的订单，以项目自己的口径为准 |
| `paidOrders`、`refundedOrders`、`visitors` | 只有 `partner` 有：累计付款订单、退款订单、访客数（按访客去重） |

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

## 错误

| 状态码 | 什么时候 |
| --- | --- |
| 400 | 请求格式不对，或一次超过 200 个码；返回 `{ "error": "原因" }` |
| 401 | 没带密钥或密钥不对 |
| 429 | 请求太频繁，插件会隔一会儿重试 |
| 5xx | 项目后台出错，插件这次跳过，下次再同步 |
