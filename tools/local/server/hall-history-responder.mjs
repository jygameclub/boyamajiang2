import { gunzipSync, gzipSync } from "node:zlib";

import {
  createBoyaRotateFrameFromTemplate,
  createConnectionReplay,
  createGeneratedHeartbeatFrame,
  decodeBoyaRotateFromPayload,
  parseFrameBase64
} from "../../lib/boya-har.mjs";
import { BASE_MULTIPLIERS, FREE_MULTIPLIERS } from "../engine/constants.mjs";

const GAME_ID = 103;
const BASE_RATE = 20;
const UINT64_SIZE = 1n << 64n;

function encodeVarint(input) {
  let value = BigInt(input);
  if (value < 0n) value = UINT64_SIZE + value;
  const bytes = [];
  while (value >= 0x80n) {
    bytes.push(Number((value & 0x7fn) | 0x80n));
    value >>= 7n;
  }
  bytes.push(Number(value));
  return Buffer.from(bytes);
}

function encodeVarintField(field, value) {
  return Buffer.concat([encodeVarint(field << 3), encodeVarint(Math.trunc(Number(value) || 0))]);
}

function encodeLengthDelimited(field, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(bytes.length), bytes]);
}

function encodeStringField(field, value) {
  return encodeLengthDelimited(field, Buffer.from(String(value ?? ""), "utf8"));
}

function readVarint(buffer, start) {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buffer.length) {
    const byte = buffer[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: offset };
    shift += 7n;
  }
  throw new Error("Invalid history protobuf varint");
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
      fields.push({ field, wire, value: value.value });
      offset = value.next;
    } else if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.next;
      const end = offset + Number(length.value);
      fields.push({ field, wire, value: buffer.subarray(offset, end) });
      offset = end;
    } else {
      throw new Error(`Unsupported history protobuf wire type ${wire}`);
    }
  }
  return fields;
}

function signedNumber(value) {
  return Number(value >= (1n << 63n) ? value - UINT64_SIZE : value);
}

function decodedPayload(input) {
  const parsed = parseFrameBase64(input);
  return parsed.compressed ? gunzipSync(parsed.payload) : parsed.payload;
}

function encodeFrame(cmd, payload) {
  const compressed = gzipSync(Buffer.from(payload));
  const frame = Buffer.alloc(12 + compressed.length);
  frame.writeUInt32BE(frame.length - 4, 0);
  frame.writeUInt32BE((cmd | 0x80000000) >>> 0, 4);
  compressed.copy(frame, 12);
  return frame;
}

function requestValues(input) {
  return Object.fromEntries(readFields(decodedPayload(input)).map((field) => [field.field, Number(field.value)]));
}

function encodeHistoryRecord(record) {
  return Buffer.concat([
    encodeVarintField(1, record.betId),
    encodeStringField(2, record.gameNo),
    encodeVarintField(3, record.time),
    encodeVarintField(4, record.betCoins),
    encodeVarintField(5, record.profit),
    encodeVarintField(6, record.bTime),
    encodeVarintField(7, record.gameType),
    encodeVarintField(8, record.volatilityNum),
    encodeVarintField(9, record.betType),
    encodeVarintField(10, record.isVolatility)
  ]);
}

function encodePlaybackRecord(record) {
  return Buffer.concat([
    encodeVarintField(1, record.id),
    encodeStringField(2, record.cardgameNo),
    encodeStringField(3, record.betCoin),
    encodeVarintField(4, record.totalAmount),
    encodeVarintField(5, record.endTime),
    encodeStringField(6, record.url),
    encodeVarintField(7, record.betId),
    encodeVarintField(8, record.gameType)
  ]);
}

function historyRows(store, mode, token) {
  const rounds = store.listRounds({ limit: 1000, mode, token });
  const freeByBuy = new Map();
  for (const round of rounds) {
    if (round.kind === "free-feature") {
      freeByBuy.set(`${round.sessionId}:${round.roundNo - 1}`, round);
    }
  }
  return rounds.flatMap((round) => {
    if (round.kind !== "base" && round.kind !== "buy") return [];
    const free = round.kind === "buy"
      ? freeByBuy.get(`${round.sessionId}:${round.roundNo}`)
      : null;
    const timestamp = Math.floor(Date.parse(round.createdAt) / 1000);
    const betCoins = round.kind === "buy" ? round.buyCost : round.bet;
    const totalWin = round.kind === "buy" ? Number(free?.totalWin || 0) : round.totalWin;
    const detail = round.kind === "buy" ? store.getRound(round.id) : null;
    return [{
      betId: round.id,
      gameNo: `${GAME_ID}-${timestamp}-${round.id}-1`,
      time: timestamp,
      betCoins,
      profit: totalWin - betCoins,
      bTime: timestamp,
      gameType: GAME_ID,
      volatilityNum: detail?.steps?.[0]?.freeRemain || 0,
      betType: round.kind === "buy" ? 3 : 1,
      isVolatility: 0
    }];
  });
}

