# Boya 麻将2本地用户与场景覆盖实施计划

**目标:** 在现有本地 Cocos + Node + SQLite 服务上增加 token 用户隔离、用户 RTP/历史后台、至少 38 个确定性场景，并完成线路与元素真机校验。

**架构:** URL 把本地 token 同时传给 Cocos 和本地 WebSocket；SQLite 用户表是余额与归属真值；规则引擎仍是所有盘面、lines、消除和金额的唯一来源；HAR 只提供客户端兼容的 protobuf 外壳。

**技术栈:** Node.js ESM、`node:sqlite`、protobuf wire patch、原生 HTML/CSS/JS、Playwright 1.61.1。

## 任务 1：用户数据库与聚合统计

**文件:**

- 修改 `tools/local/server/database.mjs`
- 修改 `tests/unit/boya-database.test.mjs`

步骤：

1. 先写失败测试：`getOrCreateUser("user1")` 初始余额为 `100000000`，重复读取 ID/余额不变，`user1/user2` 不同。
2. 写失败测试：session 绑定 user 后，`listRounds({ token })` 只返回所属记录。
3. 写失败测试：普通下注、购买和 free-feature 聚合得到正确 `totalWager/totalWin/rtp`。
4. 增加 schema v3、`local_users`、`game_sessions.user_id`、索引和兼容迁移。
5. 在 `recordRound` 事务内可选更新用户余额，避免历史已写但用户余额未写。
6. 跑数据库单测和重开 SQLite 持久化测试。

## 任务 2：token URL 与进入余额协议

**文件:**

- 修改 `tools/lib/boya-har.mjs`
- 修改 `tools/local/boya-local-server.mjs`
- 修改 `tools/local/server/controlled-responder.mjs`
- 修改 `tools/local/server/hall-history-responder.mjs`
- 修改 `tests/unit/boya-har.test.mjs`
- 修改 `tests/unit/boya-controlled-responder.test.mjs`
- 修改 `tests/unit/boya-hall-history.test.mjs`

步骤：

1. 先写失败测试：`buildLocalGameUrl(..., token:"user1")` 的 HTTP token 和解码后 WS `userToken` 都是 `user1`。
2. 先写失败测试：非法 token 被拒绝；无 token 使用 `local-default`。
3. 解析真实 `40001`，写失败测试锁定余额路径并验证 patch 后进入帧余额等于用户余额。
4. live WebSocket 创建/读取本地用户，并把用户传给大厅和游戏 responder；test 保持不扣用户余额。
5. 普通下注和购买/free 完成时事务保存新余额；所有 session/round 带用户归属。
6. 游戏内历史按当前 userId 过滤，详情不能跨用户读取。

## 任务 3：后台用户、RTP 与历史过滤

**文件:**

- 修改 `tools/local/server/control-api.mjs`
- 修改 `tools/local/boya-local-server.mjs`
- 修改 `local-admin/boya-mahjong2/index.html`
- 修改 `local-admin/boya-mahjong2/admin.mjs`
- 修改 `local-admin/boya-mahjong2/admin.css`
- 修改 `tests/unit/boya-control-api.test.mjs`

步骤：

1. 增加用户列表和单用户统计 API，返回余额、roundCount、totalWager、totalWin、rtp。
2. 扩展历史 API 的 token 参数和详情所有权检查。
3. 后台增加“用户”tab 和紧凑统计表；点击用户进入带 token 的历史。
4. 历史表增加 token 列和 token 筛选输入。
5. Playwright 在桌面和手机验证用户表、筛选和详情无溢出。

## 任务 4：确定性场景扩展

**文件:**

- 修改 `tools/local/engine/scenarios.mjs`
- 修改 `tools/local/server/control-api.mjs`
- 修改 `tests/unit/boya-engine.test.mjs`
- 修改 `tests/unit/boya-control-api.test.mjs`

步骤：

1. 先写失败测试：route 场景不少于 28，总目录不少于 38。
2. 为场景增加预期中奖步数、倍率、Wild/金牌/Scatter 元数据，并写实际 plan 校验。
3. 逐批增加轴数/Ways、多图标、1/2/3/4 次掉落、补牌、Wild 生命周期和 Scatter 重力场景。
4. 每新增一批立即运行 `buildRoundPlan` 和 `validateStep`，删除任何无法合法终止或产生额外未声明 Ways 的盘面。
5. 后台场景表显示中奖步数、标签和关键预期。

## 任务 5：线路协议二次校验与问题修复

**文件:**

- 修改 `tools/local/engine/validator.mjs`
- 修改 `tools/local/server/controlled-responder.mjs`
- 新增或修改相应 unit tests

步骤：

1. 为编译后的 `40003/40005` 增加 decode-after-encode 校验测试。
2. 对每条 line 输出从盘面推导的 `positionsByReel`，验证每个连续轴都有实际匹配元素。
3. 对每个级联验证上一盘消除/金转 Wild/重力与下一盘逐格一致。
4. 用最小复现场景定位用户观察到的错线属于引擎、协议外壳还是截图时序，再只修根因。

## 任务 6：Playwright 全链路验收

**文件:**

- 新增 `tests/playwright/boya-mahjong2-scenario-matrix.mjs`
- 扩展 `tests/playwright/boya-mahjong2-live-controls.mjs`
- 更新主 spec 实施结果章节

步骤：

1. test 模式逐场景设置 `scenarioKey`，收集完整响应序列、重算公式并在每个中奖高亮窗口截图。
2. 保存每步 `protocol.json`，记录盘面、lines、预期位置、金额、Wild/金牌和终止帧。
3. 分别用 `user1/user2/usergame1` 打开 live，验证初始余额、独立下注和独立历史。
4. 对 live 强制配置和默认概率各跑一组，验证线路、元素、购买 3+ 胡和 free 数据。
5. 打开游戏内历史和后台用户/RTP，截图核对同一用户数据一致。
6. 最终运行 `npm test`、所有 `.mjs` 的 `node --check`、`git diff --check`；要求 HTTP/pageerror/clientClose/authTimeout/mismatch 全为 0。

