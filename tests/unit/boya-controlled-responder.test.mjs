import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decodeBoyaRotateFromPayload, parseFrameBase64 } from "../../tools/lib/boya-har.mjs";
import { createControlledResponder } from "../../tools/local/server/controlled-responder.mjs";
import { openLocalStore } from "../../tools/local/server/database.mjs";

const rawFrames = JSON.parse(await readFile("debugserver-data/boya-mahjong2/raw-frames.json", "utf8"));
const spinRequest = Buffer.from(
  rawFrames.connections[1].messages.find((entry) => entry.type === "send" && entry.cmd === 40002).rawFrameBase64,
  "base64"
);
const buyRequest = Buffer.from(
  rawFrames.connections[1].messages.find((entry) => entry.type === "send" && entry.cmd === 40006).rawFrameBase64,
  "base64"
);
const freeRequest = Buffer.from(
  rawFrames.connections[1].messages.find((entry) => entry.type === "send" && entry.cmd === 40004).rawFrameBase64,
  "base64"
);

function decodeResponse(info) {
  return decodeBoyaRotateFromPayload(parseFrameBase64(info.buffer).payload);
}

test("test responder cycles formula-correct small scenarios and persists the round", () => {
  const store = openLocalStore(":memory:");
  const responder = createControlledResponder({
    rawFrames,
    connectionIndex: 1,
    mode: "test",
    store,
    seed: "test-session"
  });
  const win = decodeResponse(responder.nextResponsesForClientFrame(spinRequest)[0]);
  const settle = decodeResponse(responder.nextResponsesForClientFrame(spinRequest)[0]);
  const nextWin = decodeResponse(responder.nextResponsesForClientFrame(spinRequest)[0]);

  assert.equal(win.roundWin, 100);
  assert.equal(win.lines.reduce((sum, line) => sum + line.score, 0), 100);
  assert.equal(win.drawResult[0], 101);
  assert.equal(win.drawResult[20], 101);
  assert.equal(settle.roundWin, 0);
  assert.equal(settle.totalWin, 100);
  assert.equal(nextWin.roundWin, 200);
  assert.equal(store.listRounds({ limit: 10 }).length, 2);
  assert.equal(store.getTestState().cursor, 2);
  responder.close("test-done");
  store.close();
});

test("live responder applies the active reel and outcome weights", () => {
  const store = openLocalStore(":memory:");
  const active = store.getActiveConfig();
  const payload = structuredClone(active.payload);
  payload.modes.base.outcomeWeights = { miss: 1, small: 0, medium: 0, big: 0, mega: 0, super: 0 };
  const reelSymbols = [3, 5, 7, 9, 11];
  for (const phase of ["initial", "cascade"]) {
    payload.modes.base[phase].goldRateByReel = [0, 0, 0, 0, 0];
    payload.modes.base[phase].symbolWeights = reelSymbols.map((symbol) => ({ [symbol]: 1 }));
  }
  store.activateConfig(store.createDraft("forced-miss", payload).id);
  const responder = createControlledResponder({
    rawFrames,
    connectionIndex: 1,
    mode: "live",
    store,
    seed: "live-session"
  });
  const result = responder.nextResponsesForClientFrame(spinRequest)[0];
  const rotate = decodeResponse(result);
  assert.equal(rotate.lines.length, 0);
  assert.equal(rotate.roundWin, 0);
  assert.equal(result.source, "weighted");
  assert.equal(store.listRounds({ limit: 1 })[0].source, "weighted");
  responder.close("test-done");
  store.close();
});

