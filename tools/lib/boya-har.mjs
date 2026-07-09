import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_HAR_TOKEN = "uzuN0IxNjgzMDhGN0Y3Qjk4nPpYNzI2MTU3M0MwQzEyNEQ2NDA0RjIzQTg3NDkzN0MyMkQ4QUY4NTdEMjEwMUY4QThGMzBDNDBBRjAyMTdGREFFQzAyOUYxQkEyNEFBREI5NjFDMjVCNzJFMzMxODU0Mzk4QTBCNDE2RUU1OUE5Q0ZCMTU1RkFCQzM0Rjc0NTBENkM2QjE3RERGNTc5MDdFQTdFREFBRkMzRTgzNjk4NkRFQzNGMEUwQzg1NUM3MDlDRDc0vpEgl";
export const WIN_LADDER_AMOUNTS = [400, 1200, 2400, 6000, 12000, 20000];
const HEARTBEAT_REQUEST_CMD = 5000;
const HEARTBEAT_RESPONSE_CMD = 5001;

export function parseFrameBase64(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "base64");
  if (buffer.length < 12) {
    throw new Error(`Frame is too short: ${buffer.length} bytes`);
  }

  const declaredLength = buffer.readUInt32BE(0);
  const rawCmd = buffer.readUInt32BE(4);
  const cmd = rawCmd & 0x7fffffff;
  const flags = buffer.readUInt32BE(8);
  const payload = buffer.subarray(12);

  return {
    length: buffer.length,
    declaredLength,
    rawCmd,
    cmd,
    flags,
    compressed: rawCmd !== cmd,
    payload
  };
}

export function buildLocalGameUrl({ host, port, mode = "replay", token = DEFAULT_HAR_TOKEN }) {
  const normalizedMode = normalizeReplayMode(mode);
  const wsUrl = `ws://${host}:${port}/gate/ws?mode=${encodeURIComponent(normalizedMode)}`;
  const g = Buffer.from(wsUrl).toString("base64");
  return `http://${host}:${port}/v2/?token=${token}&deviceType=0&pcode=ZHlnd3N3&t=MTAz&ma=bWFpbmxhbmQ=&lang=CN&g=${encodeURIComponent(g)}&sound=0&music=0&localMode=${encodeURIComponent(normalizedMode)}`;
}

export function normalizeReplayMode(mode) {
  const value = String(mode || "").toLowerCase();
  if (value.startsWith("dataset")) {
    return "dataset";
  }
  if (value.startsWith("winladder")) {
    return "winladder";
  }
  return "replay";
}

export async function readHarFile(harPath) {
  return JSON.parse(await readFile(harPath, "utf8"));
}

export function localPathForV2Url(url) {
  const parsed = new URL(url);
  let pathname = decodeURIComponent(parsed.pathname);
  if (pathname === "/v2" || pathname === "/v2/") {
    pathname = "/v2/index.html";
  }
  if (!pathname.startsWith("/v2/")) {
    return null;
  }
  return pathname;
}

export async function extractAssetsFromHarObject(har, outDir) {
  const files = {};
  let written = 0;
  const entries = har?.log?.entries || [];

  await mkdir(outDir, { recursive: true });

  for (const entry of entries) {
    const url = entry?.request?.url;
    if (typeof url !== "string" || !url.startsWith("https://game.666789.site/v2")) {
      continue;
    }

    const localPath = localPathForV2Url(url);
    if (!localPath) {
      continue;
    }

    const content = entry?.response?.content || {};
    const text = content.text ?? "";
    const bytes = content.encoding === "base64"
      ? Buffer.from(text, "base64")
      : Buffer.from(text, "utf8");
    const absolutePath = path.join(outDir, localPath);

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
    written += 1;

    files[localPath] = {
      sourceUrl: url,
      status: entry?.response?.status || 0,
      contentType: content.mimeType || inferContentType(localPath),
      encoding: content.encoding || "plain",
      bytes: bytes.length
    };
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceHost: "game.666789.site",
    files
  };

  const summary = {
    schemaVersion: 1,
    generatedAt: manifest.generatedAt,
    written,
    contentTypes: countBy(Object.values(files), (file) => file.contentType),
    encodings: countBy(Object.values(files), (file) => file.encoding)
  };

  await writeJson(path.join(outDir, "manifest.json"), manifest);
  await writeJson(path.join(outDir, "har-summary.json"), summary);

  return { written, manifest, summary };
}

export async function extractAssetsFromHarFile(harPath, outDir) {
  return extractAssetsFromHarObject(await readHarFile(harPath), outDir);
}

