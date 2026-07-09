#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildLocalGameUrl,
  createReplayResponder,
  inferContentType,
  normalizeReplayMode,
  parseFrameBase64,
  WIN_LADDER_AMOUNTS
} from "../lib/boya-har.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const args = {
    root: path.join(repoRoot, "local-har-client/boya-mahjong2"),
    frames: path.join(repoRoot, "debugserver-data/boya-mahjong2/raw-frames.json"),
    host: "127.0.0.1",
    port: 18082
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      args.root = argv[++index];
    } else if (arg === "--frames") {
      args.frames = argv[++index];
    } else if (arg === "--host") {
      args.host = argv[++index];
    } else if (arg === "--port") {
      args.port = Number(argv[++index]);
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  console.log(`Usage:
  node tools/local/boya-local-server.mjs --root local-har-client/boya-mahjong2 --frames debugserver-data/boya-mahjong2/raw-frames.json --host 127.0.0.1 --port 18082`);
}

async function loadManifest(root) {
  try {
    return JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  } catch {
    return { files: {} };
  }
}

function createState(rawFrames) {
  return {
    startedAt: new Date().toISOString(),
    nextConnectionIndex: 0,
    rawFrames,
    nextHistoryId: 1,
    history: [],
    events: [],
    counts: {
      wsConnected: 0,
      wsClosed: 0,
      mismatches: 0,
      modes: {},
      requests: {},
      responses: {}
    }
  };
}

function logEvent(state, event) {
  const record = {
    time: new Date().toISOString(),
    ...event
  };
  state.events.push(record);
  if (state.events.length > 1000) {
    state.events.splice(0, state.events.length - 1000);
  }
  console.log(JSON.stringify(record));
}

function recordHistory(state, event) {
  const record = {
    id: state.nextHistoryId,
    time: new Date().toISOString(),
    ...event
  };
  state.nextHistoryId += 1;
  state.history.push(record);
  if (state.history.length > 500) {
    state.history.splice(0, state.history.length - 500);
  }
  return record;
}

