# Boya 麻将2 HAR 本地还原与 Bet 验证 Spec

**日期:** 2026-07-09
**工作目录:** `/Users/yang/work/git/sun/boyamajiang2`
**输入 HAR:** `/Users/yang/work/git/sun/boyamajiang2/麻将2 boya.har`
**参考项目:** `/Users/yang/work/git/slot-platform`
**状态:** 已实现本地 HAR 客户端、WebSocket replay 服务、dataset 测试入口、普通小奖阶梯入口、winladder 免费级联入口、历史记录页、图片预览导出和 Playwright bet 验证；已修复 winladder「登录认证超时」（见 §9）。**已实现（§10 / §11 Phase A / §13）：** winladder 每把切换真实盘面（27 套）；`normalwin-1..6` 用 slot-platform Mahjong2 普通中奖盘面驱动 1.00→8.00 小奖，盘面/lines/奖金一致；点“购买免费游戏”回放真实免费旋转级联（“盘面掉了”+ 累计中奖 + 倍数 x2/x4/x6/x10 + 剩余次数）。normalwin、winladder 与 dataset 模式均通过真机验证，无认证超时/无 404。对齐 slot-platform Unity Mahjong2 的调查与后续 Phase B/C 见 §11。

## 1. 结论

需求理解如下：

- 把当前目录的 `麻将2 boya.har` 解析成可本地运行的 Boya 麻将2客户端资源。
- 参考 `slot-platform` 的本地测试链路，但不直接污染现有 MahjongWays2 Unity 数据。
- 在当前仓库落地本地静态客户端、本地测试数据服务、HAR 数据导入产物和 Playwright 验证脚本。
- 最终验收必须是真实浏览器打开本地客户端，成功进入游戏，点击或触发 bet，服务端返回 HAR 数据里的 bet 响应，页面有可见游戏画面，并保存截图。

当前 HAR 不是压缩包，而是 57MB 的纯 HAR JSON。里面 329 条请求中，静态资源来自 `game.666789.site`，业务数据走 `wss://gateway.666789.site/gate/ws`，不是 HTTP `enterGame/bet` 接口。因此实现必须分两层：

- 静态资源层：从 HAR 还原 `/v2/` Cocos 客户端。
- 业务数据层：从 HAR 的 WebSocket frame 还原本地 replay/debug 数据，用本地 WebSocket 测试服务驱动客户端 enter 和 bet。

## 2. 当前事实

### 2.1 HAR 内容

- 文件：`/Users/yang/work/git/sun/boyamajiang2/麻将2 boya.har`
- 大小：`60224177` bytes
- 请求数：`329`
- host：
  - `game.666789.site`: 327 条
  - `gateway.666789.site`: 2 条 WebSocket
- 主要资源：
  - Cocos 入口：`https://game.666789.site/v2/?token=...&lang=CN&g=...`
  - 游戏 bundle：`dy_mjlltwo_en`
  - 游戏资源：`/v2/assets/dy_mjlltwo_en/...`
  - 公共资源：`/v2/assets/resources/...`
  - JS：21 个
  - JSON：177 个
  - 图片：78 个
  - 音频：29 个
  - bin/字体：15 个

### 2.2 游戏协议

从 HAR 内的游戏 JS 已确认：

```text
bundle/name: dy_mjlltwo_en
USER_GET_DATA_REQ:          40000
USER_GET_DATA_REP:          40001
USER_ROTATE_NORMAL_REQ:     40002
USER_ROTATE_NORMAL_REP:     40003
USER_ROTATE_FREE_REQ:       40004
USER_ROTATE_FREE_REP:       40005
USER_SPE_ENTER_FREE_REQ:    40006
USER_SPE_ENTER_FREE_REP:    40007
USER_SET_TEST_DATA_REQ:     40100
USER_SET_TEST_DATA_REP:     40101
```

HAR WebSocket frame 统计：

```text
send    53
receive 54

40000/40001: 1 组，进入游戏数据
40002/40003: 4 组，普通 bet
40004/40005: 23 组，免费旋转或连续链路
40006/40007: 1 组，购买/进入免费游戏
```

frame 格式初步判断：

```text
bytes 0..3   big-endian frame length
bytes 4..7   big-endian command id，部分响应带 high-bit 压缩标记
bytes 8..11  reserved/flags，目前样本为 0
bytes 12..   protobuf payload 或 gzip/protobuf payload
```

### 2.3 slot-platform 可复用能力

可复用思路：

- `debugserver-data/mahjong2/000.json` 表示 enter。
- `debugserver-data/mahjong2/001.json+` 表示 bet 数据。
- `coverage-config.yaml` 描述棋盘、symbol、场景类型。
- `slot-server/scripts/import-geisha-har-debugserver.py` 已有 HAR 导入到 DebugServer 多文件结构的先例。
- `slot-server/scripts/generate-debugserver-datasets.py` 已有 chain grouping、scenario、coverage 逻辑。
- `web_cocos/shared/cocos-debug-url.js` 已有 Cocos URL debug 注入思路。
- `testwebgame/` 已有 Playwright 打开页面、点击 canvas、截图、记录 console/pageerror 的模式。

不能直接复用的点：

- `slot-platform/debugserver-data/mahjong2` 是另一套 MahjongWays2 Unity/服务端 JSON 数据，不是 Boya Cocos `dy_mjlltwo_en` 的 WebSocket protobuf 协议。
- 当前 HAR 没有 HTTP `enterGame/bet` 响应，不能照搬 HTTP 导入脚本。
- 第一版必须先用本地 WebSocket replay server 保证客户端可跑和可 bet，再决定是否做完整 DebugServer Java 集成。

## 3. 目标

### 3.1 必须完成

- 从 HAR 抽取所有本地运行必需资源，保持 `/v2/` 路径结构。
- 本地启动一个 HTTP server，能访问 Boya 麻将2 Cocos 页面。
- 本地启动一个 WebSocket replay server，接收客户端发送的 frame，并按命令返回 HAR 中对应的 receive frame。
- 进入游戏时返回 `40001 USER_GET_DATA_REP`。
- 普通 bet 时至少返回一条 `40003 USER_ROTATE_NORMAL_REP`。
- 提供一个本地生成的中奖控制入口，按小到大顺序返回 `40003 USER_ROTATE_NORMAL_REP`，用于人工验证中奖展示。
- 免费/连续链路场景可按 HAR 顺序返回 `40005`，但第一版验收只要求普通 bet 成功。
- Playwright 打开本地 URL，等待 canvas 可见，完成 enter，触发 bet，确认有 bet 响应和画面变化，保存截图。
- 输出截图到当前仓库 `testwebgame/boya-mahjong2/YYYYMMDD-HHMMSS/`，例如 `testwebgame/boya-mahjong2/20260709-135000/`。

### 3.2 非目标

- 第一版不要求复刻线上真实登录、真实余额、真实生产 gateway。
- 第一版不把 Boya 数据写入 `slot-platform/debugserver-data/mahjong2`。
- 第一版不要求完整数学验算 RTP。
- 第一版不要求自动识别每个 protobuf 字段的业务语义；只要求 raw replay 能驱动客户端。
- 第一版不修改 `slot-platform` 业务代码；只参考其结构和命令。

### 3.3 已新增运行入口

本地服务启动后写出四个 URL 文件：

```text
.boya-local-server-url    HAR 原始顺序回放入口
.boya-local-dataset-url   本地测试数据集入口
.boya-local-normalwin-url 普通小奖阶梯入口
.boya-local-winladder-url 小到大中奖控制入口
.boya-local-history-url   本地历史记录页面
```

直接访问地址：

```text
http://127.0.0.1:18082/__game/replay
http://127.0.0.1:18082/__game/dataset
http://127.0.0.1:18082/__game/normalwin
http://127.0.0.1:18082/__game/normalwin-1
...
http://127.0.0.1:18082/__game/normalwin-6
http://127.0.0.1:18082/__game/winladder
http://127.0.0.1:18082/__history
```

`/__game/replay` 会跳转到本地 `/v2/` 客户端，WebSocket 指向 `ws://127.0.0.1:18082/gate/ws?mode=replay`，按 HAR 中原始 frame 顺序回放。