function playbackRows(store, mode, token) {
  const rounds = store.listRounds({ limit: 1000, mode, token });
  const freeByBuy = new Map();
  for (const round of rounds) {
    if (round.kind === "free-feature") {
      freeByBuy.set(`${round.sessionId}:${round.roundNo - 1}`, round);
    }
  }
  return rounds.flatMap((round) => {
    if (round.kind !== "base" && round.kind !== "buy") return [];
    const free = round.kind === "buy"
      ? freeByBuy.get(`${round.sessionId}:${round.roundNo}`)
      : null;
    const totalAmount = round.kind === "buy" ? Number(free?.totalWin || 0) : Number(round.totalWin || 0);
    if (totalAmount <= 0) return [];
    const endTime = Math.floor(Date.parse(free?.createdAt || round.createdAt) / 1000);
    const betCoin = round.kind === "buy" ? round.buyCost : round.bet;
    return [{
      id: round.id,
      cardgameNo: `${GAME_ID}-${endTime}-${round.id}-1`,
      betCoin: String(betCoin),
      totalAmount,
      endTime,
      url: `?playid=local-${round.id}&t=MTAz`,
      betId: round.id,
      gameType: round.kind === "buy" ? 3 : 1
    }];
  });
}

function detailData(round, step, detailIndex, kind = round.kind) {
  const purchase = kind === "buy" || kind === "free-feature";
  const free = kind === "free-feature";
  const betMulti = round.betMulti || Math.round((round.bet || round.buyCost / 80 || 400) / BASE_RATE);
  const startTime = Math.floor(Date.parse(round.createdAt) / 1000);
  return {
    seq: `local-history-${round.id}-${detailIndex + 1}`,
    startTime,
    oriStatus: free ? 1 : 0,
    status: free ? 1 : 0,
    coin: round.balanceAfter,
    oc: round.balanceBefore,
    betMult: betMulti,
    betCoin: kind === "buy" ? round.buyCost : round.bet,
    purchase,
    buy: kind === "buy",
    dr: step.board,
    topResult: step.topResult,
    buttomResult: step.buttomResult,
    Lines: step.lines,
    gameNum: step.multiplier,
    roundScore: step.roundWin,
    totalWin: step.totalWin,
    roundWin: step.roundWin,
    bFree: free || kind === "buy",
    freeAdd: kind === "buy" ? step.freeRemain : 0,
    freeRemainCount: step.freeRemain,
    freeMaxCount: kind === "buy" ? step.freeRemain : 0,
    triggerFree: kind === "buy",
    goldToWildPos: step.goldToWild,
    round: detailIndex + 1
  };
}

function detailRows(store, mode, betId, token) {
  const parent = store.getRound(betId, { token });
  if (!parent || parent.mode !== mode) return [];
  const sourceRounds = [{ round: parent, kind: parent.kind }];
  if (parent.kind === "buy") {
    const free = store.listRounds({ limit: 1000, mode, token }).find((round) => (
      round.kind === "free-feature"
      && round.sessionId === parent.sessionId
      && round.roundNo === parent.roundNo + 1
    ));
    if (free) sourceRounds.push({ round: store.getRound(free.id), kind: "free-feature" });
  }
  const details = [];
  for (const source of sourceRounds) {
    for (const step of source.round.steps) {
      const data = detailData(source.round, step, details.length, source.kind);
      details.push({
        betId: source.round.id,
        detail: gzipSync(Buffer.from(JSON.stringify(data), "utf8")).toString("base64")
      });
    }
  }
  return details;
}

function encodeListResponse(store, mode, token, input) {
  const fields = requestValues(input);
  const offset = Math.max(0, fields[2] || 0);
  const length = Math.max(1, Math.min(100, fields[3] || 20));
  const records = historyRows(store, mode, token).slice(offset, offset + length);
  const payload = Buffer.concat([
    encodeVarintField(1, GAME_ID),
    ...records.map((record) => encodeLengthDelimited(2, encodeHistoryRecord(record)))
  ]);
  return encodeFrame(20048, payload);
}

