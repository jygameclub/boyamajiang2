# 任务提示词：让 boya 麻将2 本地客户端「盘面 / 中奖路径 / 奖金」三者对齐

> 把下面「=== 提示词开始 ===」到「=== 提示词结束 ===」之间的内容整段粘到新窗口即可。

=== 提示词开始 ===

你在目录 `/Users/yang/work/git/sun/boyamajiang2` 工作，不要切换分支，默认中文回答。先读
`docs/specs/2026-07-09-boya-mahjong2-har-local-replay-spec.md`（尤其 §9/§10/§11）了解全部背景，再开工。

## 背景（已完成的部分，别重做）
这是一个从 HAR 还原的 PG《Mahjong Ways 2/ 麻将胜利2》本地 Cocos 客户端 + 本地回放测试服务。
协议是 protobuf-over-WebSocket：`40002→40003` 基础旋转、`40006→40007` 触发免费旋转、
`40004→40005` 级联/掉落步、`5000/5001` 心跳。核心代码：
- 本地服务：`tools/local/boya-local-server.mjs`
- 帧/回放逻辑：`tools/lib/boya-har.mjs`
- 单测：`tests/unit/boya-har.test.mjs`
- 录制帧：`debugserver-data/boya-mahjong2/raw-frames.json`（`connections[1]` 是游戏连接）

已实现并真机验证通过：登录认证超时修复（§9）、winladder 每把切换 27 套真实盘面（§10）、
点“购买免费游戏”回放真实免费旋转级联（§11 Phase A，盘面掉落 + 累计中奖 + 倍数 + 剩余次数，无 404、无超时）。

## 现在要解决的问题（本次任务）
winladder 基础旋转目前把**一个输掉的真实盘面**（`drawResult` 无中奖组合）拿来，只**硬改金额字段**
（`totalWin/roundWin`）成阶梯值，且**不写 `lines`**。结果：客户端显示“总赢取 12.00”，但盘面上根本
没有对应的中奖组合、也不高亮任何中奖路径——**盘面、中奖路径、奖金三者对不上**。要让它们一致：
盘面必须真实含有中奖组合，`lines` 指向的中奖符号必须在盘面里成路，奖金 = 各 line 分数之和（×倍数），
客户端要能高亮出这条中奖路径。

## 已探明的关键事实（省得你重查）
- 中奖路径编码在 MsgRotate 的 `lines`（field 11）：每条 line = `{iconId, axleId, lineNum, score, multi, odds}`，
  **没有显式坐标**。客户端靠 `iconId + Ways 全路径`（2000 Ways）高亮：把盘面里所有该 `iconId` 的符号按
  从第 1 列起连续成路来判定。所以**盘面 `drawResult` 必须真实含有该 iconId 的 Ways 组合**，否则高亮不出来、对不上。
- 盘面布局：5 列 × 7 行 = 35 格。boya 的 `drawResult`(25)=中间 5×5 可见格，`topResult`(5)+`buttomResult`(5)=上下行，
  合 35。符号 ID：`101`≈胡/Scatter，`11/13/15/17/19`≈高价值，`3–9`≈低价值（与 slot-platform 的 0–10 编号不同）。
- 真实中奖帧是**天然自洽**的：例如录制的 `40005` 里，`totalWin=480` 时 `lines=[{iconId:17,score:480,...}]` 且
  盘面里 `17` 出现 4 次；`totalWin=3280` 有 4 条 line，各自 iconId 在盘面出现 2–5 次。**盘面+路径+奖金已对齐**。
  → 结论：**要对齐，就得用“真实中奖帧”作为原子单位**，而不是“输的盘面 + 假金额”。
- 录制里**没有基础游戏的中奖帧**：基础 `40003` 全是输（`totalWin=0`、无 line、`roundScore=-下注`）；
  所有真实中奖都在免费旋转的 `40005` 里（带 `status=1`、`freeRemainCount` 等免费态字段）。
- 关键坑：伪造中奖帧（带 `goldToWildPos` 或与盘面不符的 line）会让客户端去加载一张从未录制的中奖动画
  webp（404）、自动重转、约 4–5 秒后看门狗判定“登录认证超时”并 `closeChannel()`。所以**任何改动都必须真机验证**。
- 已证明可行：免费旋转级联（`40006/40007`→`40004/40005`）回放**真实帧**时，中奖+路径+goldToWild 全部正确渲染，
  **无 404、无超时**（`createFreeSpinReplayer` 已实现）。