`/__game/dataset` 会跳转到同一个本地客户端，WebSocket 指向 `ws://127.0.0.1:18082/gate/ws?mode=dataset`。该模式下 `40001` 仍使用 HAR enter 数据，`40003` 从 HAR 捕获到的 4 条 bet 结果中循环返回，并在历史中标记 `source=dataset`、`datasetIndex`、`datasetCount`。

`/__game/normalwin` 会跳转到同一个本地客户端，WebSocket 指向 `ws://127.0.0.1:18082/gate/ws?mode=normalwin`。该模式下 `40001` 仍使用 HAR enter 数据，`40003` 由本地服务用 slot-platform Mahjong2 普通中奖盘面生成，并按 `100 -> 200 -> 300 -> 500 -> 600 -> 800` 循环返回；历史中标记 `source=normalwin`、`datasetIndex` 和 `winAmount`。固定入口 `normalwin-1..6` 每次只返回对应档位，便于人工逐条验证普通中奖路径。

`/__game/winladder` 会跳转到同一个本地客户端，WebSocket 指向 `ws://127.0.0.1:18082/gate/ws?mode=winladder`。该模式下 `40001` 仍使用 HAR enter 数据，基础 `40003` 保持真实安全帧；小到大奖励通过购买免费游戏链路 `40006 -> 40007 -> 40004 -> 40005` 承载，按 `400 -> 1200 -> 2400 -> 6000 -> 12000 -> 20000` 输出；历史中标记 `source=freespin-cascade` 和 `winAmount`。

所有模式都会对客户端 `5000` 心跳请求返回本地 `5001` 心跳响应；该响应独立于 HAR replay 游标，避免长时间停留或多次 spin 后因 HAR 心跳样本耗尽而触发“登录超时”。

`/__history` 显示当前服务进程内的请求/响应历史，`/__history.json` 返回相同数据的 JSON 版本，包含请求、响应、数据集索引和中奖控制金额。

### 3.4 图片素材确认目录

为方便人工确认素材确实已经在本地，额外导出一份一级分类图片到：

```text
/Users/yang/work/git/sun/boyamajiang2/image/
  gif/
  jpg/
  png/
  webp/
  manifest.json
  README.md
```

该目录只用于预览和确认素材落盘。运行时客户端仍从 `local-har-client/boya-mahjong2/v2/...` 按 HAR 原始路径加载素材。

HAR 里的部分 Cocos native 图片头部不是浏览器/Finder 可直接识别的标准 PNG/JPG/WebP 头部；导出到 `image/` 时会修复预览副本的文件头，避免“图片很多打不开”。修复逻辑在 `tools/lib/local-image-export.mjs`，不会改动运行时 HAR 客户端资源。

另外，真实浏览器验证时发现 HAR 漏了一条运行时请求的 Cocos import JSON：

```text
/v2/assets/resources/import/d9/d9b088e5-f033-4038-b65a-16d30391f9b1.a372e.json
```

该文件不是图片，而是 `btn_bg02_l` 的 SpriteFrame 元数据。已从原始 `game.666789.site` 路径补齐到本地，并在 `local-har-client/boya-mahjong2/recovered-assets.json` 记录来源。补齐后客户端运行仍只访问本地服务。

## 4. 本地目录设计

所有实现产物放在当前仓库：

```text
/Users/yang/work/git/sun/boyamajiang2/
  麻将2 boya.har
  docs/specs/2026-07-09-boya-mahjong2-har-local-replay-spec.md
  tools/har/extract-boya-har.mjs
  tools/har/import-boya-ws-frames.mjs
  tools/local/boya-local-server.mjs
  tools/local/collect-local-images.mjs
  tools/lib/local-image-export.mjs
  tests/playwright/boya-mahjong2-bet.mjs
  local-har-client/boya-mahjong2/
    v2/
    manifest.json
    har-summary.json
    recovered-assets.json
  debugserver-data/boya-mahjong2/
    raw-frames.json
    000.json
    001.json
    coverage-config.yaml
  image/
    gif/
    jpg/
    png/
    webp/
    manifest.json
    README.md
  testwebgame/boya-mahjong2/
    20260709-135000/
      screenshot-enter.png
      screenshot-after-bet.png
      console.log
      network.json
      report.md
```

## 5. 实现方案

### 5.1 HAR 静态资源抽取

新增 `tools/har/extract-boya-har.mjs`：

- 读取 `麻将2 boya.har`。
- 对每个 `https://game.666789.site/v2/...` 响应：
  - 保留 URL path。
  - `response.content.encoding == "base64"` 时 base64 解码。
  - 否则按 UTF-8 写文件。
- 把入口 HTML 写到 `local-har-client/boya-mahjong2/v2/index.html`。
- 把 `/dy_buryPoint/pluck`、`/report` 这类上报接口记录到 manifest，运行时由 local server 返回 204。
- 生成 `manifest.json` 和 `har-summary.json`。
- `manifest.json` 必须记录每个本地文件的原始 `contentType`、`encoding`、`status`、`sourceUrl` 和字节大小，用于本地 server 恢复正确 MIME。

可复制命令：

```bash
node tools/har/extract-boya-har.mjs \
  --har "/Users/yang/work/git/sun/boyamajiang2/麻将2 boya.har" \
  --out "/Users/yang/work/git/sun/boyamajiang2/local-har-client/boya-mahjong2"
```

验收：

```bash
test -f "/Users/yang/work/git/sun/boyamajiang2/local-har-client/boya-mahjong2/v2/index.html"
test -f "/Users/yang/work/git/sun/boyamajiang2/local-har-client/boya-mahjong2/v2/assets/dy_mjlltwo_en/index.f99f8.js"
test -f "/Users/yang/work/git/sun/boyamajiang2/local-har-client/boya-mahjong2/manifest.json"
```

### 5.2 WebSocket frame 导入

新增 `tools/har/import-boya-ws-frames.mjs`：

- 读取 HAR 中 `._webSocketMessages`。
- base64 解码每条 frame。
- 解析 `length/cmd/flags/payload`。
- 按命令分组：
  - `40001` 写入 `000.json`。
  - 第一个 `40003` 写入 `001.json`，作为第一版普通 bet 验收数据。
  - 其他 `40003/40005/40007` 保留在 `raw-frames.json`，供后续扩展。
- `000.json/001.json` 同时保留：
  - `rawFrameBase64`
  - `cmd`
  - `connectionIndex`
  - `messageIndex`
  - `type`
  - `sourceTime`
  - `decodedJson`，如果 protobuf decode 尚不可用则为 `null`
- `raw-frames.json` 必须按 WebSocket 连接拆分：
  - `connections[0]` 保存登录/大厅连接的 send/receive 顺序。
  - `connections[1]` 保存游戏连接的 send/receive 顺序。
  - 每条连接维护自己的 replay cursor，禁止把两条连接的 frame 混成一个全局队列。

可复制命令：

```bash
node tools/har/import-boya-ws-frames.mjs \
  --har "/Users/yang/work/git/sun/boyamajiang2/麻将2 boya.har" \
  --out "/Users/yang/work/git/sun/boyamajiang2/debugserver-data/boya-mahjong2"
```

验收：

```bash
jq '.frames | length' "/Users/yang/work/git/sun/boyamajiang2/debugserver-data/boya-mahjong2/raw-frames.json"
jq '.connections | length' "/Users/yang/work/git/sun/boyamajiang2/debugserver-data/boya-mahjong2/raw-frames.json"
jq '(.connections[0].messages | length), (.connections[1].messages | length)' "/Users/yang/work/git/sun/boyamajiang2/debugserver-data/boya-mahjong2/raw-frames.json"
jq '.cmd, .type' "/Users/yang/work/git/sun/boyamajiang2/debugserver-data/boya-mahjong2/000.json"
jq '.cmd, .type' "/Users/yang/work/git/sun/boyamajiang2/debugserver-data/boya-mahjong2/001.json"
```

### 5.3 本地 HTTP + WebSocket 测试服务

新增 `tools/local/boya-local-server.mjs`：

- HTTP：
  - 静态服务 `local-har-client/boya-mahjong2/v2/`。
  - 优先按 `manifest.json` 里的 `contentType` 返回响应头；manifest 缺失时再按扩展名推断。
  - `.js` 必须返回 `application/javascript`，`.json` 必须返回 `application/json`，图片/音频/字体/bin 必须用 HAR 中记录的 MIME 或 `application/octet-stream`。
  - `/dy_buryPoint/pluck` 返回 `204`。
  - `/report` 返回 `204`。