function encodeDetailResponse(store, mode, token, input) {
  const betId = requestValues(input)[1] || 0;
  const details = detailRows(store, mode, betId, token);
  const payload = Buffer.concat([
    encodeVarintField(1, betId),
    ...details.map((detail) => encodeLengthDelimited(2, Buffer.concat([
      encodeVarintField(1, detail.betId),
      encodeStringField(2, detail.detail)
    ])))
  ]);
  return encodeFrame(20052, payload);
}

function encodePlaybackListResponse(store, mode, token, input) {
  const fields = requestValues(input);
  const page = Math.max(1, fields[2] || 1);
  const length = Math.max(1, Math.min(100, fields[3] || 75));
  const offset = (page - 1) * length;
  const records = playbackRows(store, mode, token).slice(offset, offset + length);
  return encodeFrame(20050, Buffer.concat(
    records.map((record) => encodeLengthDelimited(1, encodePlaybackRecord(record)))
  ));
}

function recordedFrames(rawFrames, cmd) {
  const gameConnection = rawFrames?.connections?.[1]?.messages || [];
  const local = gameConnection.filter((message) => message.type === "receive" && message.cmd === cmd);
  const selected = local.length
    ? local
    : (rawFrames?.frames || []).filter((message) => message.type === "receive" && message.cmd === cmd);
  return selected.map((message) => Buffer.from(message.rawFrameBase64, "base64"));
}

function decodedRotate(frame) {
  return decodeBoyaRotateFromPayload(parseFrameBase64(frame).payload);
}

function baseReplayFrames(rawFrames, round) {
  const template = recordedFrames(rawFrames, 40003)[0];
  if (!template) return [];
  const betMulti = Number(round.betMulti || Math.round(round.bet / BASE_RATE) || 1);
  const balanceAfterBet = round.balanceBefore - round.bet;
  return round.steps.map((step, index) => createBoyaRotateFrameFromTemplate(template, {
    cmd: 40003,
    omitFreeFields: true,
    rotate: {
      originalStatus: 0,
      status: 0,
      seq: `local-replay-${round.id}-${index + 1}`,
      coin: index === round.steps.length - 1 ? round.balanceAfter : balanceAfterBet,
      betMulti,
      betCoin: round.bet,
      purchase: false,
      drawResult: step.board,
      topResult: step.topResult,
      buttomResult: step.buttomResult,
      lines: step.lines,
      gameNumList: BASE_MULTIPLIERS,
      gameNum: step.multiplier,
      goldToWildPos: step.goldToWild,
      roundScoreSigned: round.totalWin - round.bet,
      totalWin: step.totalWin,
      roundWin: step.roundWin
    }
  }));
}

function buyTriggerReplayFrame(rawFrames, round) {
  const template = recordedFrames(rawFrames, 40007)[0];
  if (!template || !round.steps.length) return null;
  const shell = decodedRotate(template);
  const step = round.steps[0];
  const betMulti = Number(round.betMulti || Math.round((round.buyCost / 80) / BASE_RATE) || 1);
  return createBoyaRotateFrameFromTemplate(template, {
    cmd: 40007,
    rotate: {
      ...shell,
      seq: `local-replay-buy-${round.id}`,
      coin: round.balanceAfter,
      betMulti,
      betCoin: round.buyCost,
      purchase: true,
      drawResult: step.board,
      topResult: step.topResult,
      buttomResult: step.buttomResult,
      lines: step.lines,
      gameNumList: BASE_MULTIPLIERS,
      gameNum: step.multiplier,
      goldToWildPos: step.goldToWild,
      roundScoreSigned: -round.buyCost,
      totalWin: 0,
      roundWin: 0,
      bFree: true,
      freeAppend: step.freeRemain,
      freeTotalWin: 0,
      freeRemainCount: step.freeRemain,
      freeMaxCount: step.freeRemain
    }
  });
}

