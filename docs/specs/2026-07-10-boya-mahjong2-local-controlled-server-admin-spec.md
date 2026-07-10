# Boya 麻将2本地可控服务端、测试模式与管理后台 Spec

**日期:** 2026-07-10

**工作目录:** `/Users/yang/work/git/sun/boyamajiang2`

**当前基线:** `1a24c10`

**状态:** V1 核心交付已实现并通过真机验收；免费旋转内 Scatter retrigger 保留为证据受限项

**参考实现:** `/Users/yang/work/git/slot-platform` 仅用于规则和数据集设计参考；运行时不得依赖该目录

## 1. 结论

本阶段在当前仓库内新增一套独立的本地游戏服务，不再只做 HAR 顺序回放：

- 当前 HAR 还原的 Boya Cocos 客户端保持不变，素材继续全部从本地目录加载。
- 新增本地规则引擎，按盘面计算 Ways、中奖线、奖金、级联、金牌转 Wild 和免费次数。
- 新增 SQLite 持久化，保存概率配置、配置版本、测试控制状态、每局历史、每步级联和协议事件。
- 新增独立管理后台，可配置每一列每个符号的权重、结果档位权重、金牌概率和级联限制。
- 对外只给两个主要客户端测试地址：
  - `http://127.0.0.1:18082/__game/test`：确定性测试数据，小奖到大奖、不同 Ways、级联、Wild、购买免费依次验证。
  - `http://127.0.0.1:18082/__game/live`：直接连接本地概率服务，按后台当前激活配置实时生成结果。
- 管理后台：`http://127.0.0.1:18082/__admin`。
- 持久化历史：`http://127.0.0.1:18082/__history`，JSON API 为 `/api/history/rounds`。

核心铁律：**先生成盘面，再由规则引擎计算 lines 和奖金；禁止“输盘面 + 假金额”，禁止在计算完成后硬改中奖金额。**

## 2. 已有成果与经验约束

已有 HAR 还原、素材补齐、协议解析、普通小奖和免费级联经验保留在：

`docs/specs/2026-07-09-boya-mahjong2-har-local-replay-spec.md` 的 §9、§10、§11、§12、§13。

后续实现必须继承以下已验证经验：

1. 基础旋转中奖及其消除子轮都走 `40002 -> 40003`，不能误走免费命令。
2. 购买免费走 `40006 -> 40007`，免费旋转及其级联走 `40004 -> 40005`。
3. 基础中奖后必须返回重力兼容的终止 `40003`，不能重复发送同一个中奖盘面。
4. `roundScore` 是有符号净分通过 uint64 varint 编码；基础局为 `本局总赢 - betCoin`。
5. 客户端会按协议状态和盘面检查级联；不一致会主动关闭连接，随后表现为“登录认证超时”。
6. 中奖动画会懒加载素材；真机 HTTP 404 必须为 0，不能只看单测。
7. 免费状态字段不能混入基础 `40003`；协议帧优先克隆真实 HAR 外壳并保留未知字段。
8. 每一个发给客户端的结果必须先通过服务端一致性校验器。

## 3. 本次重新核实的 Boya 真值

### 3.1 盘面与符号

Boya `drawResult` 为按列排列的 25 个位置，每列 5 个。录制中索引 `0` 和 `20` 在所有 28 个已检查结果里恒为 `101`，它们是盘面空位，不是 Scatter。实际参与 Ways 的位置为其余 23 个。

| Boya ID | 含义 | 规则 |
|---:|---|---|
| `1` | Scatter / 胡 | 不参与 Ways，不被消除，3 个以上触发免费次数 |
| `2` | Wild | 替代除 Scatter 外的普通符号；不能直接随机生成 |
| `3,5,7,9,11,13,15,17,19` | 普通赔付符号 | 奇数为基础符号 |
| `4,6,8,10,12,14,16,18,20` | 金色版本 | `goldId - 1` 为对应基础符号；中奖后转为 Wild |
| `101` | 固定空位 | 仅允许出现在 `drawResult[0]`、`drawResult[20]` |

`topResult[5]` 和 `buttomResult[5]` 继续作为客户端掉落动画缓冲数据保存和生成，但不直接加入当前 23 格 Ways 计算。

导入 `slot-platform` 场景时使用以下映射：

```text
slot Wild 0       -> Boya 2
slot Scatter 1    -> Boya 1
slot payout 2..10 -> Boya (2 * slotId - 1)，即 3,5,7,...,19
```

现有 `tools/lib/boya-har.mjs` 的探索期 `SLOT_TO_BOYA_SYMBOL` 把赔付符号顺序反转并把 Scatter 映射为 `101`，不能被新引擎复用。参考 35 格盘面也不能再通过简单截取行直接转换；新场景先落到 Boya 的 25 格模型，强制空位后再生成上下缓冲。

### 3.2 赔率与奖金公式

真实 HAR 的 20 条中奖 line 全部满足下式：

```text
matchLength = lines.axleId + 1
ways        = lines.lineNum
unitBet     = betMulti
lineScore   = lines.odds * ways * lines.multi * unitBet
roundWin    = sum(lines[].score)
```

例如真实帧：`iconId=17, axleId=4, lineNum=2, odds=6, multi=2, betMulti=20`，因此 `score=6*2*2*20=480`。

默认赔率表按 Boya ID 固定，不允许在概率后台修改：

| iconId | 3 轴 | 4 轴 | 5 轴 |
|---:|---:|---:|---:|
| `3` | 10 | 25 | 50 |
| `5` | 8 | 20 | 40 |
| `7` | 6 | 15 | 30 |
| `9` | 5 | 10 | 15 |
| `11` | 3 | 5 | 12 |
| `13` | 3 | 5 | 12 |
| `15` | 2 | 4 | 10 |
| `17` | 1 | 3 | 6 |
| `19` | 1 | 3 | 6 |

