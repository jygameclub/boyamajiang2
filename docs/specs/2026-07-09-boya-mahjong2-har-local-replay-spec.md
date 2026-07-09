# Boya 麻将2 HAR 本地还原与 Bet 验证 Spec

**日期:** 2026-07-09
**工作目录:** `/Users/yang/work/git/sun/boyamajiang2`
**输入 HAR:** `/Users/yang/work/git/sun/boyamajiang2/麻将2 boya.har`
**参考项目:** `/Users/yang/work/git/slot-platform`
**状态:** 已实现本地 HAR 客户端、WebSocket replay 服务、dataset 测试入口、小到大中奖控制入口、历史记录页、图片预览导出和 Playwright bet 验证。

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
.boya-local-winladder-url 小到大中奖控制入口
.boya-local-history-url   本地历史记录页面
```

直接访问地址：

```text
http://127.0.0.1:18082/__game/replay
http://127.0.0.1:18082/__game/dataset
http://127.0.0.1:18082/__game/winladder
http://127.0.0.1:18082/__history
```

`/__game/replay` 会跳转到本地 `/v2/` 客户端，WebSocket 指向 `ws://127.0.0.1:18082/gate/ws?mode=replay`，按 HAR 中原始 frame 顺序回放。

`/__game/dataset` 会跳转到同一个本地客户端，WebSocket 指向 `ws://127.0.0.1:18082/gate/ws?mode=dataset`。该模式下 `40001` 仍使用 HAR enter 数据，`40003` 从 HAR 捕获到的 4 条 bet 结果中循环返回，并在历史中标记 `source=dataset`、`datasetIndex`、`datasetCount`。

`/__game/winladder` 会跳转到同一个本地客户端，WebSocket 指向 `ws://127.0.0.1:18082/gate/ws?mode=winladder`。该模式下 `40001` 仍使用 HAR enter 数据，`40003` 由本地服务生成，并按 `400 -> 1200 -> 2400 -> 6000 -> 12000 -> 20000` 循环返回；历史中标记 `source=winladder` 和 `winAmount`。

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