function freeReplayFrames(rawFrames, round, freeMaxCount) {
  const templates = recordedFrames(rawFrames, 40005).map((template) => ({
    template,
    rotate: decodedRotate(template)
  }));
  if (!templates.length) return [];
  const finalShell = templates.at(-1);
  const maxCount = Math.max(1, Number(freeMaxCount) || Math.max(...round.steps.map((step) => step.freeRemain)) + 1);
  let completedWin = 0;
  return round.steps.map((step, index) => {
    const next = round.steps[index + 1];
    const spinComplete = !next || next.freeRemain !== step.freeRemain;
    const featureComplete = index === round.steps.length - 1;
    const shell = featureComplete
      ? finalShell
      : templates.find((candidate) => (
        Boolean(candidate.rotate.lines.length) === Boolean(step.lines.length)
        && (!step.lines.length || candidate.rotate.gameNum === step.multiplier)
      )) || templates.find((candidate) => Boolean(candidate.rotate.lines.length) === Boolean(step.lines.length)) || finalShell;
    const freeTotalWin = completedWin + step.totalWin;
    const buffer = createBoyaRotateFrameFromTemplate(shell.template, {
      cmd: 40005,
      rotate: {
        ...shell.rotate,
        originalStatus: featureComplete ? finalShell.rotate.originalStatus : 1,
        status: featureComplete ? finalShell.rotate.status : 1,
        seq: `local-replay-free-${round.id}-${index + 1}`,
        coin: round.balanceBefore + freeTotalWin,
        betMulti: Number(round.betMulti || Math.round(round.bet / BASE_RATE) || 1),
        betCoin: round.bet,
        purchase: true,
        drawResult: step.board,
        topResult: step.topResult,
        buttomResult: step.buttomResult,
        lines: step.lines,
        gameNumList: FREE_MULTIPLIERS,
        gameNum: step.multiplier,
        goldToWildPos: step.goldToWild,
        roundScoreSigned: spinComplete ? step.totalWin : undefined,
        totalWin: step.totalWin,
        roundWin: step.roundWin,
        bFree: featureComplete ? finalShell.rotate.bFree : true,
        freeAppend: 0,
        freeTotalWin,
        freeRemainCount: step.freeRemain,
        freeMaxCount: maxCount
      }
    });
    if (spinComplete) completedWin = freeTotalWin;
    return buffer;
  });
}

function playbackBundle(rawFrames, store, mode, token, roundId) {
  const round = store.getRound(roundId, { token });
  if (!round || round.mode !== mode) return null;
  if (round.kind === "base") {
    return {
      round,
      betCoin: round.bet,
      totalWin: round.totalWin,
      frames: baseReplayFrames(rawFrames, round)
    };
  }
  if (round.kind === "buy") {
    const freeSummary = store.listRounds({ limit: 1000, mode, token }).find((candidate) => (
      candidate.kind === "free-feature"
      && candidate.sessionId === round.sessionId
      && candidate.roundNo === round.roundNo + 1
    ));
    const freeRound = freeSummary ? store.getRound(freeSummary.id, { token }) : null;
    const trigger = buyTriggerReplayFrame(rawFrames, round);
    return {
      round,
      betCoin: round.buyCost,
      totalWin: Number(freeRound?.totalWin || 0),
      frames: [
        ...(trigger ? [trigger] : []),
        ...(freeRound ? freeReplayFrames(rawFrames, freeRound, round.steps[0]?.freeRemain) : [])
      ]
    };
  }
  if (round.kind === "free-feature") {
    return {
      round,
      betCoin: round.bet,
      totalWin: round.totalWin,
      frames: freeReplayFrames(rawFrames, round)
    };
  }
  return null;
}

function playbackId(input) {
  const fields = readFields(decodedPayload(input));
  const value = fields.find((field) => (field.field === 1 || field.field === 4) && field.wire === 2)?.value;
  const match = /^local-(\d+)$/.exec(value?.toString("utf8") || "");
  return match ? Number(match[1]) : null;
}

function encodePlaybackDataResponse(rawFrames, store, mode, token, input) {
  const bundle = playbackBundle(rawFrames, store, mode, token, playbackId(input));
  const totalWin = Number(bundle?.totalWin || 0);
  const betCoin = Number(bundle?.betCoin || 0);
  const payload = Buffer.concat([
    encodeVarintField(1, totalWin),
    encodeVarintField(2, GAME_ID),
    encodeVarintField(3, 0),
    encodeVarintField(4, betCoin),
    encodeVarintField(5, totalWin - betCoin),
    ...(bundle?.frames || []).map((frame) => encodeStringField(6, gzipSync(frame).toString("base64"))),
    encodeStringField(7, JSON.stringify({ BaseRate: BASE_RATE, BuyRate: 80, Buy1Rate: 80, Buy2Rate: 80 })),
    encodeStringField(8, "CNY")
  ]);
  return encodeFrame(70001, payload);
}