export async function importFramesFromHarObject(har, outDir) {
  const entries = har?.log?.entries || [];
  const connections = [];
  const frames = [];
  const summary = {
    totalMessages: 0,
    connections: 0,
    commands: {}
  };

  for (const entry of entries) {
    const url = entry?.request?.url;
    const messages = entry?._webSocketMessages;
    if (typeof url !== "string" || !url.startsWith("wss://") || !Array.isArray(messages)) {
      continue;
    }

    const connectionIndex = connections.length;
    const connection = {
      connectionIndex,
      url,
      messages: []
    };

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      const parsed = parseFrameBase64(message.data);
      const record = {
        connectionIndex,
        messageIndex,
        time: message.time ?? null,
        type: message.type,
        opcode: message.opcode ?? null,
        rawFrameBase64: message.data,
        length: parsed.length,
        declaredLength: parsed.declaredLength,
        rawCmd: parsed.rawCmd,
        cmd: parsed.cmd,
        flags: parsed.flags,
        compressed: parsed.compressed,
        payloadLength: parsed.payload.length
      };

      connection.messages.push(record);
      frames.push(record);
      summary.totalMessages += 1;
      const key = String(record.cmd);
      summary.commands[key] ||= { send: 0, receive: 0, total: 0 };
      if (record.type === "send") {
        summary.commands[key].send += 1;
      } else if (record.type === "receive") {
        summary.commands[key].receive += 1;
      }
      summary.commands[key].total += 1;
    }

    connections.push(connection);
  }

  summary.connections = connections.length;

  const rawFrames = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    frames,
    connections,
    summary
  };

  await mkdir(outDir, { recursive: true });
  await writeJson(path.join(outDir, "raw-frames.json"), rawFrames);

  const enter = frames.find((frame) => frame.type === "receive" && frame.cmd === 40001);
  const normalBet = frames.find((frame) => frame.type === "receive" && frame.cmd === 40003);
  if (!enter) {
    throw new Error("No 40001 enter response found in HAR WebSocket frames");
  }
  if (!normalBet) {
    throw new Error("No 40003 normal bet response found in HAR WebSocket frames");
  }

  await writeJson(path.join(outDir, "000.json"), debugPayload("enter", enter));
  await writeJson(path.join(outDir, "001.json"), debugPayload("normal-bet", normalBet));
  await writeFile(path.join(outDir, "coverage-config.yaml"), buildCoverageConfig(), "utf8");

  return rawFrames;
}

export async function importFramesFromHarFile(harPath, outDir) {
  return importFramesFromHarObject(await readHarFile(harPath), outDir);
}

export function createConnectionReplay(rawFrames, connectionIndex) {
  const connection = rawFrames?.connections?.[connectionIndex];
  if (!connection) {
    throw new Error(`No WebSocket connection at index ${connectionIndex}`);
  }

  let cursor = 0;
  const messages = connection.messages || [];

  function findSendIndex(cmd) {
    for (let index = cursor; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.type === "send" && message.cmd === cmd) {
        return index;
      }
    }
    return -1;
  }

  function nextResponsesForClientFrame(input) {
    const frame = parseFrameBase64(input);
    const sendIndex = findSendIndex(frame.cmd);
    if (sendIndex < 0) {
      throw new Error(`No replay response for cmd ${frame.cmd} on connection ${connectionIndex}`);
    }

    cursor = sendIndex + 1;
    const responses = [];
    while (cursor < messages.length && messages[cursor].type === "receive") {
      responses.push(Buffer.from(messages[cursor].rawFrameBase64, "base64"));
      cursor += 1;
    }
    return responses;
  }

  return {
    get cursor() {
      return cursor;
    },
    nextResponsesForClientFrame,
    nextResponseForClientFrame(input) {
      const responses = nextResponsesForClientFrame(input);
      if (!responses.length) {
        throw new Error(`No replay response for cmd ${parseFrameBase64(input).cmd} on connection ${connectionIndex}`);
      }
      return responses[0];
    }
  };
}

export function createReplayResponder(rawFrames, connectionIndex, mode = "replay") {
  const normalizedMode = normalizeReplayMode(mode);
  if (normalizedMode === "dataset") {
    return createDatasetResponder(rawFrames, connectionIndex);
  }
  if (normalizedMode === "winladder") {
    return createWinLadderResponder(rawFrames, connectionIndex);
  }

  const replay = createConnectionReplay(rawFrames, connectionIndex);
  return {
    mode: "replay",
    get cursor() {
      return replay.cursor;
    },
    nextResponsesForClientFrame(input) {
      const request = parseFrameBase64(input);
      if (request.cmd === HEARTBEAT_REQUEST_CMD) {
        return [createHeartbeatResponse(rawFrames, connectionIndex)];
      }
      return replay.nextResponsesForClientFrame(input).map((buffer) => ({
        buffer,
        source: "har"
      }));
    }
  };
}

// MsgRotate submessage protobuf field numbers.
const ROTATE_FIELD_ROUND_SCORE = 15;
const ROTATE_FIELD_TOTAL_WIN = 16;
const ROTATE_FIELD_ROUND_WIN = 17;
const ROTATE_FIELD_LINE = 11;
// Board fields: main 5x5 grid + top/bottom padding rows (length-delimited packed ints).
const ROTATE_BOARD_FIELDS = [8, 9, 10];
const FREE_SPIN_ONLY_FIELDS = new Set([19, 20, 21, 22, 23, 24, 25, 26]);