test("live responder can force a formula-correct medium win with per-reel weights", () => {
  const store = openLocalStore(":memory:");
  const payload = structuredClone(store.getActiveConfig().payload);
  payload.modes.base.outcomeWeights = { miss: 0, small: 0, medium: 1, big: 0, mega: 0, super: 0 };
  payload.modes.base.scatterCap = 0;
  payload.modes.base.initial.goldRateByReel = [0, 0, 0, 0, 0];
  payload.modes.base.initial.symbolWeights = [19, 19, 19, 3, 5].map((symbol) => ({ [symbol]: 1 }));
  payload.modes.base.cascade.goldRateByReel = [0, 0, 0, 0, 0];
  payload.modes.base.cascade.symbolWeights = [3, 5, 7, 9, 11].map((symbol) => ({ [symbol]: 1 }));
  store.activateConfig(store.createDraft("forced-medium", payload).id);
  const responder = createControlledResponder({
    rawFrames,
    connectionIndex: 1,
    mode: "live",
    store,
    seed: "forced-medium-session"
  });
  const winInfo = responder.nextResponsesForClientFrame(spinRequest)[0];
  const win = decodeResponse(winInfo);
  const terminal = decodeResponse(responder.nextResponsesForClientFrame(spinRequest)[0]);

  assert.equal(winInfo.source, "weighted");
  assert.equal(win.roundWin, 2000);
  assert.equal(win.lines.length, 1);
  assert.equal(win.lines[0].iconId, 19);
  assert.equal(win.lines[0].lineNum, 100);
  assert.equal(win.lines[0].score, 2000);
  assert.equal(terminal.roundWin, 0);
  assert.equal(store.listRounds({ limit: 1 })[0].outcome, "medium");
  responder.close("test-done");
  store.close();
});

test("route-and-cascade test suite sends gold-to-Wild and its next winning route", () => {
  const store = openLocalStore(":memory:");
  store.updateTestState({
    suiteKey: "route-and-cascade",
    scenarioKey: "cascade-gold-to-wild",
    cursor: 0,
    cycle: true
  });
  const responder = createControlledResponder({
    rawFrames,
    connectionIndex: 1,
    mode: "test",
    store,
    seed: "route-session"
  });
  const first = decodeResponse(responder.nextResponsesForClientFrame(spinRequest)[0]);
  const second = decodeResponse(responder.nextResponsesForClientFrame(spinRequest)[0]);
  const terminal = decodeResponse(responder.nextResponsesForClientFrame(spinRequest)[0]);

  assert.ok(first.goldToWildPos.length > 0);
  assert.ok(second.drawResult.includes(2));
  assert.ok(second.lines.length > 0);
  assert.equal(second.lines[0].multi, 2);
  assert.equal(terminal.lines.length, 0);
  assert.equal(store.listRounds({ limit: 1 })[0].scenarioKey, "cascade-gold-to-wild");
  responder.close("test-done");
  store.close();
});

test("buy-free test scenarios use exact scatter-to-free-count mapping", () => {
  for (const [scatterCount, freeCount] of [[3, 10], [4, 12], [5, 14], [6, 15]]) {
    const store = openLocalStore(":memory:");
    store.updateTestState({
      suiteKey: "buyfree-ladder",
      scenarioKey: `buyfree-scatter${scatterCount}`,
      cursor: scatterCount - 3,
      cycle: true
    });
    const responder = createControlledResponder({
      rawFrames,
      connectionIndex: 1,
      mode: "test",
      store,
      seed: `buy-${scatterCount}`
    });
    const trigger = decodeResponse(responder.nextResponsesForClientFrame(buyRequest)[0]);
    assert.equal(trigger.drawResult.filter((symbol) => symbol === 1).length, scatterCount);
    assert.equal(trigger.freeAppend, freeCount);
    assert.equal(trigger.freeRemainCount, freeCount);
    assert.equal(trigger.freeMaxCount, freeCount);
    assert.equal(trigger.betCoin, 32000);
    const firstFree = decodeResponse(responder.nextResponsesForClientFrame(freeRequest)[0]);
    assert.equal(firstFree.freeRemainCount, freeCount - 1);
    assert.equal(firstFree.freeMaxCount, freeCount);
    const frames = [firstFree];
    const expectedResponses = 23 + (freeCount - 10);
    while (frames.length < expectedResponses) {
      frames.push(decodeResponse(responder.nextResponsesForClientFrame(freeRequest)[0]));
    }
    assert.equal(frames.at(-1).freeRemainCount, 0);
    assert.equal(frames.at(-1).freeMaxCount, freeCount);
    responder.close("test-done");
    store.close();
  }
});