export function createHallHistoryResponder({ rawFrames, connectionIndex, mode, store, token }) {
  const replay = createConnectionReplay(rawFrames, connectionIndex);
  return {
    mode,
    get cursor() {
      return replay.cursor;
    },
    nextResponsesForClientFrame(input) {
      const request = parseFrameBase64(input);
      if (request.cmd === 5000) {
        return [{ buffer: createGeneratedHeartbeatFrame(), source: "heartbeat" }];
      }
      if (request.cmd === 20152) {
        return [{ buffer: encodeFrame(20153, Buffer.alloc(0)), source: "local-activity-hub" }];
      }
      if (request.cmd === 20047) {
        return [{ buffer: encodeListResponse(store, mode, token, input), source: "sqlite-history-list" }];
      }
      if (request.cmd === 20051) {
        return [{ buffer: encodeDetailResponse(store, mode, token, input), source: "sqlite-history-detail" }];
      }
      if (request.cmd === 20049) {
        return [{ buffer: encodePlaybackListResponse(store, mode, token, input), source: "sqlite-playback-list" }];
      }
      if (request.cmd === 70000) {
        return [{ buffer: encodePlaybackDataResponse(rawFrames, store, mode, token, input), source: "sqlite-playback-data" }];
      }
      return replay.nextResponsesForClientFrame(input).map((buffer) => ({ buffer, source: "har" }));
    },
    close() {}
  };
}

export function decodeHallHistoryListResponse(input) {
  const fields = readFields(decodedPayload(input));
  const records = fields.filter((field) => field.field === 2).map((field) => {
    const values = Object.fromEntries(readFields(field.value).map((entry) => [entry.field, entry.value]));
    return {
      betId: Number(values[1]),
      gameNo: Buffer.from(values[2]).toString("utf8"),
      time: Number(values[3]),
      betCoins: signedNumber(values[4]),
      profit: signedNumber(values[5]),
      bTime: Number(values[6]),
      gameType: Number(values[7]),
      volatilityNum: signedNumber(values[8]),
      betType: signedNumber(values[9]),
      isVolatility: signedNumber(values[10])
    };
  });
  return {
    gameId: Number(fields.find((field) => field.field === 1)?.value || 0),
    records
  };
}

export function decodeHallHistoryDetailResponse(input) {
  const fields = readFields(decodedPayload(input));
  const details = fields.filter((field) => field.field === 2).map((field) => {
    const values = Object.fromEntries(readFields(field.value).map((entry) => [entry.field, entry.value]));
    const compressed = Buffer.from(Buffer.from(values[2]).toString("utf8"), "base64");
    return {
      betId: Number(values[1]),
      data: JSON.parse(gunzipSync(compressed).toString("utf8"))
    };
  });
  return {
    betId: Number(fields.find((field) => field.field === 1)?.value || 0),
    details
  };
}

export function decodeHallPlaybackListResponse(input) {
  const fields = readFields(decodedPayload(input));
  return {
    records: fields.filter((field) => field.field === 1).map((field) => {
      const values = Object.fromEntries(readFields(field.value).map((entry) => [entry.field, entry.value]));
      return {
        id: Number(values[1]),
        cardgameNo: Buffer.from(values[2]).toString("utf8"),
        betCoin: Buffer.from(values[3]).toString("utf8"),
        totalAmount: signedNumber(values[4]),
        endTime: Number(values[5]),
        url: Buffer.from(values[6]).toString("utf8"),
        betId: Number(values[7]),
        gameType: Number(values[8])
      };
    })
  };
}

export function decodeHallPlaybackDataResponse(input) {
  const fields = readFields(decodedPayload(input));
  const value = (field) => fields.find((entry) => entry.field === field)?.value;
  const frames = fields.filter((field) => field.field === 6).map((field) => {
    const frame = gunzipSync(Buffer.from(field.value.toString("utf8"), "base64"));
    const parsed = parseFrameBase64(frame);
    return {
      cmd: parsed.cmd,
      rotate: [40003, 40005, 40007].includes(parsed.cmd)
        ? decodeBoyaRotateFromPayload(parsed.payload)
        : null
    };
  });
  return {
    total: signedNumber(value(1) || 0n),
    gameId: Number(value(2) || 0),
    memberId: Number(value(3) || 0),
    betCoin: signedNumber(value(4) || 0n),
    winLose: signedNumber(value(5) || 0n),
    frames,
    baseConf: JSON.parse(Buffer.from(value(7) || "{}").toString("utf8")),
    currency: Buffer.from(value(8) || "").toString("utf8")
  };
}
