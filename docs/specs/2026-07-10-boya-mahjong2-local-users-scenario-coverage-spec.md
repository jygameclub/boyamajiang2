# Boya 麻将2本地用户、场景覆盖与线路真机校验 Spec

**日期:** 2026-07-10

**工作目录:** `/Users/yang/work/git/sun/boyamajiang2`

**状态:** 设计已由用户确认，进入实现

**约束:** 不切分支；运行时所有客户端、素材、用户、余额、概率、历史和后台数据都在当前目录与当前本地服务内完成。

## 1. 目标

本阶段同时完成三项可独立验收的能力：

1. 把确定性测试从当前 22 个场景扩展为至少 38 个，重点覆盖不同轴数、Ways、1/2/3/4 次连续中奖掉落、金牌转 Wild、Wild 保留/参与/消除、多 Wild、多图标和 Scatter 重力。
2. live URL 支持本地 token 用户，例如 `user1`、`user2`、`usergame1`。用户不存在时由当前服务创建，存在时恢复余额和历史；不同 token 的余额、历史和 RTP 完全隔离。
3. 对 test/live 的盘面、`lines`、金额、客户端元素和高亮动画做协议与真机双重校验。禁止只看金额，发现线路或元素错位必须定位并修复。

## 2. 当前基线

现有确定性场景共 22 个：

| 套件 | 数量 | 已有内容 |
|---|---:|---|
| `base-small-ladder` | 6 | 1/2/3/5/6/8 元普通 Ways 小奖 |
| `route-and-cascade` | 12 | 近失、单/多 Ways、五轴、双图标、2/4 步中奖级联、金牌/Wild、补牌、级联上限 |
| `buyfree-ladder` | 4 | 3/4/5/6 胡对应 10/12/14/15 次免费 |

现有 `validateStep()` 已能证明协议数据中的盘面、`lines` 和奖金公式一致，但不能单独证明客户端在动画时显示的是同一盘面和同一路径。本阶段增加浏览器证据层。

## 3. 本地 token 用户合同

### 3.1 URL

标准入口：

```text
http://127.0.0.1:18082/__game/live?token=user1
http://127.0.0.1:18082/__game/live?token=user2
http://127.0.0.1:18082/__game/live?token=usergame1
```

HTTP 跳转后的 Cocos URL 继续携带 `token=<本地用户 token>`；base64 `g` 中的本地 WebSocket URL同时携带 `userToken=<本地用户 token>`。大厅连接和游戏连接都从本地 WebSocket 参数获取用户，不解析或信任 HAR 登录 token。

未传 token 时使用兼容用户 `local-default`。token 区分大小写，允许正则：

```text
^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
```

非法 token 返回 HTTP 400；不得静默映射到其他用户。

### 3.2 余额

- 新用户默认客户端显示余额为 `1,000,000.00`。
- SQLite 和 protobuf 使用最小货币单位，初始值保存为 `100000000`。
- `40001` 进入帧必须显示用户真实余额，不能先显示 HAR 固定余额再在首局跳变。
- 普通局余额变化：`balanceAfter = balanceBefore - betCoin + totalWin`。
- 购买余额变化：先扣 `buyCost`，再累加该次免费游戏总赢。
- 每局记录 `balanceBefore/balanceAfter`，用户表保存最新余额。
- test 模式只验证数据集，不扣任何 live 用户余额。

### 3.3 数据隔离

SQLite schema v3 新增：

```text
local_users(id, token UNIQUE, balance, created_at, updated_at)
game_sessions.user_id -> local_users.id
```

历史查询通过 `game_rounds -> game_sessions -> local_users` 关联。游戏内 `20047/20048` 列表和 `20051/20052` 详情只返回当前 token 的记录。后台可查看全部用户，也可按 token 筛选历史。

### 3.4 RTP

用户统计口径固定为：

```text
totalWager = sum(base.bet) + sum(buy.buyCost)
totalWin   = sum(base.totalWin) + sum(free-feature.totalWin)
rtp        = totalWager > 0 ? totalWin / totalWager : 0
```

免费旋转不重复计算下注；购买触发局的 `totalWin=0`，对应奖金只在 `free-feature` 记录一次。后台显示局数、余额、总下注、总中奖和 RTP 百分比。

## 4. 场景覆盖扩展