- WebSocket：
  - 路径 `/gate/ws`。
  - 读取 `debugserver-data/boya-mahjong2/raw-frames.json`。
  - 每个新 WebSocket 连接分配一个 `connectionIndex`，按 HAR 中对应连接的 replay script 独立推进。
  - 登录/大厅连接按 `connections[0]` 的顺序回放，覆盖 `10000/10001`、`200xx`、`30000/30001` 等帧。
  - 游戏连接按 `connections[1]` 的顺序回放，覆盖 `31008/31009`、`40000/40001`、`40002/40003`、`40004/40005`、`40006/40007`。
  - 客户端发送 `40000` 后，返回同连接下一条 `40001`。
  - 客户端发送 `40002` 后，返回同连接下一条 `40003`。
  - 客户端发送 `40004` 后，返回同连接下一条 `40005`。
  - 客户端发送 `40006` 后，返回同连接下一条 `40007`。
  - 心跳 `5000/5001` 按同连接 HAR 样本响应。
  - 如果实际发送 cmd 与当前 replay cursor 不一致，先在当前连接后续 frame 中找同 cmd 的下一条 receive；找不到则记录 mismatch 并 fail fast，不静默返回错误帧。

本地 URL 中 `g` 参数改成本地 WebSocket 的 base64：

```text
ws://127.0.0.1:18082/gate/ws
d3M6Ly8xMjcuMC4wLjE6MTgwODIvZ2F0ZS93cw==
```

启动命令：

```bash
node tools/local/boya-local-server.mjs \
  --root "/Users/yang/work/git/sun/boyamajiang2/local-har-client/boya-mahjong2" \
  --frames "/Users/yang/work/git/sun/boyamajiang2/debugserver-data/boya-mahjong2/raw-frames.json" \
  --host 127.0.0.1 \
  --port 18082
```

测试 URL 默认保留 HAR 原始 token，降低客户端侧 token 形态校验风险：

```text
http://127.0.0.1:18082/v2/?token=uzuN0IxNjgzMDhGN0Y3Qjk4nPpYNzI2MTU3M0MwQzEyNEQ2NDA0RjIzQTg3NDkzN0MyMkQ4QUY4NTdEMjEwMUY4QThGMzBDNDBBRjAyMTdGREFFQzAyOUYxQkEyNEFBREI5NjFDMjVCNzJFMzMxODU0Mzk4QTBCNDE2RUU1OUE5Q0ZCMTU1RkFCQzM0Rjc0NTBENkM2QjE3RERGNTc5MDdFQTdFREFBRkMzRTgzNjk4NkRFQzNGMEUwQzg1NUM3MDlDRDc0vpEgl&deviceType=0&pcode=ZHlnd3N3&t=MTAz&ma=bWFpbmxhbmQ=&lang=CN&g=d3M6Ly8xMjcuMC4wLjE6MTgwODIvZ2F0ZS93cw==&sound=0&music=0
```

### 5.4 Playwright 验证

新增 `tests/playwright/boya-mahjong2-bet.spec.mjs`：

- 启动前检查 `http://127.0.0.1:18082/v2/` 返回 200。
- 打开测试 URL。
- 等待 Cocos canvas 出现。
- 采集 console/pageerror。
- 等待 WebSocket 看到 `40001`，判定 enter 成功。
- 点击 bet/spin 区域，或通过页面内 Cocos 节点触发 spin。
- 等待 WebSocket 看到 `40003`，判定普通 bet 成功。
- 等待画面从 enter 截图发生变化。
- 保存截图和报告。

运行命令：

```bash
npx playwright test tests/playwright/boya-mahjong2-bet.spec.mjs \
  --project=chromium \
  --reporter=line
```

截图验收文件：

```text
/Users/yang/work/git/sun/boyamajiang2/testwebgame/boya-mahjong2/20260709-135000/screenshot-enter.png
/Users/yang/work/git/sun/boyamajiang2/testwebgame/boya-mahjong2/20260709-135000/screenshot-after-bet.png
/Users/yang/work/git/sun/boyamajiang2/testwebgame/boya-mahjong2/20260709-135000/report.md
```

## 6. 分阶段验收

### Phase 0: 只做解析验证

目标：

- 确认 HAR 可解析。
- 确认 Cocos bundle 和 cmd mapping 可复现。
- 确认 frame 可按 cmd 分类。

完成标准：

```bash
jq -r '.log.entries | length' "/Users/yang/work/git/sun/boyamajiang2/麻将2 boya.har"
node tools/har/import-boya-ws-frames.mjs --har "/Users/yang/work/git/sun/boyamajiang2/麻将2 boya.har" --out "/Users/yang/work/git/sun/boyamajiang2/debugserver-data/boya-mahjong2"
jq '.summary.commands["40001"], .summary.commands["40003"]' "/Users/yang/work/git/sun/boyamajiang2/debugserver-data/boya-mahjong2/raw-frames.json"
jq '.connections | length' "/Users/yang/work/git/sun/boyamajiang2/debugserver-data/boya-mahjong2/raw-frames.json"
```

### Phase 1: 本地客户端能打开

目标：

- HAR 静态资源全部落到本地。
- `index.html` 和 Cocos assets 可以从本地 HTTP server 返回。
- 浏览器无 404 致命资源缺失。

完成标准：

```bash
curl -I "http://127.0.0.1:18082/v2/"
curl -I "http://127.0.0.1:18082/v2/assets/dy_mjlltwo_en/index.f99f8.js"
```

### Phase 2: 本地 enter 成功

目标：

- 客户端连接本地 `/gate/ws`。
- WebSocket replay server 返回 `40001`。
- 页面进入游戏主画面。

完成标准：

```text
report.md 中出现：
- wsConnected: true
- enterResponseCmd: 40001
- canvasVisible: true
- pageerror: 0
```

### Phase 3: 本地 bet 成功

目标：

- Playwright 触发普通 bet。
- WebSocket replay server 返回 `40003`。
- 截图证明 bet 后画面可见且发生变化。

完成标准：

```text
report.md 中出现：
- betRequestCmd: 40002
- betResponseCmd: 40003
- screenshotEnter: screenshot-enter.png
- screenshotAfterBet: screenshot-after-bet.png
- verdict: PASS
```

## 7. 风险与处理

- **WebSocket gzip frame 解压不完整。** 第一版 raw replay 不依赖解压；只要原始 receive frame 原样回放能驱动客户端即可。protobuf/JSON 解码作为增强项。
- **客户端登录链路依赖 token。** 第一版默认复用 HAR 原始 token 形态和本地 replay 响应；如果后续要换成 `test_player_001`，必须先用 Playwright 证明客户端仍会建立两条 WebSocket 连接并进入游戏连接。
- **上报接口阻塞。** 本地 server 对 `/dy_buryPoint/pluck` 和 `/report` 返回 204。
- **Cocos 点击坐标不稳定。** 第一版先用 Playwright 坐标点击；如果失败，再从游戏 JS 暴露的 `gameCacheData` 和 `requestNormalSpin()` 调用点加测试钩子。
- **与 slot-platform Mahjong2 名字混淆。** 当前项目数据目录使用 `boya-mahjong2`，不覆盖 `mahjong2`。

## 8. 最终交付物

实现完成后必须交付：

- 本地可运行 URL。
- bet 成功截图。
- `testwebgame/boya-mahjong2/YYYYMMDD-HHMMSS/report.md`。
- 关键命令和结果摘要。

最终给用户展示的截图路径必须是绝对路径，例如：

```markdown
![bet success](/Users/yang/work/git/sun/boyamajiang2/testwebgame/boya-mahjong2/20260709-135000/screenshot-after-bet.png)
```

## 9. 小到大中奖入口「登录认证超时」问题排查与修复 (2026-07-09)

### 9.1 现象
用户在真实浏览器打开 `http://127.0.0.1:18082/__game/winladder`，进入游戏并点击旋转后，
游戏内弹出「登录超时 / 登录认证超时，请重新登录 / 确定」。自动化 `npm test` 全绿、
`__history.json` 中 `mismatches=0`，因此不能只依赖已有单测。