## 建议方案（可自行判断，但要保证三者对齐）
优先考虑「基于真实中奖帧」的两条路线，二选一或组合：
1. **真实帧按金额小到大排序**：从录制的 `40005` 中挑出不同 `totalWin` 的自洽中奖帧，去掉免费态专属字段
   （`status`/`freeRemainCount` 等，保留 `drawResult/topResult/buttomResult/lines/goldToWildPos/totalWin/roundWin`），
   作为基础旋转结果按 480→3280→14560… 小到大回放。盘面+路径+奖金天然对齐。
2. **等比缩放命中自定义阶梯**：取一条真实自洽中奖帧，把它的 `lines[].score` 与 `totalWin/roundWin` **同比缩放**到
   目标阶梯值（如 400/1200/…/20000），**保持 iconId 与位置不变**（路径不变，只变金额量级）。这样既对齐又能命中阶梯。
必须先验证的未知点：基础 `40003` 带 `lines>0` 时客户端会不会请求掉落（`40004`）期待级联步——若会，就用已有的
`createFreeSpinReplayer` 思路提供后续 `40005`，或改走免费旋转流程展示中奖。**以真机行为为准，别猜。**

## 涉及文件
- 改：`tools/lib/boya-har.mjs`（`createWinLadderFrameFromBase` / `createWinLadderResponder` / 可能新增“真实中奖帧库”）、
  必要时 `tools/local/boya-local-server.mjs`（历史记录字段）。
- 加回归单测：`tests/unit/boya-har.test.mjs`（断言返回帧的 `lines` iconId 在 `drawResult` 中成路、`totalWin`=各 line 分数和）。
- 更新 spec：`docs/specs/2026-07-09-boya-mahjong2-har-local-replay-spec.md` 新增一节记录本次“对齐”方案与验证。

## 参考项目（Unity 侧“设计盘面→引擎产出一致中奖”的范式，别照搬编号，理解思路）
`/Users/yang/work/git/slot-platform`：
- 场景设计 `slot-server/scripts/scenario-definitions/mahjong2.yaml`（人工设计 initialBoard + outputType 小到大 + sessionType）
- 编译脚本 `slot-server/scripts/generate-debugserver-datasets.py`（把设计盘面喂真实 Java 引擎产出自洽级联+中奖）
- 数据集 `debugserver-data/mahjong2/0NN.json`（字段 `orl/rl` 盘面、`wp/lw` 中奖位置/线、`tw/ctw` 金额）
- 规则/符号 `slot-server/server-game/mahjong2-service/guize.md`

## 如何运行与真机验证（必须做）
1. 启动本地服务（先杀旧进程 `lsof -ti tcp:18082 | xargs -r kill`）：
   ```
   node tools/local/boya-local-server.mjs \
     --root /Users/yang/work/git/sun/boyamajiang2/local-har-client/boya-mahjong2 \
     --frames /Users/yang/work/git/sun/boyamajiang2/debugserver-data/boya-mahjong2/raw-frames.json \
     --host 127.0.0.1 --port 18082
   ```
2. 用 Playwright（已装，v1.61.1）headless 驱动真机，脚本放项目根目录（`node_modules` 才能 import `playwright`），
   启动参数 `--use-gl=angle --use-angle=swiftshader --ignore-gpu-blocklist --enable-webgl`，viewport 900×1400。
   页面：`http://127.0.0.1:18082/__game/winladder`。点击坐标：开始(450,1075)、旋转(450,1315)、
   购买免费游戏(145,1090)→绿色“购买”(590,1150)。监听 WebSocket 帧（cmd=第 4–7 字节 UInt32BE & 0x7fffffff）、
   `close`、HTTP≥400。逐把截图，**肉眼确认盘面上高亮的中奖路径 = lines 的 iconId、且与显示金额一致**。
3. 历史：`http://127.0.0.1:18082/__history.json`（含 `winAmount/boardIndex`）。

## 验收标准
1. winladder 基础旋转：每把盘面**真实含有中奖组合**，客户端高亮的中奖路径与 `lines` 一致，显示金额=该组合奖金，
   金额整体小到大；真机截图为证。
2. 全程无“登录超时/登录认证超时”，无 404 图片，`clientClose=0`、`mismatches=0`。
3. 免费旋转级联（§11 Phase A）不被破坏，仍正常。
4. `npm test` 全绿（含新增“路径-奖金一致性”单测）、`node --check tools/lib/boya-har.mjs`、
   `node --check tools/local/boya-local-server.mjs`、`git diff --check` 全通过。
5. 更新 spec，最后给真机游戏内截图 + 当前服务 PID 与可用地址。

不要只信自动化测试；一定要真机复现确认“路径-盘面-奖金”对齐后再收工。

=== 提示词结束 ===
