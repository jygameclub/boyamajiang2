# Boya 麻将2本地用户、场景覆盖与线路真机校验 Spec

**日期:** 2026-07-10

**工作目录:** `/Users/yang/work/git/sun/boyamajiang2`

**状态:** 已实现并完成协议、真机和持久化验收

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

外部快捷地址的 `token` 是本地用户标识。HTTP 跳转后的 Cocos URL 必须继续使用 HAR 录制的认证 `token`，不能替换为 `user1` 等本地值；实测替换后客户端不会建立 WebSocket。base64 `g` 中的本地 WebSocket URL携带 `userToken=<本地用户 token>`，大厅和游戏连接都只从该参数绑定本地用户。

Cocos 建连时会在 `userToken` 后追加自身缓存后缀，例如 `user1?BA...`。网关只剥离这个客户端后缀，再按下述正则校验原始用户 token；不能把后缀一起写入数据库，也不能用 HAR 登录 token 作为本地用户主键。

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

每个场景目录项增加预期元数据：中奖步数、终止步、必含倍率、最少 Wild 数、是否发生金转 Wild、精确 Scatter 数量。单测从实际 `buildRoundPlan()` 结果验证元数据，避免标签与真实盘面脱节。普通旋转所有步骤强制 `Scatter <= 2`；只有购买免费套件允许 3/4/5/6 个 Scatter。

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
report.json
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

## 9. 2026-07-10 实施结果

### 9.1 场景覆盖

当前目录一共提供 38 个确定性场景：

```text
base-small-ladder = 6
route-and-cascade = 28
buyfree-ladder = 4
total = 38
```

`route-and-cascade` 的 28 个场景已由 `tests/playwright/boya-mahjong2-scenario-matrix.mjs` 逐个真机执行。最终报告：

```text
testwebgame/boya-mahjong2/local-controlled-final-20260710-scenario-matrix-final/report.json
```

报告结果为 `28/28 PASS`，共 41 个中奖动画步骤，`HTTP >= 400=0`、`pageErrors=0`、`clientClose=0`、`authTimeout=false`、`mismatches=0`。每一步都从解码后的 `drawResult` 重新计算 Ways，并严格比较 `lines`、路径位置、`roundWin` 和 `sum(lines.score)`。

两个 Wild 同一路线的最终定点证据：

```text
testwebgame/boya-mahjong2/local-controlled-final-20260710-multiple-wild-fixed/
```

该盘只有一条 `iconId=13` 四轴线路，第一轴 4 个目标符号，第二、三轴各一个 Wild，第四轴一个目标符号；`lineNum=4`、`score=400`，客户端高亮和横幅 `4.00` 一致。

### 9.2 多用户与历史

`user1`、`user2`、`usergame1` 已在真实客户端逐个连接并下注。最终报告：

```text
testwebgame/boya-mahjong2/local-controlled-final-20260710-local-users/report.json
```

关键结果：

```text
verdict = PASS
user2 first 40001 = 100000000
usergame1 first 40001 = 100000000
each user WebSocket contains its own userToken
each user balance = enter balance - bet + total win
history rows contain only the requested token
cross-user detail request = HTTP 404
admin RTP = recomputed SQLite RTP
game history 20048/20052 = current user records
HTTP >= 400 / pageErrors / clientClose / authTimeout / mismatches = 0
```

后台桌面和手机截图分别为 `admin-users.png`、`admin-users-mobile.png`；`admin-usergame1-history.png` 证明后台 token 筛选只显示 `usergame1`。

### 9.3 控件、购买和免费旋转

`tests/playwright/boya-mahjong2-live-controls.mjs --token usergame1` 已验证：自动旋转 3 次、下注切换为 `20.00`、购买费用 `1600.00`、本地概率抽到 6 个胡并给 15 次免费、游戏内历史列表与详情均可打开。报告：

```text
testwebgame/boya-mahjong2/local-controlled-final-20260710-live-controls-usergame1/report.json
```

完整回归 `local-controlled-final-20260710-regression` 还验证了 3/4/5/6 胡分别对应 10/12/14/15 次免费、测试免费局从小到大、x2/x4/x6/x10、金牌转 Wild、live 免费盘面读取当前概率配置，最终 `verdict=PASS`。

## 10. 真机排障经验