### 9.2 根因（用 Playwright 真机复现定位）
- 弹窗文案来自客户端 i18n key `main.loginAuthFail`（`GameTipsDefine.SLOT_DEFAULT_ERROR`），
  由 `showDefaultErrorConfirm()` 触发，并在触发后调用 `closeChannel()` 主动断开 WebSocket。
  所以 WebSocket 关闭是**结果不是原因**（服务端 `mismatches=0`，未抛错、未主动关闭）。
- 真机复现流程：登录 hall（`10000…30001`）→ 进入 game（`31008…40001`）→ 空闲心跳
  正常（`5000/5001` 双连接都回），此时**不触发**弹窗；**只有点击旋转产生 `40002` 后**才复现。
- 该游戏是「连消/免费旋转」机制：真实 `40003` 只是初始牌面（录制里 `totalWin=0`），真正的中奖
  数据在 `40005`（`40004` 的响应）里；`40006/40007` 进入免费旋转。
- 旧的 `createGeneratedWinFrame()` **手工拼造**了一个带中奖行 + `goldToWildPos` 的 `40003`，
  与客户端状态机不符：客户端收到后会自动再发一次 `40002`、去加载一张从未被录制的中奖动画
  `…/native/1a/1ab23212-…58e9e.webp`（404），旋转结算回调无法完成，约 4–5 秒后看门狗判定
  「登录认证超时」→ `showDefaultErrorConfirm()` → `closeChannel()`。
- 对照实验：`dataset` 模式回放**真实** `40003` 帧，连续旋转多次均不弹窗，证明问题出在
  「伪造中奖帧」而非登录 / token / 心跳 / 重连。

### 9.3 修复
`tools/lib/boya-har.mjs`：winladder 模式不再凭空拼帧，改为**克隆一条真实录制的 `40003` 帧，
只覆盖金额字段**（protobuf field 15 `roundScore`、16 `totalWin`、17 `roundWin`），其余字节
（牌面 `drawResult`、`seq`、`coin`、状态等）原样保留：

- 新增 `createWinLadderFrameFromBase(baseFrame, { winAmount })`，用保序、按原始 wire 字节
  重放的方式打补丁，未出现的金额字段按字段号升序追加。
- `createWinLadderResponder` 优先用录制的真实 `40003` 作为模板；只有当录制里没有可解析的
  `40003`（如单测占位帧）时才回退到 `createGeneratedWinFrame`。
- 因为不再走中奖动画/连消路径，404 webp 也随之消失。

### 9.4 验证证据（Playwright 真机，headless + swiftshader）
- winladder：进入游戏 → 连续旋转覆盖整条阶梯，历史记录金额
  `[400,1200,2400,6000,12000,20000,400]` 循环；随后空闲跑满 83s、覆盖 2 个心跳周期；
  全程 `clientClose=0`、`mismatches=0`、`serverWsClosed=0`、HTTP 4xx=0，**不再出现登录认证超时**；
  客户端画面显示「总赢取 4.00 … 200.00」（400→20000 的 /100 显示）。
- dataset：进入游戏后连续 9 次 `40002/40003` bet，`clientClose=0`、`mismatches=0`，不弹窗。
- `npm test` 16/16 通过（新增 2 条回归单测：金额字段覆盖 + 只克隆真实帧）；
  `node --check` 两个文件通过；`git diff --check` 无告警。

## 10. winladder 盘面不变化问题：调查与实现方案 (2026-07-09，✅ 已实现)

> **实现状态**：已按 10.4 落地——`collectRealBoards()` 收集 27 套真实盘面去重，winladder 每把
> `boards[spinIndex % 27]` 轮换盘面 + `WIN_LADDER_AMOUNTS[spinIndex % 6]` 金额阶梯；历史记录新增
> `boardIndex`。真机验证：连续旋转盘面逐把不同（board 0/1/2/…），金额 4.00→…→200.00，`clientClose=0`。


### 10.1 现象
9.3 的修复解决了「登录认证超时」，但引入了新问题：winladder 模式**每次旋转落定的麻将盘面完全一样**。
旋转动画照播，但结果牌面每把都相同，只有右下角中奖金额在按阶梯变化。对 bet 测试来说太假，不可接受。

### 10.2 根因
- `createWinLadderResponder` 里 `findRecordedBetFrame()` 用 `.find()` 取**第一条** `40003`（即 conn1 的
  `messageIndex=7`），之后每把都克隆同一条帧。
- `createWinLadderFrameFromBase()` 只覆盖金额字段（15/16/17），从不改动盘面字段，所以 `drawResult`（5×5=25 张）
  恒定不变。

### 10.3 可用数据（已核实）
录制的 conn1 里存在多套**真实、客户端已验证过**的盘面：
- `40003`（基础旋转）4 帧，各自盘面不同。
- `40005`（连消/免费旋转步骤）23 帧，各自盘面不同。
- 去重后共 **27 套不同的 25 张牌盘面**。

每帧的盘面由 3 个 length-delimited 字段构成，且 `40003`/`40005` 都齐全：
- `f8` = `drawResult` 主网格（25 张，25B）
- `f9` = `topResult` 顶行（5 张，5B）
- `f10` = `buttomResult` 底行（5 张，5B）

`40005` 额外带免费旋转字段（`f1`/`f2` 状态、`f21` 剩余次数、有时 `f14` 转 wild 位置）——这些**绝不能**搬进
基础 `40003`，否则会重新触发 9.2 里那条「进入免费旋转 / 加载中奖动画 404 / 看门狗超时」的老路。

### 10.4 实现方案：盘面移植 + 金额覆盖
核心思路：**用一条安全的真实 `40003` 作为结构外壳，每把只把 `f8/f9/f10` 三个盘面字段换成盘面池里的下一套，
再覆盖金额字段。** 只搬盘面牌面，不搬免费旋转/wild 字段，因此不会触发免费旋转动画。

具体改动（`tools/lib/boya-har.mjs`）：

1. 新增 `collectRealBoards(rawFrames, connectionIndex)`：
   - 遍历该连接（回退到全部 frames）所有 `type==="receive"` 且 `cmd ∈ {40003, 40005}` 的帧。
   - 解析内层 submessage，抽取 `f8/f9/f10` 三个字段的**原始 wire 字节**（tag+len+value 整段）。
   - 只保留三个字段齐全、`drawResult` 为 25 张的帧；按 `drawResult` 去重，保持出现顺序（确定性）。
   - 返回 `[{ f8:Buffer, f9:Buffer, f10:Buffer }, ...]`（预期 27 套）。

2. 扩展帧打补丁函数为通用版 `rebuildRotateInner(inner, { varintOverrides, rawFieldOverrides })`：
   - 按原顺序遍历基础帧字段；命中 `varintOverrides`（15/16/17 金额）→ 重新编码 varint；
     命中 `rawFieldOverrides`（8/9/10 盘面）→ 用池里那套的原始字节替换；其余原样保留。
   - 未出现的金额字段按字段号升序追加（延续 9.3 的做法）。
   - `createWinLadderFrameFromBase(baseFrame, { winAmount, board })`：`board` 缺省时退化为纯金额覆盖
     （保持向后兼容与现有单测）。

3. 改造 `createWinLadderResponder`：
   - 构造时预计算：安全外壳 `baseBetFrame`（真实 `40003`）+ 盘面池 `boards = collectRealBoards(...)`。
   - 每次 `40002`：`board = boards[spinIndex % boards.length]`，`amount = WIN_LADDER_AMOUNTS[spinIndex % 6]`，
     返回 `createWinLadderFrameFromBase(baseBetFrame, { winAmount: amount, board })`。
   - 盘面每把都换（周期 27），金额每把按阶梯（周期 6），组合周期 LCM(27,6)=54。
   - 回退：`baseBetFrame` 或盘面池为空 / 基础帧不可解析时（如单测占位帧）→ 退回 `createGeneratedWinFrame`。

4. 历史记录：`__history` 已记 `winAmount`；可选再记 `boardIndex` 便于核对盘面轮换。

### 10.5 验证方案（必须真机复现）
- Playwright 真机：进游戏 → 连续旋转 ≥8 把，逐把截图，断言**相邻两把 `drawResult`/画面不同**（截图像素或
  从页面读取 `drawResult`），且全程无「登录认证超时」、`clientClose=0`、`mismatches=0`、HTTP 4xx=0。