test("test buy-free replay orders complete free spins from misses to the largest win", () => {
  const store = openLocalStore(":memory:");
  store.updateTestState({
    suiteKey: "buyfree-ladder",
    scenarioKey: "buyfree-scatter4",
    cursor: 1,
    cycle: true
  });
  const responder = createControlledResponder({
    rawFrames,
    connectionIndex: 1,
    mode: "test",
    store,
    seed: "buy-ascending"
  });
  responder.nextResponsesForClientFrame(buyRequest);
  const frames = Array.from({ length: 25 }, () => (
    decodeResponse(responder.nextResponsesForClientFrame(freeRequest)[0])
  ));
  const groups = [];
  for (const frame of frames) {
    const remain = Number(frame.freeRemainCount || 0);
    if (!groups.length || groups.at(-1).remain !== remain) groups.push({ remain, frames: [] });
    groups.at(-1).frames.push(frame);
  }
  const spinTotals = groups.map((group) => group.frames.at(-1).totalWin || 0);

  assert.equal(groups.length, 12);
  assert.deepEqual(spinTotals, [0, 0, 0, 0, 0, 0, 0, 0, 560, 1280, 5360, 14560]);
  assert.ok(spinTotals.every((total, index) => index === 0 || total >= spinTotals[index - 1]));
  assert.equal(groups.at(-1).remain, 0);
  responder.close("test-done");
  store.close();
});

test("live buy-free uses active free-mode reel and outcome weights", () => {
  const store = openLocalStore(":memory:");
  const payload = structuredClone(store.getActiveConfig().payload);
  payload.modes.buy.scatterWeights = { scatter3: 1, scatter4: 0, scatter5: 0, scatter6plus: 0 };
  payload.modes.free.outcomeWeights = { miss: 1, small: 0, medium: 0, big: 0, mega: 0, super: 0 };
  payload.modes.free.scatterCap = 0;
  for (const phase of ["initial", "cascade"]) {
    payload.modes.free[phase].goldRateByReel = [0, 0, 100, 0, 0];
    payload.modes.free[phase].symbolWeights = [3, 5, 7, 9, 11].map((symbol) => ({ [symbol]: 1 }));
  }
  store.activateConfig(store.createDraft("forced-free-miss", payload).id);
  const responder = createControlledResponder({
    rawFrames,
    connectionIndex: 1,
    mode: "live",
    store,
    seed: "live-free-weights"
  });
  const trigger = decodeResponse(responder.nextResponsesForClientFrame(buyRequest)[0]);
  assert.equal(trigger.freeRemainCount, 10);
  const responses = Array.from({ length: 10 }, () => responder.nextResponsesForClientFrame(freeRequest)[0]);
  const spins = responses.map(decodeResponse);

  assert.ok(responses.every((response) => response.source === "weighted-free"));
  assert.ok(spins.every((spin) => spin.lines.length === 0 && spin.roundWin === 0));
  assert.ok(spins.every((spin) => spin.drawResult[1] === 3));
  assert.ok(spins.every((spin) => spin.drawResult[5] === 5));
  assert.ok(spins.every((spin) => spin.drawResult[10] === 8));
  assert.ok(spins.every((spin) => spin.drawResult[15] === 9));
  assert.ok(spins.every((spin) => spin.drawResult[21] === 11));
  assert.equal(spins.at(-1).freeRemainCount, 0);
  assert.equal(store.listRounds({ limit: 1 })[0].source, "weighted-free");
  responder.close("test-done");
  store.close();
});