// Split a protobuf message into ordered fields while keeping each field's raw wire
// bytes intact, so untouched fields survive a round-trip byte-for-byte.
function splitOrderedFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    const tag = readVarint(buffer, offset);
    offset = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === 0) {
      offset = readVarint(buffer, offset).next;
    } else if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.next + Number(length.value);
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire} at field ${field}`);
    }
    fields.push({ field, wire, raw: Buffer.from(buffer.subarray(start, offset)) });
  }
  return fields;
}

// Rebuild a MsgRotate submessage: replace varint fields by value and length-delimited
// fields (e.g. the board) by raw wire bytes, keeping every other recorded field exactly
// as captured. Missing varint overrides are appended in ascending field order.
function rebuildRotateInner(
  inner,
  {
    varintOverrides = {},
    rawFieldOverrides = {},
    repeatedFieldOverrides = {},
    insertRepeatedAfterField = {},
    omitFields = []
  } = {}
) {
  const fields = splitOrderedFields(inner);
  const present = new Set(fields.map((entry) => entry.field));
  const omitted = new Set(omitFields);
  const repeatedInserted = new Set();
  const chunks = [];
  for (const entry of fields) {
    let emittedEntry = false;
    if (omitted.has(entry.field)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(repeatedFieldOverrides, entry.field)) {
      if (!repeatedInserted.has(entry.field)) {
        chunks.push(...repeatedFieldOverrides[entry.field]);
        repeatedInserted.add(entry.field);
      }
    } else if (Object.prototype.hasOwnProperty.call(rawFieldOverrides, entry.field)) {
      chunks.push(rawFieldOverrides[entry.field]);
      emittedEntry = true;
    } else if (Object.prototype.hasOwnProperty.call(varintOverrides, entry.field)) {
      chunks.push(encodeVarintField(entry.field, varintOverrides[entry.field]));
      emittedEntry = true;
    } else {
      chunks.push(entry.raw);
      emittedEntry = true;
    }
    if (emittedEntry && Object.prototype.hasOwnProperty.call(insertRepeatedAfterField, entry.field)) {
      for (const [field, fieldChunks] of insertRepeatedAfterField[entry.field]) {
        if (!repeatedInserted.has(field) && !omitted.has(field)) {
          chunks.push(...fieldChunks);
          repeatedInserted.add(field);
        }
      }
    }
  }
  for (const key of Object.keys(varintOverrides).map(Number).sort((a, b) => a - b)) {
    if (!present.has(key)) {
      chunks.push(encodeVarintField(key, varintOverrides[key]));
    }
  }
  for (const key of Object.keys(repeatedFieldOverrides).map(Number).sort((a, b) => a - b)) {
    if (!present.has(key) && !repeatedInserted.has(key) && !omitted.has(key)) {
      chunks.push(...repeatedFieldOverrides[key]);
    }
  }
  return Buffer.concat(chunks);
}

function rotateInnerOf(frameBuffer) {
  const parsed = parseFrameBase64(frameBuffer);
  const outer = readFields(parsed.payload);
  const rotateField = outer.find((field) => field.field === 1 && field.wire === 2);
  if (!rotateField) {
    throw new Error("Frame has no MsgRotate submessage");
  }
  return rotateField.value;
}

// Extract the board field group (raw wire bytes for fields 8/9/10) from a recorded
// spin frame, so it can be transplanted into another frame's structure.
export function extractBoardFields(frameBuffer) {
  const fields = splitOrderedFields(rotateInnerOf(frameBuffer));
  const board = {};
  for (const entry of fields) {
    if (ROTATE_BOARD_FIELDS.includes(entry.field)) {
      board[entry.field] = entry.raw;
    }
  }
  return board;
}

// Collect distinct real boards from recorded 40003/40005 frames (base + cascade steps),
// so winladder can vary the board every spin instead of repeating one frame.
export function collectRealBoards(rawFrames, connectionIndex) {
  const seen = new Set();
  const boards = [];
  const connection = rawFrames?.connections?.[connectionIndex];
  const pools = [connection?.messages, rawFrames?.frames];
  for (const messages of pools) {
    if (!Array.isArray(messages)) {
      continue;
    }
    for (const message of messages) {
      if (message.type !== "receive" || (message.cmd !== 40003 && message.cmd !== 40005)) {
        continue;
      }
      let board;
      let key;
      try {
        const frame = Buffer.from(message.rawFrameBase64, "base64");
        board = extractBoardFields(frame);
        if (!board[8]) {
          continue;
        }
        key = board[8].toString("base64");
      } catch {
        continue;
      }
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      boards.push(board);
    }
  }
  return boards;
}

export function collectWinningSpinTemplates(rawFrames, connectionIndex) {
  const connection = rawFrames?.connections?.[connectionIndex];
  const pools = [connection?.messages, rawFrames?.frames];
  const templates = [];

  for (const messages of pools) {
    if (!Array.isArray(messages)) {
      continue;
    }
    for (const message of messages) {
      if (message.type !== "receive" || message.cmd !== 40005) {
        continue;
      }
      try {
        const frame = Buffer.from(message.rawFrameBase64, "base64");
        const rotate = decodeBoyaRotateFromPayload(parseFrameBase64(frame).payload);
        const lineScoreSum = rotate.lines.reduce((sum, line) => sum + (line.score || 0), 0);
        if (!rotate.lines.length || lineScoreSum <= 0 || rotate.roundWin <= 0 || rotate.drawResult.length !== 25) {
          continue;
        }
        templates.push({
          frame,
          rotate,
          lineScoreSum,
          sourceConnectionIndex: message.connectionIndex,
          sourceMessageIndex: message.messageIndex
        });
      } catch {
        continue;
      }
    }
    if (templates.length) {
      break;
    }
  }

  const preferred = templates.filter((template) => !template.rotate.goldToWildPos.length);
  return (preferred.length ? preferred : templates)
    .sort((a, b) => a.lineScoreSum - b.lineScoreSum || a.sourceMessageIndex - b.sourceMessageIndex);
}

// Build a winladder 40003 by cloning a REAL recorded spin result and overriding only the
// money fields (and optionally swapping in a different recorded board). Real frames carry
// a structure the client accepts, avoiding the malformed-frame path that made the client
// show "登录认证超时"; the board swap keeps the reels visibly changing between spins.
export function createWinLadderFrameFromBase(baseFrameBuffer, { winAmount, betCoin = 400, board } = {}) {
  const inner = rotateInnerOf(baseFrameBuffer);
  const patchedInner = rebuildRotateInner(inner, {
    varintOverrides: {
      [ROTATE_FIELD_ROUND_SCORE]: Math.max(0, Number(winAmount) - Number(betCoin)),
      [ROTATE_FIELD_TOTAL_WIN]: Number(winAmount),
      [ROTATE_FIELD_ROUND_WIN]: Number(winAmount)
    },
    rawFieldOverrides: board || {}
  });
  return encodeGameFrame(40003, encodeLengthDelimited(1, patchedInner));
}

export function createWinLadderFrameFromWinningTemplate(templateFrameBuffer, { winAmount, betCoin = 400 } = {}) {
  const parsed = parseFrameBase64(templateFrameBuffer);
  const rotate = decodeBoyaRotateFromPayload(parsed.payload);
  const targetWin = Number(winAmount);
  if (!rotate.lines.length) {
    throw new Error("Winning template must contain lines");
  }

  const scaledLines = scaleLineScores(rotate.lines, targetWin);
  const patchedInner = rebuildRotateInner(rotateInnerOf(templateFrameBuffer), {
    varintOverrides: {
      [ROTATE_FIELD_ROUND_SCORE]: Math.max(0, targetWin - Number(betCoin)),
      [ROTATE_FIELD_TOTAL_WIN]: targetWin,
      [ROTATE_FIELD_ROUND_WIN]: targetWin,
      20: targetWin
    },
    repeatedFieldOverrides: {
      [ROTATE_FIELD_LINE]: scaledLines.map((line) => encodeLengthDelimited(ROTATE_FIELD_LINE, encodeLineReward(line)))
    }
  });
  return encodeGameFrame(40003, encodeLengthDelimited(1, patchedInner));
}

export function createWinLadderFrameFromBaseWinningTemplate(baseFrameBuffer, templateFrameBuffer, { winAmount, betCoin = 400 } = {}) {
  const parsed = parseFrameBase64(templateFrameBuffer);
  const rotate = decodeBoyaRotateFromPayload(parsed.payload);
  const targetWin = Number(winAmount);
  if (!rotate.lines.length) {
    throw new Error("Winning template must contain lines");
  }

  const scaledLines = scaleLineScores(rotate.lines, targetWin);
  const patchedInner = rebuildRotateInner(rotateInnerOf(baseFrameBuffer), {
    varintOverrides: {
      [ROTATE_FIELD_ROUND_SCORE]: Math.max(0, targetWin - Number(betCoin)),
      [ROTATE_FIELD_TOTAL_WIN]: targetWin,
      [ROTATE_FIELD_ROUND_WIN]: targetWin
    },
    rawFieldOverrides: extractBoardFields(templateFrameBuffer),
    repeatedFieldOverrides: {
      [ROTATE_FIELD_LINE]: scaledLines.map((line) => encodeLengthDelimited(ROTATE_FIELD_LINE, encodeLineReward(line)))
    },
    insertRepeatedAfterField: {
      10: [[ROTATE_FIELD_LINE, scaledLines.map((line) => encodeLengthDelimited(ROTATE_FIELD_LINE, encodeLineReward(line)))]]
    }
  });
  return encodeGameFrame(40003, encodeLengthDelimited(1, patchedInner));
}

export function createWinLadderFreeCascadeFrame(templateFrameBuffer, { roundWin, cumulativeWin } = {}) {
  const parsed = parseFrameBase64(templateFrameBuffer);
  const rotate = decodeBoyaRotateFromPayload(parsed.payload);
  const targetRoundWin = Number(roundWin);
  const targetCumulativeWin = Number(cumulativeWin);
  if (!rotate.lines.length) {
    throw new Error("Free cascade template must contain lines");
  }

  const scaledLines = scaleLineScores(rotate.lines, targetRoundWin);
  const patchedInner = rebuildRotateInner(rotateInnerOf(templateFrameBuffer), {
    varintOverrides: {
      [ROTATE_FIELD_TOTAL_WIN]: targetCumulativeWin,
      [ROTATE_FIELD_ROUND_WIN]: targetRoundWin,
      20: targetCumulativeWin
    },
    repeatedFieldOverrides: {
      [ROTATE_FIELD_LINE]: scaledLines.map((line) => encodeLengthDelimited(ROTATE_FIELD_LINE, encodeLineReward(line)))
    }
  });
  return encodeGameFrame(parsed.cmd, encodeLengthDelimited(1, patchedInner));
}

export function createGeneratedWinFrame({ winAmount, sequence = 1, coin = 455700000 } = {}) {
  const normalizedWin = Number.isFinite(Number(winAmount)) ? Number(winAmount) : 400;
  const rotate = encodeMsgRotate({
    originalStatus: 0,
    status: 0,
    seq: `local-winladder-${sequence}-${Date.now()}`,
    coin,
    betMulti: 20,
    betCoin: 400,
    purchase: false,
    drawResult: [
      101, 11, 19, 19, 15,
      17, 19, 17, 13, 4,
      7, 11, 20, 9, 5,
      7, 13, 17, 17, 19,
      101, 9, 13, 13, 19
    ],
    topResult: [15, 17, 9, 19, 5],
    buttomResult: [9, 7, 17, 5, 7],
    lines: [{
      iconId: 19,
      axleId: 4,
      lineNum: 2,
      score: normalizedWin,
      multi: 1,
      odds: Math.max(1, Math.round(normalizedWin / 200))
    }],
    gameNumList: [1, 2, 3, 5],
    gameNum: sequence,
    goldToWildPos: [12],
    roundScore: Math.max(0, normalizedWin - 400),
    totalWin: normalizedWin,
    roundWin: normalizedWin,
    bFree: false,
    freeAppend: 0,
    freeTotalWin: 0,
    freeRemainCount: 0,
    freeMaxCount: 0,
    triggerWin: 0
  });
  return encodeGameFrame(40003, encodeLengthDelimited(1, rotate));
}

function createHeartbeatResponse(rawFrames, connectionIndex) {
  const connection = rawFrames?.connections?.[connectionIndex];
  const selected = connection?.messages?.find((message) => message.type === "receive" && message.cmd === HEARTBEAT_RESPONSE_CMD)
    || rawFrames?.frames?.find((message) => message.type === "receive" && message.cmd === HEARTBEAT_RESPONSE_CMD);

  return {
    buffer: selected
      ? Buffer.from(selected.rawFrameBase64, "base64")
      : createGeneratedHeartbeatFrame(),
    source: "heartbeat",
    sourceConnectionIndex: selected?.connectionIndex,
    sourceMessageIndex: selected?.messageIndex
  };
}

function createGeneratedHeartbeatFrame() {
  return encodeGameFrame(HEARTBEAT_RESPONSE_CMD, encodeVarintField(1, Math.floor(Date.now() / 1000)));
}

export function decodeBoyaRotateFromPayload(payload) {
  const outer = readFields(Buffer.from(payload));
  const rotateField = outer.find((field) => field.field === 1 && field.wire === 2);
  if (!rotateField) {
    return {};
  }
  const fields = readFields(rotateField.value);
  const rotate = {
    lines: [],
    drawResult: [],
    topResult: [],
    buttomResult: [],
    gameNumList: [],
    goldToWildPos: [],
    triggerDraw: [],
    triggerTopResult: [],
    triggerButtomResult: []
  };

  for (const field of fields) {
    if (field.field === 1) rotate.originalStatus = Number(field.value);
    else if (field.field === 2) rotate.status = Number(field.value);
    else if (field.field === 3) rotate.seq = field.value.toString("utf8");
    else if (field.field === 4) rotate.coin = Number(field.value);
    else if (field.field === 5) rotate.betMulti = Number(field.value);
    else if (field.field === 6) rotate.betCoin = Number(field.value);
    else if (field.field === 7) rotate.purchase = Boolean(Number(field.value));
    else if (field.field === 8) rotate.drawResult = decodePackedInts(field);
    else if (field.field === 9) rotate.topResult = decodePackedInts(field);
    else if (field.field === 10) rotate.buttomResult = decodePackedInts(field);
    else if (field.field === 11) rotate.lines.push(decodeLineReward(field.value));
    else if (field.field === 12) rotate.gameNumList = decodePackedInts(field);
    else if (field.field === 13) rotate.gameNum = Number(field.value);
    else if (field.field === 14) rotate.goldToWildPos = decodePackedInts(field);
    else if (field.field === 15) rotate.roundScore = Number(field.value);
    else if (field.field === 16) rotate.totalWin = Number(field.value);
    else if (field.field === 17) rotate.roundWin = Number(field.value);
    else if (field.field === 18) rotate.bFree = Boolean(Number(field.value));
    else if (field.field === 19) rotate.freeAppend = Number(field.value);
    else if (field.field === 20) rotate.freeTotalWin = Number(field.value);
    else if (field.field === 21) rotate.freeRemainCount = Number(field.value);
    else if (field.field === 22) rotate.freeMaxCount = Number(field.value);
    else if (field.field === 23) rotate.triggerDraw = decodePackedInts(field);
    else if (field.field === 24) rotate.triggerWin = Number(field.value);
    else if (field.field === 25) rotate.triggerTopResult = decodePackedInts(field);
    else if (field.field === 26) rotate.triggerButtomResult = decodePackedInts(field);
  }

  rotate.totalWin ||= 0;
  rotate.roundWin ||= 0;
  return rotate;
}

function createDatasetResponder(rawFrames, connectionIndex) {
  const connection = rawFrames?.connections?.[connectionIndex];
  if (!connection) {
    throw new Error(`No WebSocket connection at index ${connectionIndex}`);
  }

  const replay = createConnectionReplay(rawFrames, connectionIndex);
  const betResponses = (connection.messages || [])
    .filter((message) => message.type === "receive" && message.cmd === 40003);
  const freeSpins = createFreeSpinReplayer(rawFrames, connectionIndex);
  let betCursor = 0;

  return {
    mode: "dataset",
    get cursor() {
      return replay.cursor;
    },
    nextResponsesForClientFrame(input) {
      const request = parseFrameBase64(input);
      if (request.cmd === HEARTBEAT_REQUEST_CMD) {
        return [createHeartbeatResponse(rawFrames, connectionIndex)];
      }
      if (request.cmd === 40006 && freeSpins.hasData) {
        const frame = freeSpins.trigger();
        if (frame) {
          return [{ buffer: frame, source: "freespin-trigger" }];
        }
      }
      if (request.cmd === 40004 && freeSpins.hasData) {
        const step = freeSpins.nextCascade();
        if (step) {
          return [{
            buffer: step.frame,
            source: "freespin-cascade",
            datasetIndex: step.datasetIndex ?? step.index,
            datasetCount: step.datasetCount ?? step.count,
            winAmount: step.winAmount,
            originalRoundWin: step.originalRoundWin
          }];
        }
      }
      if (request.cmd === 40002 && betResponses.length > 0) {
        const datasetIndex = betCursor % betResponses.length;
        const selected = betResponses[datasetIndex];
        betCursor += 1;
        return [{
          buffer: Buffer.from(selected.rawFrameBase64, "base64"),
          source: "dataset",
          datasetIndex,
          datasetCount: betResponses.length,
          sourceConnectionIndex: selected.connectionIndex,
          sourceMessageIndex: selected.messageIndex
        }];
      }

      return replay.nextResponsesForClientFrame(input).map((buffer) => ({
        buffer,
        source: "har"
      }));
    }
  };
}

function findRecordedBetFrame(rawFrames, connectionIndex) {
  const connection = rawFrames?.connections?.[connectionIndex];
  const fromConnection = connection?.messages?.find(
    (message) => message.type === "receive" && message.cmd === 40003
  );
  const selected = fromConnection
    || rawFrames?.frames?.find((message) => message.type === "receive" && message.cmd === 40003);
  return selected ? Buffer.from(selected.rawFrameBase64, "base64") : null;
}

function selectWinningTemplate(templates, winIndex) {
  if (!templates.length) {
    return null;
  }
  if (templates.length === 1 || WIN_LADDER_AMOUNTS.length === 1) {
    return { template: templates[0], templateIndex: 0 };
  }
  const templateIndex = Math.round((winIndex * (templates.length - 1)) / (WIN_LADDER_AMOUNTS.length - 1));
  return { template: templates[Math.min(templateIndex, templates.length - 1)], templateIndex };
}

// Gather all recorded receive frames for a command, preferring the connection's own
// frames and falling back to any connection.
function collectRecordedFrames(rawFrames, connectionIndex, cmd) {
  const connection = rawFrames?.connections?.[connectionIndex];
  const local = (connection?.messages || [])
    .filter((message) => message.type === "receive" && message.cmd === cmd);
  const source = local.length
    ? local
    : (rawFrames?.frames || []).filter((message) => message.type === "receive" && message.cmd === cmd);
  return source.map((message) => Buffer.from(message.rawFrameBase64, "base64"));
}

// Replays the recorded free-spin feature: 40006 (buy free) -> 40007 trigger, then each
// 40004 (cascade/tumble request) -> the next recorded 40005 step. Using the real recorded
// frames keeps the cascade animation and free-spin state machine valid, so controlled
// modes can offer "盘面掉了" without desyncing the base-spin replay cursor.
function createFreeSpinReplayer(rawFrames, connectionIndex, { ladderAmounts = null } = {}) {
  const triggerFrames = collectRecordedFrames(rawFrames, connectionIndex, 40007);
  const cascadeFrames = collectRecordedFrames(rawFrames, connectionIndex, 40005);
  let cascadeCursor = 0;
  let ladderCursor = 0;
  let cumulativeWin = 0;
  return {
    hasData: triggerFrames.length > 0 && cascadeFrames.length > 0,
    trigger() {
      cascadeCursor = 0;
      ladderCursor = 0;
      cumulativeWin = 0;
      return triggerFrames[0] || null;
    },
    nextCascade() {
      if (!cascadeFrames.length) {
        return null;
      }
      const index = Math.min(cascadeCursor, cascadeFrames.length - 1);
      const selected = cascadeFrames[index];
      cascadeCursor += 1;
      if (Array.isArray(ladderAmounts) && ladderAmounts.length) {
        try {
          const rotate = decodeBoyaRotateFromPayload(parseFrameBase64(selected).payload);
          if (rotate.lines.length && rotate.lines.reduce((sum, line) => sum + (line.score || 0), 0) > 0) {
            const ladderIndex = Math.min(ladderCursor, ladderAmounts.length - 1);
            const roundWin = ladderAmounts[ladderIndex];
            ladderCursor += 1;
            cumulativeWin += roundWin;
            return {
              frame: createWinLadderFreeCascadeFrame(selected, { roundWin, cumulativeWin }),
              index,
              count: cascadeFrames.length,
              winAmount: roundWin,
              datasetIndex: ladderIndex,
              datasetCount: ladderAmounts.length,
              originalRoundWin: rotate.roundWin
            };
          }
        } catch {
          // Fall back to the exact recorded cascade frame.
        }
      }
      return { frame: selected, index, count: cascadeFrames.length };
    }
  };
}

function createWinLadderResponder(rawFrames, connectionIndex) {
  const replay = createConnectionReplay(rawFrames, connectionIndex);
  const baseBetFrame = findRecordedBetFrame(rawFrames, connectionIndex);
  const boards = collectRealBoards(rawFrames, connectionIndex);
  const winningTemplates = collectWinningSpinTemplates(rawFrames, connectionIndex);
  const freeSpins = createFreeSpinReplayer(rawFrames, connectionIndex, { ladderAmounts: WIN_LADDER_AMOUNTS });
  let spinIndex = 0;

  function buildWinFrame(winAmount, sequence, winIndex, board) {
    const selectedWinning = selectWinningTemplate(winningTemplates, winIndex);
    if (selectedWinning) {
      try {
        return {
          buffer: createWinLadderFrameFromWinningTemplate(selectedWinning.template.frame, { winAmount }),
          templateIndex: selectedWinning.templateIndex,
          sourceConnectionIndex: selectedWinning.template.sourceConnectionIndex,
          sourceMessageIndex: selectedWinning.template.sourceMessageIndex,
          originalRoundWin: selectedWinning.template.rotate.roundWin
        };
      } catch {
        // Fall through to the base-shell path.
      }
    }
    if (selectedWinning && baseBetFrame) {
      try {
        return {
          buffer: createWinLadderFrameFromBaseWinningTemplate(baseBetFrame, selectedWinning.template.frame, { winAmount }),
          templateIndex: selectedWinning.templateIndex,
          sourceConnectionIndex: selectedWinning.template.sourceConnectionIndex,
          sourceMessageIndex: selectedWinning.template.sourceMessageIndex,
          originalRoundWin: selectedWinning.template.rotate.roundWin
        };
      } catch {
        // Fall through to the sanitized-template path.
      }
    }
    // Prefer cloning a real recorded spin result so the client keeps a valid game
    // state; only fall back to a synthetic frame when no real 40003 was captured
    // (e.g. unit-test fixtures with placeholder payloads).
    if (baseBetFrame) {
      try {
        return { buffer: createWinLadderFrameFromBase(baseBetFrame, { winAmount, board }) };
      } catch {
        // Fall through to the synthetic frame below.
      }
    }
    return {
      buffer: createGeneratedWinFrame({
        winAmount,
        sequence,
        coin: 455700000 + sequence * 1000 + winAmount
      })
    };
  }

  return {
    mode: "winladder",
    get cursor() {
      return replay.cursor;
    },
    nextResponsesForClientFrame(input) {
      const request = parseFrameBase64(input);
      if (request.cmd === HEARTBEAT_REQUEST_CMD) {
        return [createHeartbeatResponse(rawFrames, connectionIndex)];
      }
      // Buy-free / free-spin cascade ("盘面掉了"): replay the recorded feature frames
      // from a dedicated cursor so it never desyncs the base-spin ladder above.
      if (request.cmd === 40006 && freeSpins.hasData) {
        const frame = freeSpins.trigger();
        if (frame) {
          return [{ buffer: frame, source: "freespin-trigger" }];
        }
      }
      if (request.cmd === 40004 && freeSpins.hasData) {
        const step = freeSpins.nextCascade();
        if (step) {
          return [{
            buffer: step.frame,
            source: "freespin-cascade",
            datasetIndex: step.datasetIndex ?? step.index,
            datasetCount: step.datasetCount ?? step.count,
            winAmount: step.winAmount,
            originalRoundWin: step.originalRoundWin
          }];
        }
      }
      if (request.cmd === 40002) {
        const boardIndex = boards.length ? spinIndex % boards.length : -1;
        spinIndex += 1;
        if (baseBetFrame) {
          return [{
            buffer: baseBetFrame,
            source: "winladder-base",
            datasetIndex: 0,
            datasetCount: WIN_LADDER_AMOUNTS.length,
            boardIndex
          }];
        }
        const winIndex = spinIndex % WIN_LADDER_AMOUNTS.length;
        const winAmount = WIN_LADDER_AMOUNTS[winIndex];
        const board = boards.length ? boards[spinIndex % boards.length] : undefined;
        const built = buildWinFrame(winAmount, spinIndex, winIndex, board);
        return [{ buffer: built.buffer, source: "winladder", datasetIndex: winIndex, datasetCount: WIN_LADDER_AMOUNTS.length, winAmount, boardIndex }];
      }

      return replay.nextResponsesForClientFrame(input).map((buffer) => ({
        buffer,
        source: "har"
      }));
    }
  };
}

function encodeGameFrame(cmd, payload) {
  const frame = Buffer.alloc(12 + payload.length);
  frame.writeUInt32BE(frame.length - 4, 0);
  frame.writeUInt32BE(cmd >>> 0, 4);
  frame.writeUInt32BE(0, 8);
  payload.copy(frame, 12);
  return frame;
}

function encodeMsgRotate(rotate) {
  return Buffer.concat([
    encodeVarintField(1, rotate.originalStatus),
    encodeVarintField(2, rotate.status),
    encodeStringField(3, rotate.seq),
    encodeVarintField(4, rotate.coin),
    encodeVarintField(5, rotate.betMulti),
    encodeVarintField(6, rotate.betCoin),
    encodePackedInt32Field(8, rotate.drawResult),
    encodePackedInt32Field(9, rotate.topResult),
    encodePackedInt32Field(10, rotate.buttomResult),
    ...rotate.lines.map((line) => encodeLengthDelimited(11, encodeLineReward(line))),
    encodePackedInt32Field(12, rotate.gameNumList),
    encodeVarintField(13, rotate.gameNum),
    encodePackedInt32Field(14, rotate.goldToWildPos),
    encodeVarintField(15, rotate.roundScore),
    encodeVarintField(16, rotate.totalWin),
    encodeVarintField(17, rotate.roundWin),
    encodeVarintField(19, rotate.freeAppend),
    encodeVarintField(20, rotate.freeTotalWin),
    encodeVarintField(21, rotate.freeRemainCount),
    encodeVarintField(22, rotate.freeMaxCount),
    encodePackedInt32Field(23, rotate.triggerDraw || []),
    encodeVarintField(24, rotate.triggerWin || 0),
    encodePackedInt32Field(25, rotate.triggerTopResult || []),
    encodePackedInt32Field(26, rotate.triggerButtomResult || [])
  ].filter((buffer) => buffer.length));
}

function encodeLineReward(line) {
  return Buffer.concat([
    encodeVarintField(1, line.iconId),
    encodeVarintField(2, line.axleId),
    encodeVarintField(3, line.lineNum),
    encodeVarintField(4, line.score),
    encodeVarintField(5, line.multi),
    encodeVarintField(6, line.odds)
  ]);
}

function scaleLineScores(lines, targetTotal) {
  const normalizedTotal = Math.max(0, Number(targetTotal) || 0);
  const sourceTotal = lines.reduce((sum, line) => sum + (Number(line.score) || 0), 0);
  if (!lines.length || sourceTotal <= 0) {
    return [];
  }

  let allocated = 0;
  return lines.map((line, index) => {
    const isLast = index === lines.length - 1;
    const score = isLast
      ? normalizedTotal - allocated
      : Math.max(1, Math.round((normalizedTotal * line.score) / sourceTotal));
    allocated += score;
    return {
      ...line,
      score
    };
  });
}

function decodeLineReward(payload) {
  const line = {};
  for (const field of readFields(payload)) {
    if (field.field === 1) line.iconId = Number(field.value);
    else if (field.field === 2) line.axleId = Number(field.value);
    else if (field.field === 3) line.lineNum = Number(field.value);
    else if (field.field === 4) line.score = Number(field.value);
    else if (field.field === 5) line.multi = Number(field.value);
    else if (field.field === 6) line.odds = Number(field.value);
  }
  return line;
}

function encodeVarintField(field, value) {
  if (value === undefined || value === null) {
    return Buffer.alloc(0);
  }
  return Buffer.concat([encodeVarint(BigInt(field << 3)), encodeVarint(BigInt(value))]);
}

function encodeStringField(field, value) {
  return encodeLengthDelimited(field, Buffer.from(String(value || ""), "utf8"));
}

function encodePackedInt32Field(field, values = []) {
  if (!values.length) {
    return Buffer.alloc(0);
  }
  return encodeLengthDelimited(field, Buffer.concat(values.map((value) => encodeVarint(BigInt(value)))));
}

function encodeLengthDelimited(field, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([encodeVarint(BigInt((field << 3) | 2)), encodeVarint(BigInt(bytes.length)), bytes]);
}

function encodeVarint(input) {
  let value = BigInt(input);
  const bytes = [];
  while (value >= 0x80n) {
    bytes.push(Number((value & 0x7fn) | 0x80n));
    value >>= 7n;
  }
  bytes.push(Number(value));
  return Buffer.from(bytes);
}

function readFields(input) {
  const buffer = Buffer.from(input);
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === 0) {
      const value = readVarint(buffer, offset);
      offset = value.next;
      fields.push({ field, wire, value: value.value });
    } else if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.next;
      const end = offset + Number(length.value);
      fields.push({ field, wire, value: buffer.subarray(offset, end) });
      offset = end;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire} at field ${field}`);
    }
  }
  return fields;
}