- 空闲跑满 ≥70s 覆盖 2 个心跳周期，仍不弹窗。
- dataset、replay 模式回归：不受影响，仍能进游戏 + bet。
- 新增单测：
  - `collectRealBoards` 从含多套盘面的 fixture 返回去重后的多套盘面。
  - winladder 连续多把返回的 `drawResult` 逐把变化，且都等于某条真实录制盘面。
  - 金额仍按 `[400,1200,2400,6000,12000,20000]` 循环。
- `npm test` 全绿、`node --check` ×2、`git diff --check` 无告警。

### 10.6 风险与处理
- **客户端会不会校验「盘面 vs 中奖行」一致性？** 9.3 已证明客户端接受「盘面无匹配行但 `totalWin>0`」而不报错、
  正常显示金额，说明未做强校验；移植的是真实录制盘面，安全性只增不减。实现后仍以真机复现为准。
- **误搬免费旋转字段。** 严格只覆盖 `f8/f9/f10`，代码里对可替换字段做白名单，杜绝带入 `f1/f2/f14/f20/f21/f22`。
- **盘面池确定性。** 按出现顺序去重，避免用 `Set` 迭代顺序造成不可复现的轮换。
- **盘面数量有限（27 套）。** 对 bet 测试足够；若日后要“无限不重复”，可在真实盘面基础上做置换扰动，属增强项，
  非本次目标。

## 11. 对齐 slot-platform Unity Mahjong2「设计盘面+中奖+级联」控制能力（调查 + 方案，待实现）

目标：参考 `/Users/yang/work/git/slot-platform` 的 Unity/Cocos Mahjong2 本地控制机制（数据集把**中奖金额和盘面
都设计好**、按**中奖金额小到大**驱动客户端、包含**中奖盘面掉落/级联**），在当前 HAR 还原的 boya 客户端上做出
等价的「本地客户端可控」体验。

### 11.1 slot-platform 侧机制（调查结论）
两个游戏其实是**同一款 PG《Mahjong Ways 2 / 麻将胜利2》引擎**，只是接入不同后端。

- **场景定义（人工设计）**：`slot-server/scripts/scenario-definitions/mahjong2.yaml`（442 行，26+ 场景）。
  每个 session 手工设计：
  - `initialBoard`：5 列 × 7 行 = 35 格盘面（`guize.md`：可见 23 格、隐藏 12 格；`10`/`9` 是填充/隐藏位）。
  - `outputType`：`miss` / `win_low` / `win_mid` / `win_high` / `bigwin` / `megawin` / `cascade` /
    `cascade-bigwin` / `freespin` / `ways_wild_sub` …——**中奖档位从小到大**就是靠这套 outputType 排布。
  - `sessionType`：`NORMAL_SPIN`（单次）/ `CASCADE_CHAIN`（级联链，即“盘面掉了”）/ `FREE_TRIGGER`（免费旋转）。
- **符号表（`guize.md`）**：`0`=Wild(發/金元宝)，`1`=Scatter(胡，3+ 触发免费，不参与消除)，`2-5`=高价值，
  `6-10`=低价值；金色符号 `ssb` 只在中间 3 列、消除时变 Wild。
- **编译流程**：`slot-server/scripts/generate-debugserver-datasets.py` 把设计好的 `initialBoard` 发给**真实运行的
  `mahjong2-service`（Java 引擎，端口 8082）的 generate-session 接口**，引擎按真实数学算出**完整级联链 + 中奖**，
  脚本校验产物符合 `outputType`（例如非 FREE_TRIGGER 不能漂进免费旋转），再存成
  `debugserver-data/mahjong2/0NN.json`。即：**设计初始盘面 → 引擎确定性产出级联与金额**，不是纯手填结果。
- **运行数据集格式**：`{ type, data:[ step... ] }`。每个 step ≈ 一次级联/掉落帧，关键字段：
  - `orl` / `rl`：掉落前/后 35 格盘面；`wp`（每符号中奖位置）、`lw`（每符号线赢）、`ptbr`（本步要消除的位置）；
  - `tw`（本链累计赢）、`ctw`/`aw`（累计）、`bl`（余额）；`st`/`nst`（状态，`4`=cascade，`21/22`=free）；
  - `ss`/`ssb`（Scatter/金符位置）、`goldToWild`、`symbol`、`wm`（倍数）。

### 11.2 boya HAR 侧协议（本 spec 实测解码，见 conn1 全序列）
boya 走 protobuf-over-WebSocket，一次完整“下注+免费旋转”序列如下（`40004/40005` 就是级联/掉落步）：

| cmd | 含义 | 对应 slot-platform |
|-----|------|--------------------|
| `40002`→`40003` | 基础旋转请求/结果（初始盘面，`roundScore=-bet`，通常无赢） | `sessionType: NORMAL_SPIN`，`data[0]` |
| `40006`→`40007` | 触发/购买免费游戏（`bFree=true`, `freeRemain=10`） | `FREE_TRIGGER` 入口 |
| `40004`→`40005` | **级联/免费步（“盘面掉了”）**：`tw` 逐步累加、`lines`/`goldToWildPos`、`freeRemain` 递减、`status=1` | `CASCADE_CHAIN` 的每个 `data[i]` |
| `5000`/`5001` | 心跳（穿插其间） | — |

实测证据：录制里一段免费旋转链的 `totalWin` 逐步累加 `0→480→3280→14560→…→560`，`freeRemain` 从 10 递减到 1，
每步 `drawResult` 不同（真实掉落后的新盘面）。**注意：录制里的级联只出现在免费旋转内**（基础 `40003` 都是即时未中）。

**MsgRotate 字段 ↔ slot-platform 字段对照**：
`drawResult(25)+topResult(5)+buttomResult(5)=35` ↔ `rl/orl(35)`；`totalWin(16)` ↔ `tw`；`roundWin(17)`/`roundScore(15)` ↔ `ctw/aw`；
`lines(11)` ↔ `wp/lw`；`status(2)/originalStatus(1)` ↔ `st/nst`；`goldToWildPos(14)` ↔ `goldToWild/ssb`；`freeRemainCount(21)` ↔ 免费剩余。

### 11.3 两者关系与差异
- **相同**：同一 Mahjong Ways 2 引擎；盘面同为 5×7=35；Ways 全路径 + 级联掉落 + 金符变 Wild + 3 胡触发免费。
- **差异**：boya=protobuf/WS（cmd 40002–40007），slot-platform=JSON dataset+Java 引擎；**符号 ID 编号体系不同**
  （boya 用 `101`=胡/scatter、`11/13/15/17/19`=高、`3–9`=低、`20`/`14/16/18` 等；slot-platform 用 `0–10`），
  需要一张**符号映射表**才能互转。

### 11.4 目标能力（对齐 Unity）
在 boya 本地服务上支持：**设计「盘面 + 中奖金额 + 级联步」的数据集，按小到大档位回放，客户端真实播放盘面掉落 +
递增中奖**，且不触发登录认证超时（§9 约束）。

### 11.5 实现方案（分期，含推荐）

**方案 A —— 真实级联帧重组（推荐，风险最低）**
不自研游戏数学，直接利用录制里那段**真实、客户端已验证过**的免费旋转级联序列（`40006/40007` +
一长串 `40004/40005`）。做法：
1. 本地服务在客户端进入免费旋转（点“购买免费游戏”触发 `40006`，或回放 `40007`）后，**按序回放录制的 `40005`
   级联步**——客户端会真实播放“盘面掉落 + 中奖数字递增”。
2. 通过**截取/重排**这段级联，构造“小到大”的中奖档位：miss（无赢步）、small（480 档）、mid（3280 档）、
   big（14560 档），必要时对每步 `totalWin/roundWin`（字段 16/17）做与 §9.3 相同的“只改金额”微调，逼近
   `400→…→20000` 阶梯。盘面天然每步不同（真实掉落盘面）。
3. 好处：级联动画、金符变 Wild、免费旋转状态机全部走真实帧，安全性最高。

**方案 B —— scenario 数据集层（中期）**
在 boya 本地服务引入一个对齐 slot-platform 概念的 `scenario JSON`（`sessionType`/`outputType`/`initialBoard`），
本地服务据此**组装 boya 帧序列**：先支持“用真实帧重组”，再逐步支持“由设计盘面+目标中奖程序化改写帧”。