`route-and-cascade` 从 12 个扩展为至少 28 个，总场景达到至少 38 个。场景仍只定义初始盘面和各列补牌队列；`lines`、消除位置、Wild 和奖金必须由统一引擎计算，禁止手写中奖金额。

新增覆盖矩阵至少包含：

| 类别 | 必须覆盖 |
|---|---|
| 轴数与 Ways | 3/4/5 轴；顶部、底部、折线；1/2/6+ Ways；五轴多 Ways |
| 多线路 | 同一图标多 Ways；同一步 2/3 个图标；Wild 跨图标复用 |
| 掉落深度 | 中奖后 1 次消除终止；连续 2、3、4 次中奖消除；x1/x2/x3/x5 |
| 补牌 | 一列、多列、不同缺口数；补牌形成新路线；补牌形成多图标路线 |
| 金牌/Wild | 单金牌转 Wild；双金牌转双 Wild；Wild 保留一轮；Wild 下一轮参与；Wild 参与后消除；多 Wild 同线 |
| Scatter | Scatter 不替代普通图标、不消除；周围中奖消除后随重力移动 |
| 边界 | 两轴近失；级联上限合法终止；多个潜在图标但只有声明 Ways |

每个场景目录项增加预期元数据：中奖步数、终止步、必含倍率、最少 Wild 数、是否发生金转 Wild、是否包含 Scatter。单测从实际 `buildRoundPlan()` 结果验证元数据，避免标签与真实盘面脱节。

## 5. 线路与元素一致性

### 5.1 服务端门禁

每个发给客户端的 `40003/40005/40007` 必须满足：

1. 从 `drawResult` 重算的 `iconId/axleId/lineNum/odds/multi/score` 与 `lines` 完全相同。
2. `sum(lines.score) = roundWin`，最终累计值等于 `totalWin`。
3. 每条 line 的实际位置是从第 1 轴开始连续的基础符号、对应金牌或 Wild。
4. `goldToWildPos` 只包含本步中奖金牌，下一步同一幸存位置变为 Wild。
5. 消除与重力后，客户端收到的下一盘必须和引擎盘面逐格一致。
6. 协议编译后重新解码并再次校验，防止 HAR 外壳残留旧字段。

### 5.2 真机门禁

Playwright 对扩展后的场景逐个运行并保存：

```text
scenario-key/step-01-highlight.png
scenario-key/step-02-highlight.png
scenario-key/protocol.json
scenario-key/verdict.json
```

截图必须在高亮动画窗口，报告保存该步盘面、line、预期位置、Wild/金牌位置、金额和客户端显示金额。人工抽查所有特殊场景；普通同类场景使用协议一致性和像素非空/稳定性门禁。live 模式至少抽取普通输局、单线中奖、多 Ways、级联、购买 3+ 胡及免费旋转。

共同通过条件：

```text
HTTP >= 400 = 0
pageErrors = 0
clientClose = 0
authTimeout = false
mismatches = 0
decoded protocol formula = true
expected symbols exist on every winning reel = true
displayed amount = protocol roundWin = line score sum
```

## 6. 后台

后台新增“用户”视图，使用紧凑表格显示：token、余额、局数、总下注、总中奖、RTP、首次/最近活动时间。点击用户后切到历史并自动应用 token 筛选。

现有“运行历史”增加 token 输入/选择器和 token 列；详情仍显示完整盘面、`lines`、Wild 和级联步骤。桌面和手机均不得横向破坏主要操作。

## 7. API

新增或扩展：

```text
GET /api/admin/users
GET /api/admin/users/:token
GET /api/history/rounds?token=user1&mode=live&limit=100
GET /api/history/rounds/:id?token=user1
GET /__game/live?token=user1
```

用户列表返回聚合 RTP；历史详情在传 token 时校验所有权。后台本地运行不增加生产鉴权语义，但服务仍只默认绑定 loopback。

## 8. 验收交付

- test 地址：`http://127.0.0.1:18082/__game/test`
- live 用户地址：`http://127.0.0.1:18082/__game/live?token=user1`
- 后台：`http://127.0.0.1:18082/__admin`
- 用户历史：游戏内“菜单 -> 历史”和后台 token 过滤结果一致。
- 最终报告给出场景总数、逐场景 verdict、至少一组 Wild 连续演化截图、至少两个 token 的余额/历史隔离证据及用户 RTP。

