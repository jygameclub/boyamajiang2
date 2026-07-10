import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { openLocalStore } from "../../tools/local/server/database.mjs";

const rawFrames = JSON.parse(await readFile("debugserver-data/boya-mahjong2/raw-frames.json", "utf8"));

function encodeVarint(value) {
  let current = BigInt(value);
  const bytes = [];
  while (current >= 0x80n) {
    bytes.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }
  bytes.push(Number(current));
  return Buffer.from(bytes);
}

function varintField(field, value) {
  return Buffer.concat([encodeVarint(field << 3), encodeVarint(value)]);
}

function frame(cmd, payload) {
  const result = Buffer.alloc(12 + payload.length);
  result.writeUInt32BE(result.length - 4, 0);
  result.writeUInt32BE(cmd, 4);
  payload.copy(result, 12);
  return result;
}

function listRequest(offset = 0, length = 20) {
  return frame(20047, Buffer.concat([
    varintField(1, 103),
    varintField(2, offset),
    varintField(3, length),
    varintField(4, 0)
  ]));
}

function detailRequest(betId) {
  return frame(20051, varintField(1, betId));
}

function sampleStep(stepNo, cmd, roundWin, totalWin) {
  return {
    stepNo,
    cmd,
    board: [101, 19, 3, 5, 7, 19, 9, 11, 13, 15, 19, 17, 3, 5, 7, 9, 11, 13, 15, 17, 101, 3, 5, 7, 9],
    topResult: [3, 5, 7, 9, 11],
    buttomResult: [5, 7, 9, 11, 13],
    lines: roundWin ? [{ iconId: 19, axleId: 2, lineNum: 1, score: roundWin, multi: 1, odds: 1 }] : [],
    multiplier: 1,
    roundWin,
    totalWin,
    freeRemain: 0,
    goldToWild: []
  };
}

test("hall history returns current live SQLite rounds and their local details", async () => {
  const historyModule = await import("../../tools/local/server/hall-history-responder.mjs").catch(() => null);
  assert.ok(historyModule, "hall history responder must exist");
  const {
    createHallHistoryResponder,
    decodeHallHistoryDetailResponse,
    decodeHallHistoryListResponse
  } = historyModule;
  const store = openLocalStore(":memory:");
  const user1 = store.getOrCreateUser("user1");
  const user2 = store.getOrCreateUser("user2");
  const session = store.createSession({
    mode: "live",
    seed: "history",
    configId: store.getActiveConfig().id,
    userId: user1.id
  });
  const base = store.recordRound({
    sessionId: session.id,
    roundNo: 1,
    kind: "base",
    bet: 2000,
    totalWin: 5000,
    outcome: "small",
    source: "weighted",
    seed: "base",
    validationStatus: "ok",
    steps: [sampleStep(0, 40003, 5000, 5000)]
  });
  const buy = store.recordRound({
    sessionId: session.id,
    roundNo: 2,
    kind: "buy",
    buyCost: 160000,
    totalWin: 0,
    outcome: "feature",
    source: "weighted",
    seed: "buy",
    validationStatus: "ok",
    steps: [sampleStep(0, 40007, 0, 0)]
  });
  store.recordRound({
    sessionId: session.id,
    roundNo: 3,
    kind: "free-feature",
    totalWin: 10000,
    outcome: "small",
    source: "weighted-free",
    seed: "free",
    validationStatus: "ok",
    steps: [sampleStep(0, 40005, 10000, 10000)]
  });
  const user2Session = store.createSession({
    mode: "live",
    seed: "history-user2",
    configId: store.getActiveConfig().id,
    userId: user2.id
  });
  const user2Round = store.recordRound({
    sessionId: user2Session.id,
    roundNo: 1,
    kind: "base",
    bet: 400,
    totalWin: 0,
    outcome: "miss",
    source: "weighted",
    seed: "user2-base",
    validationStatus: "ok",
    steps: [sampleStep(0, 40003, 0, 0)]
  });
  const responder = createHallHistoryResponder({
    rawFrames,
    connectionIndex: 0,
    mode: "live",
    store,
    token: "user1"
  });

  const listInfo = responder.nextResponsesForClientFrame(listRequest())[0];
  const list = decodeHallHistoryListResponse(listInfo.buffer);
  assert.equal(list.gameId, 103);
  assert.equal(list.records.length, 2);
  assert.deepEqual(
    list.records.map((record) => ({ betId: record.betId, bet: record.betCoins, profit: record.profit })),
    [
      { betId: buy.id, bet: 160000, profit: -150000 },
      { betId: base.id, bet: 2000, profit: 3000 }
    ]
  );

  const detailInfo = responder.nextResponsesForClientFrame(detailRequest(base.id))[0];
  const detail = decodeHallHistoryDetailResponse(detailInfo.buffer);
  assert.equal(detail.betId, base.id);
  assert.equal(detail.details.length, 1);
  assert.equal(detail.details[0].betId, base.id);
  assert.equal(detail.details[0].data.betMult, 100);
  assert.equal(detail.details[0].data.betCoin, 2000);
  assert.equal(detail.details[0].data.roundWin, 5000);
  assert.ok(Number.isInteger(detail.details[0].data.startTime));
  assert.ok(detail.details[0].data.startTime > 0);
  assert.deepEqual(detail.details[0].data.Lines, sampleStep(0, 40003, 5000, 5000).lines);
  const foreignDetail = decodeHallHistoryDetailResponse(
    responder.nextResponsesForClientFrame(detailRequest(user2Round.id))[0].buffer
  );
  assert.equal(foreignDetail.details.length, 0);
  responder.close();
  store.close();
});