**方案 C —— 移植 slot-platform 设计集（增强，工程量大）**
建立 boya↔slot-platform **符号映射表 + 盘面布局映射**，把 slot-platform 26 个已设计场景（含级联链、免费旋转）
翻译成 boya protobuf 帧，完全复用 Unity 侧的设计集。需先逆向 boya 符号语义并逐场景真机校验。

推荐落地顺序：**先 A（能立刻让客户端展示“盘面掉落 + 小到大中奖”），再 B（可维护的场景层），C 视需要再做。**

> **实现状态（Phase A ✅ 已落地）**：`createFreeSpinReplayer()` 预取录制的 `40007` 触发帧 +
> 有序 `40005` 级联帧；winladder / dataset 两模式显式处理 `40006`→回放 40007、`40004`→回放下一
> 级联步（耗尽后钳到最后一步，不抛错），用独立游标，不影响基础旋转的盘面/金额阶梯。真机验证流程：
> 基础旋转（小到大 + 换盘面）→ 点“购买免费游戏 320.00”→“购买”→ `40006/40007` 进入免费旋转 →
> `40004/40005` 逐步级联，画面显示“赢得免费旋转 10”“总赢取 145.60”“剩余免费旋转次数 7”、倍数
> x2/x4/x6/x10、盘面逐步掉落；`clientClose=0`、`mismatches=0`、HTTP 4xx=0，无认证超时。
> **Phase B/C（scenario 层、符号映射、移植 slot-platform 设计集）仍为后续增强。**

### 11.6 关键未知与风险
- **boya 符号 ID 语义未知**：`101/11/13/15/17/19/20/3–9/14/16/18` 各代表什么（Wild/Scatter/高/低）需逆向；
  程序化生成（B/C）前必须先建映射表。
- **级联判定在 boya 服务端**：哪些位置消除、如何重力掉落、金符变 Wild——本地无源码。因此**程序化生成级联很难**，
  A 方案“重组真实帧”是绕开该难点的关键。
- **基础游戏无录制级联**：录制里级联只在免费旋转内；要在**基础旋转**里展示掉落，需要能构造合法的基础中奖帧并让
  客户端请求 `40004`（§9.2 证明伪造基础中奖帧会让客户端自动重转并触发超时）——高风险，非首期目标。
- **免费旋转触发链必须完整**：`40006/40007`→`40004/40005`→结束态缺一不可，否则客户端状态机卡死（§9.2）。
- **客户端一致性校验强度**：级联/免费步可能比基础帧校验更严，必须每步真机验证。

### 11.7 验证方案
- Playwright 真机：触发免费旋转 → 逐步截图，肉眼确认**盘面逐步掉落 + 中奖数字递增**；断言无“登录认证超时”、
  `clientClose=0`、`mismatches=0`、HTTP 4xx=0；级联步数与 `tw` 序列符合设计档位。
- 单测：场景→帧序列组装、金额档位小到大、盘面逐步变化、免费旋转触发链完整。
- `npm test` / `node --check` ×2 / `git diff --check` 全绿。

### 11.8 参考文件（slot-platform）
- 场景设计：`slot-server/scripts/scenario-definitions/mahjong2.yaml`
- 编译脚本：`slot-server/scripts/generate-debugserver-datasets.py`（调真实服务 generate-session）
- 运行数据集：`debugserver-data/mahjong2/000.json … 0NN.json`
- 规则/符号表：`slot-server/server-game/mahjong2-service/guize.md`
- Cocos 对齐报告：`slot-server/docs/cocos-mahjong2-alignment-report.md`
- Unity 客户端：`slot-client/MahjongWays2unitylocal/`

## 12. winladder 盘面-路径-奖金一致性修复（2026-07-09 实施）

### 12.1 问题结论
旧 winladder 把真实输盘 `40003` 只改成阶梯金额，`lines` 仍为空，导致客户端显示金额但没有可高亮的中奖路径。
本轮先尝试了“真实 40005 中奖帧改造成基础 40003”的两种方案：

- **去免费态后塞进 40003**：盘面、`lines`、`roundWin` 可以做到自洽，但真机 4-5 秒后弹“登录认证超时”。
- **保留免费态只把 cmd 改成 40003**：客户端会继续发 `40004`，但仍会在基础旋转入口卡住并超时。

因此，当前 HAR 客户端里**基础 `40003` 带中奖 lines 不是稳定通路**。最终采用 §11 方案 A：普通基础旋转保持真实安全帧；
小到大奖励通过已验证稳定的“购买免费游戏”链路 `40006 -> 40007 -> 40004 -> 40005` 承载。

### 12.2 最终实现
- `tools/lib/boya-har.mjs`
  - 新增 `createWinLadderFreeCascadeFrame()`：只缩放真实 `40005` 中奖帧的 `lines[].score`、`roundWin(17)`、
    `totalWin(16)`、`freeTotalWin(20)`；盘面字段 `drawResult/topResult/buttomResult` 和中奖 `iconId/axleId/lineNum`
    保持录制原样。
  - `createFreeSpinReplayer(..., { ladderAmounts })` 在 winladder 模式下把录制中奖级联按
    `[400, 1200, 2400, 6000, 12000, 20000]` 缩放；无中奖过渡帧保持原样。
  - winladder 的 `40002` 返回真实基础输盘 `40003`，避免再制造“有金额无路径”的基础假赢。
  - winladder 的 `40006/40004` 走免费态阶梯中奖，history 记录 `winAmount/originalRoundWin`。
- 补齐缺失本地资源：
  - `local-har-client/boya-mahjong2/v2/assets/resources/native/1a/1ab23212-158e-472d-9ecd-eedab910efba.58e9e.webp`
  - HAR 内没有该二进制；用原线上精确 URL 拉回，避免真实中奖动画请求该 webp 时 404。
- `tests/unit/boya-har.test.mjs`
  - 新增/调整单测：断言 winladder 免费级联 40005 的 `roundWin == sum(lines[].score)`，中奖 `iconId`
    存在于可见盘面，且前 6 个中奖级联按 400→1200→2400→6000→12000→20000 输出。
- `tests/playwright/boya-mahjong2-winladder-paths.mjs`
  - 真机流程改为：进入 `/__game/winladder` → 开始 → 点击“购买免费游戏” → 绿色“购买” →
    收集 6 个带 `lines` 的 `40005` 中奖级联截图 → 等 70 秒心跳。

### 12.3 真机验证证据
最终验证目录：
`testwebgame/boya-mahjong2/winladder-buyfree-final-20260709-162718/`

Playwright 报告：
- verdict: `PASS`
- `httpErrors=0`
- `clientCloses=0`
- `send40006/receive40007=1/1`
- `send40004/receive40005=23/23`
- `send5000/receive5001=10/10`
- 6 个中奖级联：
  - `400 -> lineSum 400`
  - `1200 -> lineSum 1200`
  - `2400 -> lineSum 2400`
  - `6000 -> lineSum 6000`
  - `12000 -> lineSum 12000`
  - `20000 -> lineSum 20000`

截图要点：
- `spin-06-settled.png`：显示“赢取 200.00”，盘面中奖路径高亮，`roundWin=20000`、`lineSum=20000`。
- `after-heartbeat-wait.png`：70 秒后仍在游戏内，无“登录/认证超时”弹窗。

### 12.4 使用方式
测试地址仍是：
`http://127.0.0.1:18082/__game/winladder`

进入后点击：
1. “开始”
2. “购买免费游戏”
3. 绿色“购买”

之后客户端会走本地服务控制的免费级联中奖阶梯。历史记录：
`http://127.0.0.1:18082/__history.json`

## 13. 普通小奖阶梯：slot-platform 盘面驱动基础 40003（2026-07-09 实施）

### 13.1 问题结论
用户明确要求“普通小奖励慢慢到大奖励”，不能用免费游戏 / BigWin / MegaWin 截图证明。因此新增独立
`normalwin` 模式，用普通旋转 `40002 -> 40003` 展示小奖阶梯：

```text
100 -> 200 -> 300 -> 500 -> 600 -> 800
显示金额：1.00 -> 2.00 -> 3.00 -> 5.00 -> 6.00 -> 8.00
```