function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    cursor += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, next: cursor };
    }
    shift += 7n;
  }
  throw new Error("Invalid protobuf varint");
}

function decodePackedInts(field) {
  if (field.wire === 0) {
    return [Number(field.value)];
  }
  const values = [];
  const buffer = field.value;
  let offset = 0;
  while (offset < buffer.length) {
    const value = readVarint(buffer, offset);
    values.push(Number(value.value));
    offset = value.next;
  }
  return values;
}

export async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function resetDir(targetPath) {
  await rm(targetPath, { recursive: true, force: true });
  await mkdir(targetPath, { recursive: true });
}

export async function writeJson(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function inferContentType(localPath) {
  const ext = path.extname(localPath).toLowerCase();
  const types = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp3": "audio/mpeg",
    ".ttf": "application/octet-stream",
    ".bin": "application/octet-stream"
  };
  return types[ext] || "application/octet-stream";
}

function debugPayload(type, frame) {
  return {
    type,
    cmd: frame.cmd,
    rawCmd: frame.rawCmd,
    connectionIndex: frame.connectionIndex,
    messageIndex: frame.messageIndex,
    sourceTime: frame.time,
    rawFrameBase64: frame.rawFrameBase64,
    decodedJson: null
  };
}

function countBy(items, keyFn) {
  const result = {};
  for (const item of items) {
    const key = keyFn(item) || "unknown";
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function buildCoverageConfig() {
  return [
    "game: boya-mahjong2",
    "engine: cocos",
    "bundle: dy_mjlltwo_en",
    "protocol: websocket-protobuf-raw-replay",
    "scenarios:",
    "  - id: boya-mj2-enter",
    "    fileIndex: 0",
    "    cmd: 40001",
    "    expectedType: enter",
    "  - id: boya-mj2-normal-bet-001",
    "    fileIndex: 1",
    "    cmd: 40003",
    "    expectedType: normal-bet",
    ""
  ].join("\n");
}