因此原有 `normalwin` 中“固定一条 Ways 后直接指定 1.00/2.00…”只能作为协议与动画探索成果，不能作为新规则引擎的奖金算法。新测试场景必须通过 Ways 数量自然得到目标金额。

### 3.3 Wild 分配采用 Boya 实测行为

`slot-platform/guize.md` 写的是“同一个 Wild 只能分配给一个符号”，但其当前 `WaysCalculator.java` 明确允许 Wild 跨符号复用，Boya HAR 也证明了复用行为：同一真实盘面的 Wild 位置同时参与 `iconId=13/19/15/11` 四条中奖 line，且各 line 的 `lineNum` 都等于包含 Wild 后的 Ways 乘积。

本地 Boya 引擎按当前客户端和 HAR 真值实现：

- 同一个 Wild 可以参与不同 `iconId` 的中奖组合。
- 同一条 line 内，每个盘面位置只计算一次。
- Wild 不能替代 Scatter。
- line 高亮由 `iconId + drawResult` 推导，因此盘面上的基础符号、对应金色符号和 Wild 必须真实连续成路。

### 3.4 购买免费与胡数量

真实 `40007` 购买帧中有 3 个 `1`、`freeAppend=10`、`freeRemainCount=10`。本地服务扩展为用户指定映射：

| 胡数量 | 免费次数 |
|---:|---:|
| 3 | 10 |
| 4 | 12 |
| 5 | 14 |
| 6 | 15 |
| 7+ | `14 + scatterCount - 5` |

当前 Boya 客户端在基础下注 `400` 时显示购买价 `32000`，即当前客户端默认购买倍数为 `80x`。本地服务默认遵循 Boya UI/HAR 的 `80x`，不采用 `slot-platform` 文档里的 `60x`。购买费用作为只读规则显示在后台，不提供任意改价入口。

## 4. 范围

### 4.1 必须实现

- 独立 Node.js 本地服务，静态客户端、WebSocket、REST API、后台和历史同端口运行。
- 使用 Node 26 自带 `node:sqlite`，不引入外部数据库服务。
- 确定性测试模式与概率实时模式使用同一套规则计算器和 Boya 帧编译器。
- 每列、每符号、每模式、初始盘面/级联掉落分别配置权重。
- 结果档位权重与列权重同时生效，但结果档位只决定“生成目标”，不能修改最终奖金。
- 普通 Ways、多符号同时中奖、2/3/4+ 步级联、金牌转 Wild、Wild 下一步被消除。
- 购买免费支持 3、4、5、6+ 胡，并按上表给次数。
- 免费旋转奖励按小到大覆盖 miss、small、medium、big、mega，并覆盖 x2/x4/x6/x10 级联倍数。
- 所有局和级联步骤持久化，服务重启后历史仍可查询。
- 保持现有 replay/dataset/normalwin/winladder 入口兼容，不破坏已验证回放能力。

### 4.2 本阶段非目标

- 不接生产登录、生产钱包、生产网关或真实玩家账户。
- 不宣称达到某个生产 RTP；后台概率仅用于本地测试和可复现验证。
- 不修改 `/Users/yang/work/git/slot-platform`。
- 不允许后台修改固定赔率表、免费次数公式或协议命令号。
- 由于 HAR 没有“基础自然转出 3+ 胡后进入免费”的完整录制链，V1 的免费入口以购买免费为准；实时基础盘面最多生成 2 个胡。自然免费触发需未来取得真实 Boya 链路后再开放，不能凭猜测拼帧。

## 5. 总体架构

```text
Cocos Client
  | HTTP / WebSocket
  v
Local Server (127.0.0.1:18082)
  |- Static Asset Server
  |- WebSocket Session State Machine
  |- Boya Frame Decoder / Compiler
  |- Deterministic Test Scenario Runner
  |- Probability-Controlled Game Engine
  |- Consistency Validator
  |- Admin REST API + Admin UI
  `- SQLite Config / History Store