旧的失败点是基础 `40003` 直接硬塞中奖 lines 后，客户端会在数秒后认证超时。2026-07-10 对不同路径做真机复核后，最终定位到四个必要条件：

- `roundScore(15)` 必须按净分 `win - bet` 写入 uint64 varint。真实 HAR 输局用 `2^64 - 400` 表示 `-400`；
  因此 100/200/300 小奖必须分别编码为 `-300/-200/-100`，不能写成 0。
- 普通中奖动画会懒加载额外音频资源。HAR 没收全的 import/native mp3 必须补齐到本地，否则会出现 HTTP 404。
- 三轴 Ways 的 `lines[].axleId` 是最后中奖轴的 0-based 索引，必须为 `2`；写成 `3` 等于声明四轴中奖，与三轴盘面不一致。
- 基础游戏中奖后的消除子轮仍走 `40002 -> 40003`，不是免费游戏的 `40004 -> 40005`。首个中奖 `40003`
  后必须返回一个重力兼容的终止 `40003`：`lines=[]`、`roundWin=0`、`totalWin` 保留本轮奖金，并保持所有未消除符号
  按列下落顺序不变。把同一个中奖首盘重复返回，会让非顶行路径在下落校验时关闭连接并显示“登录认证超时”。

同时，盘面不能只保证目标 `iconId` 成路，还要清除其他未声明的三轴 Ways；否则客户端高亮、`lines` 和盘面规则仍不完全一致。

### 13.2 实现
- `tools/lib/boya-har.mjs`
  - 新增 `NORMAL_WIN_AMOUNTS = [100, 200, 300, 500, 600, 800]`。
  - 从 `/Users/yang/work/git/slot-platform/slot-server/scripts/scenario-definitions/mahjong2.yaml` 选取普通 3 列 Ways
    小奖盘面：`mj2-04/06/07/09/10/11`。
  - 建立 slot-platform -> Boya 符号映射：
    `10->3, 8->7, 7->9, 5->13, 4->15, 3->17`。
  - `slotPlatformBoardToBoyaBoard()` 把 slot-platform 5 列 x 7 行盘面转成 Boya 的
    `drawResult(25)+topResult(5)+buttomResult(5)`。
  - `createNormalWinFrameFromSlotScenario()` 克隆真实 HAR `40003` 外壳，只替换盘面、lines、金额、净分和余额；
    移除免费态字段，保持普通旋转协议。
  - `placeSingleWaysPath()` 先移除目标符号的额外 wild/同类匹配，再清理其他未声明三轴 Ways，确保首盘只有
    `lines.iconId` 对应的一条中奖路线。
  - `createNormalWinSettleFrameFromSlotScenario()` 根据首盘实际消除位置生成下落终止盘：未消除符号顺序保持不变，
    新符号从列顶补入，终止盘无任何三轴 Ways。
- `tools/local/boya-local-server.mjs`
  - 新增 `/__game/normalwin` 顺序入口。
  - 新增 `/__game/normalwin-1..6` 固定档位入口，方便逐条测试不同中奖路线。
  - 每档使用两步状态机：第一次 `40002` 返回中奖高亮帧，第二次客户端子轮 `40002` 返回终止帧；终止后等待人工下一次旋转。
- `tests/playwright/boya-mahjong2-normalwin-paths.mjs`
  - 默认每个档位单独开新页面验证，避免连续普通赢时客户端内部自动旋转状态污染下一档截图。
  - 监听 WebSocket、HTTP、console、pageerror、client close；保存 highlight/settled/after-wait 截图。
  - 同时断言首盘只有声明 Ways、终止盘无 Ways、每档恰好两个 `40003`、服务端 `mismatches=0`。

补齐的普通中奖懒加载资源：

```text
/v2/assets/dy_mjlltwo_en/import/08/0800587f-95a0-4301-8118-e007d5b2432b.dfe7f.json
/v2/assets/dy_mjlltwo_en/native/08/0800587f-95a0-4301-8118-e007d5b2432b.02a92.mp3
/v2/assets/dy_mjlltwo_en/import/d7/d783060f-127f-453d-af49-efc3b6d1dc44.e8f47.json
/v2/assets/dy_mjlltwo_en/native/d7/d783060f-127f-453d-af49-efc3b6d1dc44.4266d.mp3
/v2/assets/dy_mjlltwo_en/import/6b/6b5b62c5-a5c1-483d-bb27-64debe73b57b.79abb.json
/v2/assets/dy_mjlltwo_en/native/6b/6b5b62c5-a5c1-483d-bb27-64debe73b57b.23718.mp3
/v2/assets/dy_mjlltwo_en/import/6c/6c8f62b8-fb2a-44ef-a0ab-3ee7dd0120d8.56416.json
/v2/assets/dy_mjlltwo_en/native/6c/6c8f62b8-fb2a-44ef-a0ab-3ee7dd0120d8.760ad.mp3
/v2/assets/dy_mjlltwo_en/import/88/88d452d4-fd1f-43b2-8f22-af95dc42bf48.f40a7.json
/v2/assets/dy_mjlltwo_en/native/88/88d452d4-fd1f-43b2-8f22-af95dc42bf48.60fdc.mp3
```

### 13.3 真机验证证据
最终验证目录：
`testwebgame/boya-mahjong2/normalwin-final-20260710-093340/`

Playwright 报告：
- verdict: `PASS`
- `httpErrors=0`
- `pageErrors=0`
- `clientCloses=0`
- `serverMismatches=0`
- `send40006/receive40007=0/0`
- `send40004/receive40005=0/0`
- `send40002/receive40003=12/12`（每档一个中奖首帧 + 一个下落终止帧）
- `receive5001=24`，六档各等待两个以上服务端心跳周期，连接保持正常。
- 6 个普通小奖：
  - `100 -> iconId 3 -> rows 0/0/0 -> lineSum 100 -> settleLines 0`
  - `200 -> iconId 7 -> rows 1/2/3 -> lineSum 200 -> settleLines 0`
  - `300 -> iconId 9 -> rows 3/1/4 -> lineSum 300 -> settleLines 0`
  - `500 -> iconId 13 -> rows 2/4/1 -> lineSum 500 -> settleLines 0`
  - `600 -> iconId 15 -> rows 3/0/2 -> lineSum 600 -> settleLines 0`
  - `800 -> iconId 17 -> rows 1/3/0 -> lineSum 800 -> settleLines 0`

每档报告均为：`declaredWaysOnly=true`、`targetPathMatches=true`、`normalResponseCount=2`、`settleBoardWays=[]`。

免费回放回归在独立端口完成，证据目录：
`testwebgame/boya-mahjong2/winladder-regression-20260710-093930/`。报告 verdict 为 `PASS`，
`send40006/receive40007=1/1`、`send40004/receive40005=18/18`、`httpErrors=0`、`clientCloses=0`，
确认 §11 Phase A 未被 normalwin 状态机改动破坏。

人工截图检查：
- `normalwin-highlight-contact.png`：六宫格全部截在发光高亮阶段，显示 1.00 / 2.00 / 3.00 / 5.00 / 6.00 / 8.00。
- 六档高亮路线分别对应报告中的 `iconId + targetRows`，不是同一条顶行路线。
- `win-00100-after-wait.png` 到 `win-00800-after-wait.png` 均已完成下落结算，画面无“登录认证超时”遮罩。

### 13.4 使用方式
顺序入口：
`http://127.0.0.1:18082/__game/normalwin`

固定档位入口：

```text
http://127.0.0.1:18082/__game/normalwin-1  # 1.00
http://127.0.0.1:18082/__game/normalwin-2  # 2.00
http://127.0.0.1:18082/__game/normalwin-3  # 3.00
http://127.0.0.1:18082/__game/normalwin-4  # 5.00
http://127.0.0.1:18082/__game/normalwin-5  # 6.00
http://127.0.0.1:18082/__game/normalwin-6  # 8.00
```

## 14. 本地规则服、用户隔离与 38 场景扩展（2026-07-10）

HAR 回放之后的独立规则服、概率后台、SQLite 历史、本地 token 用户和场景矩阵已落地。完整合同、最终报告与排障经验统一记录在：

```text
docs/specs/2026-07-10-boya-mahjong2-local-controlled-server-admin-spec.md
docs/specs/2026-07-10-boya-mahjong2-local-users-scenario-coverage-spec.md
```