1. **三者自洽还不够，状态必须合法。** 盘面、`lines` 和金额即使数学一致，普通 `40003` 若含 3 个胡仍会让客户端进入逐轴胡牌动画并等待免费状态。错误场景连续 14 秒不再发送终止子轮，说明它不是可接受的普通局。普通模式必须限制最多 2 胡，3+ 胡只能走 `40006/40007`。
2. **Wild 会复用任意可支付符号。** 两个连续 Wild 放在第二、三轴时，第一轴的每个普通填充符号都可能额外生成一条 Ways。设计“单一 Wild 路线”时，必须从引擎结果反查所有 `lines`，不能只检查目标图标存在。最终把第一轴其余格也设为目标符号，消除了意外 `iconId=3` 线路。
3. **高亮时间不能用一个固定延迟。** 首次停轴、后续级联和 2 个胡的期待动画时长不同。最终脚本对首次中奖取约 `1.8/2.3/2.8s` 三帧，对后续级联取 `0.7/1.2/1.7s` 三帧；2 个胡场景取 `9.8/10.6/11.2s` 三帧。中间帧作为正式 `highlight.png`，前后帧用于确认没有截到停轴前或爆破后。
4. **本地用户不能直接替换 Cocos 兼容 token。** 短 token 放进 Cocos 顶层 `token` 会导致 WebSocket 不建立。现在 `/__game/live?token=user1` 返回同源全屏入口壳，地址栏始终保留 `user1`；壳内 Cocos 仍使用 HAR 格式兼容值，但没有远端验证，实际用户身份只由本地 WS `userToken` 和 SQLite 决定。测试入口同样保持 `/__game/test`。
5. **历史必须同时验两条入口。** REST `/api/history/rounds?token=...` 用于后台和所有权检查；客户端原生历史必须真实完成 `20047/20048` 和 `20051/20052`。只验证其中一个不能证明用户看到的是自己的记录。
6. **`topResult` 属于触发掉落的当前帧。** 真实 HAR 表明，当前中奖帧的 `topResult[reel]` 是本次消除后进入下一盘的边界牌。旧实现把补牌写到下一帧，造成客户端先生成一块盘面，再用下一帧 `lines` 高亮另一种符号。修复后由当前步骤回写 `incomingByReel.at(-1)`，并新增固定级联单测。
7. **长转必须检查终局后的静默状态。** 只收到最后一个 `40003` 不代表 UI 已恢复。矩阵对每个场景等待终局后检查未点击时新增 `40002=0`；live 连续 10 把每把都要求零中奖终局帧、下一把可点击、`idleRequests=0`。
8. **完全本地要同时做静态和运行时审计。** `gateConfig` 原本仍有线上 `wss://gateway...` 兜底，现已改成 `window.location.host`。Playwright 对测试、live、后台、历史页记录全部 HTTP/WS URL，任何非 `127.0.0.1:18082` 主机、请求失败或 HTTP 4xx/5xx 都判失败。

## 11. 2026-07-10 最终缺陷修复与验收

### 11.1 修复内容

- 修复级联补牌帧归属，解决“盘面是发/中/八万，`lines` 却高亮紫框牌”的错位。
- 测试与 live 使用同源全屏入口壳，地址栏不再变成长 HAR token。
- HAR 客户端默认网关改为本机，移除运行时线上网关兜底。
- 场景矩阵增加多时点高亮截图和终局静默门禁。
- live 综合回归扩展为连续 10 把并逐把检查 `idleRequests=0`。

### 11.2 浏览器证据

```text
28 场景矩阵：testwebgame/boya-mahjong2/scenario-matrix-visual-final-20260710/
Scatter 定点：testwebgame/boya-mahjong2/scatter-gravity-visual-final2-20260710/
综合回归：testwebgame/boya-mahjong2/controlled-stability-local-final-20260710/
三用户短 token：testwebgame/boya-mahjong2/local-users-token-shell-20260710/
按钮回归：testwebgame/boya-mahjong2/live-controls-bugfix-final-20260710/
本地网络审计：testwebgame/boya-mahjong2/local-runtime-audit-final-20260710/
```

最终结果：

```text
route-and-cascade = 28/28 PASS
test idleRequests = 0
live stability spins = 10/10 PASS
live idleRequests = 0 for every spin
HTTP >= 400 = 0
pageErrors = 0
clientClose = 0
authTimeout = false
serverMismatches = 0
runtime external URLs = 0
runtime hosts = 127.0.0.1:18082 only
```

### 11.3 当前本地边界

- 客户端脚本、图片、音频和懒加载包均由 `local-har-client/boya-mahjong2` 提供。
- 大厅、游戏协议、概率配置、购买免费、用户余额、历史和 RTP 均由当前目录 Node 服务与 SQLite 控制。
- HAR 长 token 只作为未改动 Cocos 启动格式的内层兼容值，不连接远端、不决定本地用户，也不会出现在两个主要入口的地址栏。