```

规则引擎产出与协议编码严格分层：

1. Engine 只处理规范化盘面、Ways、级联和金额，不知道 protobuf wire 字节。
2. Validator 对完整 round/step 做规则一致性校验。
3. Protocol Compiler 以真实 HAR 帧为外壳，替换已确认字段并保留未知字段。
4. Session State Machine 根据客户端命令逐步发送编译后的帧。
5. History Store 在发送成功后按事务保存领域结果和协议摘要。

## 6. 建议文件边界

```text
tools/local/boya-local-server.mjs              # 启动参数、组装依赖
tools/local/server/http-app.mjs                 # 静态资源、REST、页面路由
tools/local/server/ws-session.mjs               # 40000-40007/5000 状态机
tools/local/server/database.mjs                 # node:sqlite、事务、迁移
tools/local/server/config-store.mjs             # 草稿/激活版本、测试状态
tools/local/server/history-store.mjs            # session/round/step/event 持久化
tools/local/engine/constants.mjs                 # 固定符号、赔率、倍数、免费次数
tools/local/engine/rng.mjs                       # 固定算法的 seeded RNG
tools/local/engine/board-generator.mjs           # 每列权重采样、空位、金牌覆盖
tools/local/engine/ways-calculator.mjs           # Ways/lines/奖金
tools/local/engine/cascade-engine.mjs            # 消除、重力、补牌、金转 Wild
tools/local/engine/outcome-selector.mjs          # 结果档位条件采样与模板兜底
tools/local/engine/validator.mjs                 # 发送前一致性门禁
tools/local/protocol/boya-frame-compiler.mjs     # HAR 外壳 -> Boya 响应帧
tools/local/scenarios/scenario-runner.mjs        # test 模式游标和套件
local-admin/boya-mahjong2/index.html             # 后台页面
local-admin/boya-mahjong2/admin.css
local-admin/boya-mahjong2/admin.mjs
local-data/.gitkeep                              # SQLite 目录；db/wal/shm 忽略
debugserver-data/boya-mahjong2/scenarios/*.json  # 可审查的确定性场景
tests/unit/boya-engine-*.test.mjs
tests/integration/boya-local-server.test.mjs
tests/playwright/boya-mahjong2-test-mode.mjs
tests/playwright/boya-mahjong2-live-mode.mjs
tests/playwright/boya-mahjong2-admin.mjs
```

现有 `tools/lib/boya-har.mjs` 保留 HAR 导入和旧回放职责。新规则代码不得继续堆进该大文件；只把稳定、协议无关的解码工具提取后复用。

## 7. 两种客户端模式

### 7.1 确定性测试模式

入口：`/__game/test`，WebSocket 参数 `mode=test`。

- 不读取实时概率权重决定结果。
- 从 SQLite 保存的当前测试套件、场景和游标读取下一条场景。
- 相同 `scenarioKey + seed + betMulti` 必须生成完全相同的帧序列。
- 后台可选择套件、固定场景、顺序循环、重置游标和查看下一条场景。
- 默认套件按“小奖 -> 大奖 -> Wild/级联 -> 购买免费”排列。
- 测试 URL 始终只有一个，场景控制放在后台和 API，不给用户堆大量地址。

### 7.2 概率实时模式

入口：`/__game/live`，WebSocket 参数 `mode=live`。

- 新 session 打开时绑定当前激活的 `configVersionId`。
- 每一局开始时再次记录配置快照 ID；一局级联过程中后台切配置不得改变该局。
- 先按 outcome weight 选择目标档位，再按每列 symbol weight 生成盘面并由规则引擎计算。
- 最多进行 128 次条件采样；达到目标档位即采用。
- 128 次仍无法满足时，从同档位的已验证场景模板中按 seed 选择兜底结果。
- 兜底必须再次经过同一 Validator，并在历史中记录 `generationSource=template-fallback` 和原因。
- 不允许通过缩放 `lines.score` 伪造目标档位。

## 8. 概率配置模型

### 8.1 每列符号权重

权重维度：

```text
mode  = base | free | buy
phase = initial | cascade
reel  = 0..4
symbolId = 1 | 3 | 5 | 7 | 9 | 11 | 13 | 15 | 17 | 19
weight = 0..100000 的整数
```

约束：

- 同一 `mode + phase + reel` 至少一个普通赔付符号权重大于 0。
- `2`、偶数金牌 ID 和 `101` 不出现在符号权重表。
- Wild `2` 只能由金牌中奖转换产生。
- 金牌通过单独的 `goldRateByReel` 覆盖普通符号，列 0/4 固定为 0。
- free/buy 模式的中间列 2 对所有非 Scatter 普通符号强制使用金色版本。
- base initial/cascade 在 V1 每个完整盘面最多允许 2 个 Scatter。
- 后台显示原始 weight 和归一化百分比；保存整数权重，避免浮点累计误差。

### 8.2 结果档位权重

结果档位按本局总赢相对 `betCoin` 的倍数分类：

| outcomeKey | 区间 |
|---|---|
| `miss` | `totalWin = 0` |
| `small` | `0 < totalWin < 5 * betCoin` |
| `medium` | `5 * betCoin <= totalWin < 10 * betCoin` |
| `big` | `10 * betCoin <= totalWin < 20 * betCoin` |
| `mega` | `20 * betCoin <= totalWin < 30 * betCoin` |
| `super` | `totalWin >= 30 * betCoin` |

后台分别为 base 和 free 配置各档位整数权重。购买免费不混入 base outcome；购买按钮请求到达后独立选择 `scatter3/scatter4/scatter5/scatter6plus` 权重。

默认购买胡数量权重为：

```json
{
  "scatter3": 70,
  "scatter4": 20,
  "scatter5": 8,
  "scatter6plus": 2
}
```

### 8.3 配置版本

- 后台编辑只写 draft，不直接影响运行 session。
- 激活操作在一个 SQLite 事务内把旧 active 改为 archived、draft 改为 active。
- 激活前运行结构校验和 1000 局快速模拟；出现非法权重、无法生成的 outcome 或 Validator 错误时拒绝激活。
- 每次保存和激活写入 `admin_audit`，记录前后版本、时间和变更摘要。

## 9. 规则引擎

### 9.1 Ways 计算

对每个奇数赔付 `iconId`：

1. 从第 1 列开始逐列统计 `iconId`、`iconId+1` 金牌和 Wild `2`。
2. 连续不足 3 列则不中奖；遇到第一列 0 匹配立即停止。
3. `lineNum` 等于各连续列匹配数量乘积。
4. `axleId = 连续列数 - 1`。
5. `odds` 从固定赔率表按 3/4/5 轴读取。
6. `multi` 使用当前级联倍数。
7. `score = odds * lineNum * multi * betMulti`。
8. 同一步所有 line 的 score 相加得到 `roundWin`。

- 普通模式级联倍数：`1, 2, 3, 5, 5...`。
- 免费模式级联倍数：`2, 4, 6, 10, 10...`。

### 9.2 消除与重力

- 普通中奖符号和参与该中奖的 Wild 进入消除集合。
- Scatter 永不进入消除集合，但下方消除后会随重力移动。
- 参与中奖的金牌不消除，在原逻辑位置转为 Wild；同一步不重复参与二次计算。
- 未中奖金牌继续保留金牌身份并随重力移动。
- 每列保留符号的相对顺序必须不变，缺口从该列顶部按 cascade 权重补牌。
- 新补牌不能直接是 Wild；free/buy 中间列的新普通牌转为金牌版本。
- 一步结算完成后重新计算 Ways；有赢继续级联，无赢生成终止帧。
- 默认级联上限 base=4、free=5、buy=6；后台允许在 1..10 内调整。达到上限后必须生成经过校验的无赢终止盘，历史标记 `cascadeLimitHit=true`。

### 9.3 购买免费

1. 收到 `40006` 后读取本局基础下注，购买价默认为 `betCoin * 80`。
2. 按 test 场景或 live 的购买胡数量权重选择精确 scatterCount。
3. 在 23 个有效位置中放置精确数量的 `1`；`drawResult[0]`、`drawResult[20]` 仍为 `101`。
4. 先完成购买触发盘结算，再返回 `40007` 免费状态。
5. `freeAppend/freeRemainCount/freeMaxCount` 必须与 scatterCount 映射一致。
6. 每次新免费旋转消耗一次 remain；同一旋转内部级联不再次扣次数。
7. 免费旋转内再次出现 3+ Scatter 时按相同公式追加次数，并持久化 retrigger 事件。

## 10. Boya 协议状态机

| 当前状态 | 客户端命令 | 服务响应 | 行为 |
|---|---:|---:|---|
| enter | `40000` | `40001` | 克隆真实 enter 外壳，写本地余额和 session 状态 |
| base-idle | `40002` | `40003` | 新基础局，扣一次 bet |
| base-cascade | `40002` | `40003` | 返回下一消除/终止步，不再扣 bet |
| buy-idle | `40006` | `40007` | 扣购买费，返回精确胡数量和免费次数 |
| free-idle | `40004` | `40005` | 新免费旋转，remain 减 1 |
| free-cascade | `40004` | `40005` | 返回当前免费旋转下一消除/终止步 |
| any | `5000` | `5001` | 独立心跳，不移动游戏游标 |

实现要求：

- 复用真实 `40001/40003/40005/40007` 外壳，保留未知字段和字段顺序。
- 只重建已确认的 MsgRotate 字段；命令号、frame length、high bit/gzip 规则继续由现有 codec 处理。
- 基础每一步写 `gameNumList=[1,2,3,5]`，免费每一步写 `gameNumList=[2,4,6,10]`；`gameNum` 必须等于该步实际倍数，使客户端倍数动画与 `lines.multi` 一致。
- 每个客户端请求最多消费当前状态队列的一个 step。
- 命令与状态不匹配时不猜测：记录 mismatch，发送可识别错误并关闭该 session；Playwright 验收要求 mismatch 为 0。
- 服务器发送前做 Validator，失败结果不得进入网络层，改用同档位已验证模板；模板也失败则该局返回安全 miss 并记录 fatal validation event。

## 11. 确定性测试数据集

### 11.1 普通小奖阶梯

默认 `base-small-ladder` 必须自然算出用户指定金额，不能缩放 score：

| 顺序 | 金额 | 设计条件 | 公式（betMulti=20） |
|---:|---:|---|---|
| 1 | 1.00 | `icon19`，3 轴，5 Ways，x1 | `1*5*1*20=100` |
| 2 | 2.00 | `icon17`，3 轴，10 Ways，x1 | `1*10*1*20=200` |
| 3 | 3.00 | `icon13`，3 轴，5 Ways，x1 | `3*5*1*20=300` |
| 4 | 5.00 | `icon13`，4 轴，5 Ways，x1 | `5*5*1*20=500` |
| 5 | 6.00 | `icon7`，3 轴，5 Ways，x1 | `6*5*1*20=600` |
| 6 | 8.00 | `icon5`，3 轴，5 Ways，x1 | `8*5*1*20=800` |

六档必须使用不同的行分布和 Ways 数量布局；有效路线不得占用 `drawResult[0]` 或 `[20]`。每档首帧只包含声明的中奖 line，随后生成重力兼容且无新 Ways 的终止帧。

### 11.2 路线与中间状态覆盖

默认 `route-and-cascade` 套件按以下顺序执行：

1. 无中奖盘和两胡 near-miss。
2. 3 轴单 Ways，不同高度折线路线。
3. 3 轴多 Ways，同符号每列数量不同。
4. 4 轴和 5 轴 Ways。
5. 两个 icon 同一步同时中奖，`roundWin=sum(lines.score)`。
6. 基础 2 步级联，倍数 x1 -> x2。
7. 基础 4 步级联，倍数 x1 -> x2 -> x3 -> x5。
8. 金牌参与中奖后原位转 Wild。
9. 上一步 Wild 参与下一条路线并被消除补牌。
10. 一个 Wild 同时参与多个 icon 的 Boya 复用场景。
11. 级联中新补牌再次成路。
12. 达到 cascade limit 后生成合法终止盘。

每个场景 JSON 必须包含 `initialBoard`、seed、期望 step 数、期望 lines、期望消除位置、期望 goldToWildPos、期望累计金额和终止盘断言。

### 11.3 购买免费覆盖

默认 `buyfree-ladder` 包含：

- 3 胡 -> 10 次。
- 4 胡 -> 12 次。
- 5 胡 -> 14 次。
- 6 胡 -> 15 次。
- 免费 miss。
- 免费单步小奖 x2。
- 免费 2/3/4 步级联，依次显示 x2/x4/x6/x10。
- 免费金牌转 Wild 后继续中奖。
- 免费多 line 中奖。
- 3 胡 retrigger 追加 10 次。
- 总赢依次覆盖 small、medium、big、mega；所有金额由盘面公式得到。

## 12. SQLite 数据模型

数据库默认路径：`local-data/boya-mahjong2.sqlite3`，启动时开启 WAL、foreign_keys 和 busy_timeout。

| 表 | 关键字段 | 用途 |
|---|---|---|
| `schema_migrations` | `version, applied_at` | 幂等迁移 |
| `config_versions` | `id, version_no, name, status, created_at, activated_at` | draft/active/archived |
| `symbol_weights` | `config_id, mode, phase, reel, symbol_id, weight` | 每列每符号权重 |
| `outcome_weights` | `config_id, mode, outcome_key, weight` | 结果档位与购买胡数量权重 |
| `engine_settings` | `config_id, key, value_json` | gold rate、cascade limit 等 |
| `test_state` | `id=1, suite_key, scenario_key, cursor, cycle, updated_at` | 单一测试入口控制 |
| `game_sessions` | `id, mode, seed, config_id, opened_at, closed_at, close_reason` | WebSocket 游戏 session |
| `game_rounds` | `id, session_id, round_no, kind, bet, buy_cost, total_win, outcome, source, validation_status, created_at` | 一局领域历史 |
| `round_steps` | `id, round_id, step_no, cmd, board_json, buffers_json, lines_json, multiplier, round_win, total_win, free_remain, gold_to_wild_json` | 每步盘面/级联 |
| `protocol_events` | `id, session_id, round_id, direction, cmd, frame_sha256, decoded_json, created_at` | 协议诊断 |
| `admin_audit` | `id, action, before_json, after_json, created_at` | 后台变更审计 |

数据库写入边界：

- round 和其 steps 在生成、校验全部成功后一个事务落库。
- protocol event 在实际收发后追加；写历史失败不得悄悄丢失，session 标记 degraded 并在后台显示。
- `decoded_json` 保存可读字段；原始 frame 默认只保存 SHA-256，调试配置开启时才保存 BLOB，避免数据库无限膨胀。
- 历史保留上限默认 10000 局；后台清理必须二次确认并写 audit。

## 13. REST API 与后台

### 13.1 API

```text
GET  /api/health
GET  /api/admin/runtime
GET  /api/admin/config/active
POST /api/admin/config/drafts
PUT  /api/admin/config/drafts/:id
POST /api/admin/config/drafts/:id/validate
POST /api/admin/config/drafts/:id/activate
GET  /api/admin/scenarios
GET  /api/admin/test-state
PUT  /api/admin/test-state
POST /api/admin/simulate
GET  /api/history/rounds
GET  /api/history/rounds/:id
GET  /api/history/rounds/:id/steps
GET  /api/history/sessions/:id/events
DELETE /api/history/rounds
```

所有写 API 使用 JSON、校验 `Content-Type`、限制 body 大小 1 MiB，并返回 `{ok,data,error}`。配置更新携带 `expectedVersion`，版本冲突返回 409。

### 13.2 后台页面

后台采用无框架 HTML/CSS/ESM，包含四个标签页：

1. **概率配置**：base/free/buy 分段控件；initial/cascade 子标签；5 列表格；每个符号数字输入和归一化百分比；金牌率与级联上限。
2. **结果权重**：miss/small/medium/big/mega/super 和购买 3/4/5/6+ 胡权重；保存草稿、校验、激活。
3. **测试控制**：套件选择、场景选择、顺序循环开关、当前游标、重置和下一场景预览。
4. **运行与历史**：当前 session、激活配置版本、生成/模板兜底比例、最近错误；历史筛选和 round step 明细。

后台是操作工具，不做营销首页；桌面和手机都能编辑。表格溢出时横向滚动，按钮使用明确图标和 tooltip，保存/激活/删除状态不可混淆。

## 14. 历史记录行为

`/__history` 从 SQLite 查询，不再只显示当前进程内存日志。每局详情至少显示：

- test/live、scenarioKey、seed、configVersionId、generationSource。
- bet、购买费、局总赢、结果档位、前后余额。
- 初始盘、每步盘、每条 line 的 icon/轴数/Ways/odds/multi/score。
- 消除位置、金牌转 Wild、补牌、级联次数、免费剩余/追加次数。
- Validator 结论、fallback 原因、协议命令序列和 close reason。

旧 `/__history.json` 保持兼容，改为返回最近 200 条协议事件摘要；新领域历史使用 `/api/history/rounds`。

## 15. 一致性 Validator

任何帧发送前必须同时通过以下检查：

1. `drawResult.length=25`，`topResult.length=5`，`buttomResult.length=5`。
2. `drawResult[0]=drawResult[20]=101`，其他位置不能为 101。
3. 仅允许已定义符号；初始/补牌不能直接生成 Wild。
4. 每条 line 的 iconId 必须为奇数赔付符号。
5. 从盘面重算的轴数、Ways、odds、multi、score 与 line 完全一致。
6. `sum(lines.score)=roundWin`，累计 step 得到 `totalWin`。
7. 未声明的 Ways 不得存在；存在则必须生成对应 line。
8. goldToWildPos 必须是本步中奖中的金牌位置，下一步对应符号为 Wild。
9. Scatter 不得出现在消除集合；免费次数与 Scatter 数量一致。
10. 级联前后每列幸存符号顺序不变，补牌数量等于实际空缺。
11. base/free 命令、状态、扣款次数、freeRemain 转移合法。
12. `gameNumList/gameNum`、`lines.multi` 和当前级联轮次一致。
13. `roundScore`、余额、购买费用和累计奖金守恒。

Validator 输出稳定错误码，例如 `BOARD_SENTINEL_INVALID`、`LINE_WAYS_MISMATCH`、`PAYOUT_FORMULA_MISMATCH`、`CASCADE_GRAVITY_MISMATCH`、`FREE_COUNT_MISMATCH`，用于测试和后台诊断。

## 16. 安全与失败处理

- 默认只允许绑定 `127.0.0.1` 或 `::1`。
- 若显式绑定非 loopback，启动必须要求 `--admin-token`，写 API 使用 Bearer token。
- 静态文件路径做 realpath 根目录约束，禁止目录穿越。
- SQLite 使用参数化语句；所有 JSON 输入做 schema 校验。
- RNG 使用固定版本的 seeded 算法，禁止直接依赖 `Math.random()`；seed 存入历史并有 golden vector 单测。
- 配置无效时继续使用最后一个 active 版本，不自动激活草稿。
- 引擎异常时只允许返回经过校验的安全 miss，不得返回部分级联或半个免费状态。
- 服务关闭时等待当前事务完成、关闭 WebSocket、checkpoint WAL。

## 17. 兼容与迁移

现有入口继续保留：

```text
/__game/replay
/__game/dataset
/__game/normalwin
/__game/normalwin-1..6
/__game/winladder
/__history.json
```

迁移顺序：

1. 先接入 SQLite 和持久化历史，旧 replay responder 行为不变。
2. 提取 Boya codec/validator，使用 HAR 真实中奖帧做 golden tests。
3. 实现测试模式规则引擎和场景 runner。
4. 实现 live 概率采样、配置版本和模板兜底。
5. 实现购买免费 3/4/5/6+ 和完整免费级联。
6. 最后接后台 UI，并用 API 先完成所有功能测试。

数据库文件、`-wal`、`-shm` 和运行 PID/URL 文件加入 `.gitignore`；迁移 SQL、默认配置和场景 JSON 必须提交。

## 18. 测试与验收

### 18.1 自动测试

- 用真实 HAR 中奖帧回归所有 20 条 line 的奖金公式。
- 验证 Boya 符号真值：1=Scatter、2=Wild、101=固定空位、偶数为金牌。
- Ways 3/4/5 轴、多个 Ways、多 icon、Wild 跨 icon 复用。
- 金牌转 Wild、Wild 下一步消除、Scatter 重力不消除。
- 普通和免费倍数阶梯。
- 3/4/5/6/7 胡分别得到 10/12/14/15/16 次。
- seeded RNG golden vectors、每列权重边界、128 次失败后的同档模板兜底。
- SQLite 重启持久化、配置原子激活、历史 round/step 完整性。
- WebSocket 状态机覆盖 40000-40007 和 5000/5001。

门禁：

```bash
npm test
node --check tools/local/boya-local-server.mjs
git diff --check
```

### 18.2 Playwright 真机

启动命令：

```bash
node tools/local/boya-local-server.mjs \
  --root /Users/yang/work/git/sun/boyamajiang2/local-har-client/boya-mahjong2 \
  --frames /Users/yang/work/git/sun/boyamajiang2/debugserver-data/boya-mahjong2/raw-frames.json \
  --db /Users/yang/work/git/sun/boyamajiang2/local-data/boya-mahjong2.sqlite3 \
  --host 127.0.0.1 \
  --port 18082
```

必须分别验证：

1. `/__game/test` 跑完六档 1/2/3/5/6/8 元普通小奖，截图必须在高亮阶段；盘面、路径、line、公式金额一致。
2. `/__game/test` 跑 route-and-cascade，逐步截图金牌转 Wild、Wild 下一步消除和不同中间掉落路线。
3. `/__game/test` 分别购买 3/4/5/6 胡，客户端显示 10/12/14/15 次；免费奖励从小到大且倍数正确。
4. `/__game/live` 通过后台激活一份明显偏置配置，固定 seed 重跑得到相同结果；换 seed 后结果按权重变化。
5. 重启服务后配置、测试游标和历史仍存在。
6. 后台桌面 1440x900、手机 390x844 无遮挡、文字溢出或不可操作控件。

每个流程共同要求：

```text
HTTP 404 = 0
pageErrors = 0
clientClose = 0（主动测试结束除外）
mismatches = 0
登录/认证超时 = 0
Validator errors = 0
history round/step 数量与实际协议一致
```

截图和报告保存到：

```text
testwebgame/boya-mahjong2/local-controlled-final-YYYYMMDD-HHMMSS/
```

### 18.3 最终交付

- 两个客户端地址：`/__game/test`、`/__game/live`。
- 后台地址：`/__admin`。
- 历史地址：`/__history`。
- 服务 PID、启动命令、SQLite 路径。
- test/live/admin 三组 Playwright 报告与关键高亮截图。
- spec、实现说明、数据库迁移、默认配置、场景数据和测试全部提交。

## 19. 实施批次

每批独立测试、独立中文提交，不交叉修改无关文件：

1. **规则真值与测试先行**：固定符号、赔率、Ways、奖金、倍数、Scatter 和真实 HAR golden tests。
2. **盘面与级联引擎**：权重采样、金牌、Wild、重力、Validator。
3. **SQLite 与领域历史**：迁移、配置版本、round/step/event。
4. **协议与 session 状态机**：把规则结果编译为 40003/40005/40007。
5. **确定性测试模式**：普通阶梯、路线级联、购买免费套件。
6. **概率实时模式**：结果权重、条件采样、模板兜底、seed 重放。
7. **管理后台**：概率配置、测试控制、运行监控、历史详情。
8. **全链路真机验收**：素材 404、动画高亮、金额、免费次数、重启持久化和两地址交付。

进入下一批前，上一批的单测、集成测试和 `git diff --check` 必须通过。最终结论以 Boya 客户端真机表现和持久化历史为准，不以“接口返回成功”代替验收。

## 20. 2026-07-10 实施结果与经验复盘

### 20.1 已完成的本地闭环

当前仓库已经具备独立运行闭环，运行时不依赖 `slot-platform`：

- `tools/local/engine/`：固定赔率、seeded RNG、每列权重采样、Ways、级联、金牌转 Wild、Validator、确定性场景和 outcome fallback。
- `tools/local/server/database.mjs`：SQLite WAL、配置版本、测试游标、session、round、step、协议事件和后台审计持久化。
- `tools/local/server/controlled-responder.mjs`：test/live 的 `40002/40003`、`40006/40007`、`40004/40005` 和心跳状态机。
- `tools/local/server/control-api.mjs`：配置草稿、结构校验、激活、测试套件控制、模拟和运行信息 API。
- `local-admin/boya-mahjong2/`：base/free/buy、initial/cascade、5 列符号权重、金牌率、结果权重、胡数量、测试控制和历史详情后台。
- `/__game/test`：普通小奖阶梯、28 类路线/级联/Wild 场景、3/4/5/6 胡购买免费。
- `/__game/live`：新 session 绑定激活配置；基础局和购买后的免费局都由本地列权重与 outcome 权重控制。
- `/__history`、`/api/history/rounds`：读取 SQLite 领域历史，重启后仍存在。

测试模式购买免费使用真实 HAR 免费旋转组作为原子单位，组内盘面、lines、倍率和 Wild 转换不改；只把完整旋转组重排为：

```text
0 / 0 / 0 / 0 / 0 / 0 / 0 / 0 / 5.60 / 12.80 / 53.60 / 145.60
```

live 免费模式不复用这套固定盘面，而是读取 `free.initial/cascade` 每列权重和 free outcome 权重，由规则引擎生成盘面后编译进真实 `40005` 外壳。

### 20.2 确定性路线套件

`route-and-cascade` 已扩展为 28 个可在后台单独选择或循环的场景：

```text
route-near-miss
route-zigzag-single
route-multi-ways
route-five-axes
route-multi-icon
cascade-two-win-steps
cascade-four-win-steps
cascade-gold-to-wild
cascade-wild-next-eliminate
route-wild-reuse
cascade-refill-win
cascade-limit-terminal
route-top-single
route-bottom-single
route-four-axes
route-four-axes-multi-ways
route-five-axes-multi-ways
route-three-icons
cascade-one-win-step
cascade-three-win-steps
cascade-multi-way-refill
cascade-multi-icon-refill
cascade-scatter-gravity
cascade-gold-wild-hold
cascade-double-gold-to-wild
route-multiple-wild-same-line
cascade-gold-wild-multi-icon
route-mixed-base-gold-wild
```

这些场景只定义初始 25 格盘面和每列后续补牌队列；`lines`、Ways、倍率和金额仍由统一规则引擎计算。`cascade-limit-terminal` 在上限处再做一次重力掉落，只有新盘面无 Ways 才作为合法终止盘发送，否则拒绝生成。

### 20.3 协议与素材排障经验

1. `40001` 不是 MsgRotate。Playwright 观察器现在对它单独解码用户余额；只对 `40003/40005/40007` 解码旋转数据，并对 `20048/20052` 单独解码本地历史。
2. recorded base `40003` 没有 field 14。原 protobuf 重建器只替换已有 packed 字段，导致服务端计算出 `goldToWildPos` 但客户端收不到；现在会把缺失的 packed override 按字段追加。
3. HAR 基础局全输，中奖后懒加载的 `14symbol02` 音效没有被抓取。已补齐本地 metadata JSON 和 MP3，并增加资源存在性单测。
4. 不能用固定的短等待假设按钮已经解锁。旋转和购买测试都以观察到新的 `40002/40006` 为准，未发请求时按间隔重试点击。
5. Cocos 收到网络帧后仍要完成滚轴停止，高亮截图不能在帧刚到时截。连续取帧确认约 2570--3070 ms 才是稳定高亮窗口；场景矩阵统一等待 2700 ms，最终截图能同时看到发光路径和“赢取”金额。
6. 免费奖励排序必须按完整 free-spin group 做，不能按单个 `40005` 排序，否则会拆散同一局 x2/x4/x6/x10 级联并破坏累计金额。
7. live free 的每一步仍使用真实 HAR 外壳：中奖步按 x2/x4/x6/x10 选择外壳，普通终止使用真实终止外壳，最后一步使用真实退出免费状态外壳；只替换 Validator 已确认字段。

### 20.4 最终真机验收

最终报告：

`testwebgame/boya-mahjong2/local-controlled-final-20260710-regression/report.md`

关键结果：

```text
verdict = PASS
unit tests = 62 pass
base ladder = 1.00 / 2.00 / 3.00 / 5.00 / 6.00 / 8.00
route goldToWildCount = 1
route Wild next eliminated = true
route Wild reuse lines = 2
base cascade multipliers = 1 / 2 / 3 / 5
buy scatter/free = 3->10, 4->12, 5->14, 6->15
test free totals ascending = true
test free largest cascade = 112.80
live base = 20.00 x 3, source=weighted
live free = 3 胡 / 10 次 / 10 个 40005, source=weighted-free
live free configured columns match = true
HTTP 404 = 0
pageErrors = 0
clientClose = 0
mismatches = 0
```

人工检查通过的关键截图：

```text
base-00100-highlight.png ... base-00800-highlight.png
route-gold-highlight.png
route-wild-highlight.png
route-wild-reuse-highlight.png
route-cascade-x5-highlight.png
buy-x10-highlight.png
buy-largest-highlight.png
live-forced-medium-highlight.png
live-free-complete.png
admin-desktop.png
admin-mobile.png
```

### 20.5 V1 证据边界

当前唯一主动限制是免费旋转内的 3+ Scatter retrigger：现有 HAR 没有 retrigger `40005` 状态链，不能确认客户端要求的追加动画字段和时序。live free 生成时暂把单盘 Scatter 上限限制为 2，避免伪造状态并再次引发认证超时。购买入口的 3/4/5/6 胡与 10/12/14/15 次已完整实现和真机验证；拿到真实 retrigger 录制后再开放该项。

### 20.6 live 客户端控件与游戏内历史补齐

2026-07-10 对 `/__game/live` 的客户端原生控件做了第二轮协议级验收，补齐以下闭环：

1. 普通旋转 `40002` 和购买 `40006` 的请求 payload field 1 是当前 `betMult`。服务端必须逐次读取，不能只使用建连时 HAR 的默认 `20`；`betCoin = betMult * 20`，购买费用为 `betCoin * 80`。
2. `40003`、`40007` 以及购买后的每个 `40005` 都必须回写同一档 `betMulti/betCoin`。只改购买触发帧会导致免费旋转继承 HAR 的旧下注值。
3. live 每次收到 `40006` 时重新读取当前 active 配置，按 `buy.scatterWeights` 选择 3/4/5/6 个胡；胡位置使用保存 seed 的 Fisher-Yates 洗牌，只落在 23 个可玩位置，不能继续使用 HAR 固定位置 `[3,6,12]`。
4. 购买后的免费盘面不是固定录制结果。live 使用当前 `free.initial/cascade` 列权重、free outcome 权重和本局 seed 生成；HAR `40005` 只作为客户端已验证的协议外壳。
5. 客户端“历史”走大厅连接，不是 `/api/history/rounds`：列表为 `20047 -> 20048`，详情为 `20051 -> 20052`。本地 hall responder 从 SQLite 读取 live/test 记录，再编码为客户端要求的 gzip protobuf；购买局与随后 free-feature 合并为一条列表记录。
6. 详情中的 `Detail` 是 gzip 后再 base64 的 JSON。除盘面、Lines、金额外必须包含 Unix 秒字段 `startTime`；缺少它时客户端 `CommonUtil.getTime()` 会因 Invalid Date 的 `toJSON()` 返回 null 而报 `null.substr`，详情永远停在“加载中”。
7. 自动旋转弹窗是懒加载资源，除入口 prefab `0b45ea3c9...json` 外还依赖 `b9140739...json` 和 `a3e01927...json`。三份资源都必须本地存在并由资源单测保护，否则按钮表现为无限转圈。
8. SQLite schema v2 保存 `bet_multi`、`balance_before`、`balance_after`，使游戏内历史详情可以还原真实下注档、扣款前后余额和购买记录，而不是继续显示 HAR 固定数据。

聚焦本轮需求的可重复真机脚本：

```bash
node tests/playwright/boya-mahjong2-live-controls.mjs \
  --base-url http://127.0.0.1:18082 \
  --out testwebgame/boya-mahjong2/local-controlled-final-20260710-live-controls
```

报告：`testwebgame/boya-mahjong2/local-controlled-final-20260710-live-controls/report.md`（运行产物按 `.gitignore` 不提交）。本次结果：

```text
verdict = PASS
auto = 3 requests / 3 responses
selected bet = betMulti 100 / betCoin 2000 / UI 20.00
feature buy = cost 160000 / UI 1600.00
buy trigger = 4 胡 / positions 6,12,13,19 / 12 free spins
first free = betMulti 100 / betCoin 2000
in-game history = 20048 list + 20052 detail loaded
HTTP >= 400 = 0
pageErrors = 0
clientClose = 0
authTimeout = false
mismatches = 0
```

### 20.7 本地用户与 28 场景扩展复盘

本地用户合同和 28 个路线场景的最终实现、报告与排障记录见：

```text
docs/specs/2026-07-10-boya-mahjong2-local-users-scenario-coverage-spec.md
```

额外门禁如下：

- 普通 `40003` 每一步最多 2 个胡；3+ 胡必须由购买触发 `40006/40007` 进入免费状态。
- 场景元数据保存精确 `scatterCount`，单测和 Playwright 都按精确数量验证，不能只保存“是否包含胡”。
- 本地用户 token 由 `/__game/live?token=...` 接收，地址栏由同源入口壳保持不变；内层 Cocos 兼容值不参与本地认证，用户只通过 `g` 内 WS `userToken` 绑定。
- `user1`、`user2`、`usergame1` 的余额、历史、RTP 和游戏内 `20048/20052` 均按 SQLite 用户隔离；跨用户详情返回 404。
- “两个 Wild 同一路线”最终只保留一条 `iconId=13` 四轴 4 Ways，避免 Wild 顺带把第一轴填充符号变成额外中奖线。

最终证据目录：

```text
testwebgame/boya-mahjong2/local-controlled-final-20260710-scenario-matrix-final/
testwebgame/boya-mahjong2/local-controlled-final-20260710-multiple-wild-fixed/
testwebgame/boya-mahjong2/local-controlled-final-20260710-local-users/
testwebgame/boya-mahjong2/local-controlled-final-20260710-live-controls-usergame1/
testwebgame/boya-mahjong2/local-controlled-final-20260710-regression/
```

### 20.8 级联可视错位、长转与本地 token 最终修复

2026-07-10 的人工截图复核发现，旧引擎虽然逐帧满足 `drawResult + lines + score` 公式，但把级联补牌写到了下一帧的 `topResult`。Cocos 会用当前中奖帧的 `topResult` 先执行掉落，因此下一帧高亮时盘面已经被错误补牌替换。最终修复为：

```text
current winning step.topResult = current cascade incomingByReel.at(-1)
next step.drawResult = cascaded board
```

新增门禁和结果：

- 单测固定 `cascade-limit-terminal`：第一中奖帧补牌必须是 `[7,7,7]`，第二中奖帧终止补牌必须是 `[3,5,11]`。
- 28 个场景逐个浏览器执行，所有中奖步骤保留早/中/晚三帧，高亮路线人工复核；2 个胡场景使用独立长等待。
- 每个测试场景终局后 `idleRequests=0`；live 强制概率连续 10 把，每把均有终局且 `idleRequests=0`。
- `/__game/test` 和 `/__game/live?token=user1` 由同源入口壳保持地址栏不变，内层兼容 token 不参与本地用户认证。
- 客户端 `gateConfig` 默认网关改为当前 `window.location.host`。
- 最终运行时审计覆盖客户端、后台和历史：唯一主机为 `127.0.0.1:18082`，外部 URL、HTTP 4xx/5xx、请求失败均为 0。

完整证据和路径见 `docs/specs/2026-07-10-boya-mahjong2-local-users-scenario-coverage-spec.md` 第 11 节。