async function serveStatic(req, res, root, manifest, state) {
  const url = new URL(req.url, "http://127.0.0.1");
  const { host, port } = hostPortFromRequest(req);

  if (url.pathname === "/__replay/status") {
    sendJson(res, {
      ok: true,
      startedAt: state.startedAt,
      counts: state.counts,
      links: {
        replay: buildLocalGameUrl({ host, port, mode: "replay" }),
        dataset: buildLocalGameUrl({ host, port, mode: "dataset" }),
        winladder: buildLocalGameUrl({ host, port, mode: "winladder" }),
        history: `http://${host}:${port}/__history`
      },
      winLadderAmounts: WIN_LADDER_AMOUNTS,
      recentEvents: state.events.slice(-50)
    });
    return;
  }

  if (url.pathname === "/__replay/logs") {
    sendJson(res, state.events);
    return;
  }

  if (url.pathname === "/__replay/client-url") {
    const mode = normalizeReplayMode(url.searchParams.get("mode"));
    sendJson(res, { url: buildLocalGameUrl({ host, port, mode }) });
    return;
  }

  if (url.pathname === "/__game/replay" || url.pathname === "/__game/dataset" || url.pathname === "/__game/winladder") {
    const mode = url.pathname.endsWith("/dataset")
      ? "dataset"
      : url.pathname.endsWith("/winladder")
        ? "winladder"
        : "replay";
    sendRedirect(res, buildLocalGameUrl({ host, port, mode }));
    return;
  }

  if (url.pathname === "/__history.json") {
    sendJson(res, {
      ok: true,
      startedAt: state.startedAt,
      counts: state.counts,
      history: state.history
    });
    return;
  }

  if (url.pathname === "/__history") {
    sendHtml(res, renderHistoryPage(state, host, port));
    return;
  }

  if (req.method === "POST" && (url.pathname === "/dy_buryPoint/pluck" || url.pathname === "/report")) {
    res.writeHead(204);
    res.end();
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/v2" || pathname === "/v2/") {
    pathname = "/v2/index.html";
  }

  if (!pathname.startsWith("/v2/")) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const filePath = path.resolve(root, `.${pathname}`);
  const rootPath = path.resolve(root);
  if (!filePath.startsWith(rootPath + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    const manifestEntry = manifest.files?.[pathname];
    const contentType = manifestEntry?.contentType || inferContentType(pathname);
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": fileStat.size,
      "cache-control": "no-store"
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Missing ${pathname}`);
  }
}

function sendJson(res, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendHtml(res, body) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendRedirect(res, target) {
  res.writeHead(302, {
    location: target,
    "cache-control": "no-store"
  });
  res.end();
}

function hostPortFromRequest(req) {
  const hostHeader = req.headers.host || "127.0.0.1:18082";
  const [hostText, portText] = hostHeader.split(":");
  return {
    host: hostText || "127.0.0.1",
    port: Number(portText) || 18082
  };
}

function renderHistoryPage(state, host, port) {
  const rows = state.history.slice(-200).reverse().map((record) => {
    const dataset = record.datasetIndex === undefined
      ? ""
      : `${record.datasetIndex + 1}/${record.datasetCount}`;
    return [
      "<tr>",
      `<td>${escapeHtml(record.id)}</td>`,
      `<td>${escapeHtml(record.time)}</td>`,
      `<td>${escapeHtml(record.mode || "")}</td>`,
      `<td>${escapeHtml(record.connectionIndex)}</td>`,
      `<td>${escapeHtml(record.direction || "")}</td>`,
      `<td>${escapeHtml(record.cmd || "")}</td>`,
      `<td>${escapeHtml(record.source || "")}</td>`,
      `<td>${escapeHtml(dataset)}</td>`,
      `<td>${escapeHtml(record.winAmount || "")}</td>`,
      `<td>${escapeHtml(record.bytes || "")}</td>`,
      "</tr>"
    ].join("");
  }).join("\n");

  const replayUrl = `http://${host}:${port}/__game/replay`;
  const datasetUrl = `http://${host}:${port}/__game/dataset`;
  const winladderUrl = `http://${host}:${port}/__game/winladder`;
  const jsonUrl = `http://${host}:${port}/__history.json`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Boya Mahjong2 Local History</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #17202a; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 16px; font-size: 24px; }
    .links { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
    .links a { color: #fff; background: #146c61; text-decoration: none; padding: 9px 12px; border-radius: 6px; font-size: 14px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 18px; }
    .metric { background: #fff; border: 1px solid #dde2e7; border-radius: 6px; padding: 12px; }
    .metric strong { display: block; font-size: 22px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dde2e7; }
    th, td { padding: 8px 10px; border-bottom: 1px solid #edf0f3; text-align: left; font-size: 13px; white-space: nowrap; }
    th { background: #eef3f2; font-weight: 600; }
  </style>
</head>
<body>
<main>
  <h1>Boya Mahjong2 本地历史记录</h1>
  <div class="links">
    <a href="${escapeHtml(replayUrl)}" target="_blank">HAR 回放入口</a>
    <a href="${escapeHtml(datasetUrl)}" target="_blank">测试数据集入口</a>
    <a href="${escapeHtml(winladderUrl)}" target="_blank">小到大中奖入口</a>
    <a href="${escapeHtml(jsonUrl)}" target="_blank">JSON 历史</a>
  </div>
  <section class="summary">
    <div class="metric">WS 连接<strong>${escapeHtml(state.counts.wsConnected)}</strong></div>
    <div class="metric">不匹配<strong>${escapeHtml(state.counts.mismatches)}</strong></div>
    <div class="metric">40002 请求<strong>${escapeHtml(state.counts.requests["40002"] || 0)}</strong></div>
    <div class="metric">40003 响应<strong>${escapeHtml(state.counts.responses["40003"] || 0)}</strong></div>
  </section>
  <table>
    <thead>
      <tr>
        <th>ID</th><th>时间</th><th>模式</th><th>连接</th><th>方向</th><th>CMD</th><th>来源</th><th>数据集</th><th>中奖</th><th>字节</th>
      </tr>
    </thead>
    <tbody>
      ${rows || "<tr><td colspan=\"10\">暂无记录</td></tr>"}
    </tbody>
  </table>
</main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function handleUpgrade(req, socket, head, state) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/gate/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const connectionCount = Math.max(1, state.rawFrames.connections.length);
  const connectionIndex = state.nextConnectionIndex % connectionCount;
  const mode = normalizeReplayMode(url.searchParams.get("mode"));
  state.nextConnectionIndex += 1;
  state.counts.wsConnected += 1;
  increment(state.counts.modes, mode);
  const replay = createReplayResponder(state.rawFrames, connectionIndex, mode);
  let pending = head?.length ? Buffer.from(head) : Buffer.alloc(0);

  logEvent(state, { kind: "ws-open", mode, connectionIndex, url: req.url });

  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    try {
      let parsed;
      while ((parsed = readWebSocketFrame(pending))) {
        pending = pending.subarray(parsed.bytesRead);
        handleClientWsFrame(socket, state, replay, mode, connectionIndex, parsed);
      }
    } catch (error) {
      state.counts.mismatches += 1;
      logEvent(state, {
        kind: "ws-error",
        mode,
        connectionIndex,
        error: error.message
      });
      socket.end(encodeWebSocketFrame(Buffer.from(error.message), 0x8));
    }
  });

  socket.on("close", () => {
    state.counts.wsClosed += 1;
    logEvent(state, { kind: "ws-close", mode, connectionIndex });
  });

  socket.on("error", (error) => {
    logEvent(state, { kind: "socket-error", mode, connectionIndex, error: error.message });
  });
}

function handleClientWsFrame(socket, state, replay, mode, connectionIndex, frame) {
  if (frame.opcode === 0x8) {
    socket.end(encodeWebSocketFrame(frame.payload, 0x8));
    return;
  }
  if (frame.opcode === 0x9) {
    socket.write(encodeWebSocketFrame(frame.payload, 0xA));
    return;
  }
  if (frame.opcode !== 0x2) {
    return;
  }

  const parsed = parseFrameBase64(frame.payload);
  increment(state.counts.requests, parsed.cmd);
  recordHistory(state, {
    mode,
    connectionIndex,
    direction: "request",
    cmd: parsed.cmd,
    rawCmd: parsed.rawCmd,
    bytes: frame.payload.length
  });
  logEvent(state, {
    kind: "client-frame",
    mode,
    connectionIndex,
    cmd: parsed.cmd,
    rawCmd: parsed.rawCmd,
    bytes: frame.payload.length
  });

  const responses = replay.nextResponsesForClientFrame(frame.payload);
  for (const responseInfo of responses) {
    const response = responseInfo.buffer || responseInfo;
    const responseFrame = parseFrameBase64(response);
    increment(state.counts.responses, responseFrame.cmd);
    socket.write(encodeWebSocketFrame(response, 0x2));
    recordHistory(state, {
      mode,
      connectionIndex,
      direction: "response",
      cmd: responseFrame.cmd,
      rawCmd: responseFrame.rawCmd,
      bytes: response.length,
      source: responseInfo.source || "har",
      datasetIndex: responseInfo.datasetIndex,
      datasetCount: responseInfo.datasetCount,
      sourceMessageIndex: responseInfo.sourceMessageIndex,
      winAmount: responseInfo.winAmount
    });
    logEvent(state, {
      kind: "server-frame",
      mode,
      connectionIndex,
      cmd: responseFrame.cmd,
      rawCmd: responseFrame.rawCmd,
      bytes: response.length,
      source: responseInfo.source || "har",
      datasetIndex: responseInfo.datasetIndex,
      datasetCount: responseInfo.datasetCount,
      winAmount: responseInfo.winAmount
    });
  }
}

function increment(target, key) {
  const normalized = String(key);
  target[normalized] = (target[normalized] || 0) + 1;
}

function readWebSocketFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let payloadLength = second & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("WebSocket frame is too large");
    }
    payloadLength = Number(bigLength);
    offset += 8;
  }

  let mask;
  if (masked) {
    if (buffer.length < offset + 4) {
      return null;
    }
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) {
    return null;
  }

  let payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  if (masked) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    opcode,
    payload,
    bytesRead: offset + payloadLength
  };
}

function encodeWebSocketFrame(payload, opcode = 0x2) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = data.length;
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest(args.root);
  const rawFrames = JSON.parse(await readFile(args.frames, "utf8"));
  const state = createState(rawFrames);
  const server = http.createServer((req, res) => {
    serveStatic(req, res, args.root, manifest, state).catch((error) => {
      console.error(error?.stack || String(error));
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error?.message || error));
    });
  });

  server.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head, state));
  server.listen(args.port, args.host, async () => {
    const replayUrl = buildLocalGameUrl({ host: args.host, port: args.port, mode: "replay" });
    const datasetUrl = buildLocalGameUrl({ host: args.host, port: args.port, mode: "dataset" });
    const winladderUrl = buildLocalGameUrl({ host: args.host, port: args.port, mode: "winladder" });
    console.log(JSON.stringify({
      ok: true,
      root: args.root,
      frames: args.frames,
      listen: `http://${args.host}:${args.port}`,
      replayUrl,
      datasetUrl,
      winladderUrl,
      winLadderAmounts: WIN_LADDER_AMOUNTS,
      historyUrl: `http://${args.host}:${args.port}/__history`
    }, null, 2));
    try {
      await writeFile(path.join(repoRoot, ".boya-local-server-url"), `${replayUrl}\n`, "utf8");
      await writeFile(path.join(repoRoot, ".boya-local-dataset-url"), `${datasetUrl}\n`, "utf8");
      await writeFile(path.join(repoRoot, ".boya-local-winladder-url"), `${winladderUrl}\n`, "utf8");
      await writeFile(path.join(repoRoot, ".boya-local-history-url"), `http://${args.host}:${args.port}/__history\n`, "utf8");
    } catch {
      // URL file is best-effort only.
    }
  });
} catch (error) {
  console.error(error?.stack || String(error));
  process.exit(1);
}