本轮新增的重要协议边界：

- 外部 `/__game/live?token=user1` 的 token 是本地用户；同源全屏入口壳保持该地址不变，内层 Cocos 仅保留 HAR 格式兼容值，本地用户通过 WS `userToken` 传递。
- 普通 `40003` 盘面最多 2 个胡。普通盘误放 3 个胡会启动客户端免费触发动画并卡住后续子轮；3+ 胡必须走购买 `40006/40007`。
- 确定性场景共 38 个，其中路线/级联/Wild 场景 28 个；每个中奖步骤都重新计算盘面 Ways、`lines`、金额和路径位置。
- `user1`、`user2`、`usergame1` 已真机验证独立余额、历史、RTP 和跨用户 404；游戏内历史真实走 `20047/20048`、`20051/20052`。
- 高亮截图不能统一等待 2700 ms：首次中奖、后续级联、2 个胡期待动画必须使用不同的三时点采样，具体见用户与场景覆盖 spec 第 10--11 节。
- 真实 HAR 的 `topResult` 属于触发本次消除的当前中奖帧；把补牌写到下一帧会造成可视盘面与 `lines` 错位。
- 测试、live、后台和历史页的最终运行时审计只有 `127.0.0.1:18082`，外部 URL、HTTP 错误和请求失败均为 0。

## 15. 客户端按钮、本地规则、回放与连接角色审计（2026-07-10）

### 15.1 审计结论

对当前 Boya Cocos 客户端的可操作入口做了逐项真机检查，以下功能均已接入当前本地环境：

| 入口 | 本地实现与验证依据 |
| --- | --- |
| 普通旋转 / 空格旋转 | 空格键真实发出 `40002`，本地服务返回 `40003`；设置关闭空格旋转后写入本地存储 |
| 投注加减 | 客户端倍率从 `20` 切到 `100`，下一次 `40003` 同步返回 `betMulti=100`、`betCoin=2000`，再切回 `20` |
| 极速 | `gameConfigData.isTurbo` 真机验证 `false -> true -> false` |
| 声音 | 音乐和音效状态同步切换并可恢复，设置页写入本地存储 |
| 自动旋转 | 10 次自然结束和旋转中点击中央按钮停止均已验证；停止后 SQLite 局数不再增长 |
| 规则 | `/v2/help/dy_mjlltwo/` 由本地服务渲染，内容使用当前引擎赔率、2000 Ways、消除倍数和 80 倍购买费用 |
| 历史 / 详情 | 游戏内真实走 `20047 -> 20048`、`20051 -> 20052`，按本地 token 从 SQLite 读取 |
| 设置 / 语言 | 音乐、音效、简介、极速、空格键均可保存；语言选择懒加载素材已本地补齐，简体切繁体真机通过 |
| 回放 | 列表走 `20049 -> 20050`，数据走 `70000 -> 70001`；本地 SQLite 盘面、lines、金额被重建成原客户端回放帧 |
| 大厅 | 原按钮实际打开活动 WebView；现由 `/v2/help/dy_activity/` 提供本地入口页，并用 `20152 -> 20153` 完成原客户端握手 |
| 退出 | 本地退出确认 prefab 和按钮依赖已补齐；弹窗、取消及返回游戏均无 404 |

完整回归脚本：

```text
tests/playwright/boya-mahjong2-button-audit.mjs
```

最终证据目录：

```text
testwebgame/boya-mahjong2/button-audit-final-20260710/
```

最终报告 `verdict=PASS`，并且：

```text
HTTP >= 400                0
request failures           0
external HTTP requests     0
page errors                0
unexpected client closes   0
auth timeout               false
server mismatches          0
```

### 15.2 本地规则页与大厅页

`tools/local/server/game-help.mjs` 现在提供两个完全同源页面：

- `renderBoyaGameHelp()`：当前规则服使用的 Ways、赔率、普通/免费消除倍数、胡牌次数和购买费用。
- `renderBoyaLocalHub()`：测试数据、本地概率、控制后台和服务端历史四个入口。

大厅页不能只返回 HTTP 200。原 `SlotActivity` 在加载后等待页面发送 JSON `get` 消息；5 秒内没有收到就会显示“打开活动页面失败”并关闭 WebView。本地页因此发送：

```json
{"type":"get","tag":"Msg_GetActivityLobbyGameInfoReq","args":{"language":true}}
```

大厅通道本地返回压缩 protobuf `20153`，页面保持显示；页面自己的关闭按钮再发送 `onCloseClick`，恢复游戏画面。真机同时确认页面停留超过 5 秒、可关闭、无外部请求。

### 15.3 SQLite 回放协议

`tools/local/server/hall-history-responder.mjs` 增加了原生回放链：

- `20049`：读取当前 token 的本地中奖基础局和购买免费局，返回 `20050` 列表。
- `70000`：解析 `playid=local-<roundId>`，并校验 round 所属 token。
- `70001`：把 SQLite 的 board、top/bottom、lines、分数、倍数和免费态重建为 gzip+base64 的 `40003/40007/40005` 帧。
- 基础中奖回放使用 `40003`；购买局依次回放 `40007` 触发盘和对应 `40005` 免费步骤。
- 回放完成后客户端主动关闭 replay WebSocket 属于原状态机行为，不计为异常断连。

真机已验证中奖高亮、金额及终局“再次观看/复制链接”界面，并在回放结束后用同一个 token 重新进入普通游戏。

### 15.4 回放后重进的通道错位修复

旧服务按同一 token 的 WebSocket 建立次数交替分配 `connectionIndex=0/1`。正常页面恰好建立“大厅 + 游戏”两个连接，但回放 WebView 会额外建立一个仅发送 `70000` 的连接；之后同 token 重进时，第一个 `10000` 会被误分到游戏通道，出现：

```text
No replay response for cmd 10000 on connection 1
```

现改为在 `live/test` 连接收到首个二进制帧后判定角色：

- `10000/20047/20049/20152/70000` 等大厅命令 -> `connectionIndex=0`
- `31008/31010/40000/40002/40004/40006` 等游戏命令 -> `connectionIndex=1`

角色分类位于 `tools/local/server/connection-role.mjs`。回放连接不再污染后续连接顺序；同 token 回放完成后重进已纳入 Playwright 门禁。

### 15.5 懒加载素材经验

HAR 只记录用户当时触发过的请求。规则、回放结束、语言选择和退出确认等入口属于运行时懒加载，必须逐按钮真机点击才能发现缺口。本轮补齐并增加单测门禁的关键共享素材包括：

```text
assets/resources/import/0a/0a4b4a236.2d13e.json
assets/resources/import/02/02b7b0d1c.f9004.json
assets/resources/import/79/791d6f4c-58f1-40f3-b49a-ae3291719814.5c121.json
assets/resources/import/99/991d1741-2dd3-4b0d-90f8-f8dfc2706b73.4632e.json
```

同时补齐语言选择引用的 `assets/dy_mjlltwo_en/import/*` JSON 和 `native/1c/1c0b3a350.1b891.webp`。这些文件仅在恢复阶段从原精确资源 URL 取回；当前运行时全部从 `127.0.0.1:18082` 读取，不依赖线上 CDN。

### 15.6 测试统计边界

- `40002` 不等于“用户完成一局”：基础中奖消除子轮仍会继续发送 `40002`。自动旋转次数和停止行为必须以 SQLite 新增的完整 round 数、`gameConfigData.isAuto/autoTimes` 和静默期共同判断。
- 按坐标点一次不等于按钮生效：Cocos 在转轴动画或界面切换期间可能吞掉点击。Playwright 必须重试到目标协议帧、目标节点或目标状态出现。
- 预加载 iframe 存在不等于页面已打开。规则和大厅验收同时检查可见 Cocos 节点、WebView 内容和协议握手。
- 所有浏览器验收都必须监听 HTTP 4xx、requestfailed、pageerror、外部 HTTP URL、WebSocket close 和认证超时文本。

### 15.7 当前地址

```text
测试数据客户端  http://127.0.0.1:18082/__game/test
本地概率客户端  http://127.0.0.1:18082/__game/live?token=user1
控制后台        http://127.0.0.1:18082/__admin
服务端历史      http://127.0.0.1:18082/__admin#history
本地规则        http://127.0.0.1:18082/v2/help/dy_mjlltwo/
```
