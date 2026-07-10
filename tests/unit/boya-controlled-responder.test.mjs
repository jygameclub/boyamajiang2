import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  decodeBoyaEnterBalanceFromPayload,
  decodeBoyaRotateFromPayload,
  parseFrameBase64
} from "../../tools/lib/boya-har.mjs";
import { createControlledResponder } from "../../tools/local/server/controlled-responder.mjs";
import { openLocalStore } from "../../tools/local/server/database.mjs";
import { PLAYABLE_INDEXES } from "../../tools/local/engine/constants.mjs";
import { calculateWays } from "../../tools/local/engine/ways-calculator.mjs";
import { createRouteAndCascadeScenarios } from "../../tools/local/engine/scenarios.mjs";

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
const enterRequest = Buffer.from(
  rawFrames.connections[1].messages.find((entry) => entry.type === "send" && entry.cmd === 40000).rawFrameBase64,
  "base64"
);

function requestWithBet(cmd, betMult) {
  const payload = Buffer.from([0x08, betMult]);
  const frame = Buffer.alloc(12 + payload.length);
  frame.writeUInt32BE(frame.length - 4, 0);
  frame.writeUInt32BE(cmd, 4);
  payload.copy(frame, 12);
  return frame;
}

function decodeResponse(info) {
  return decodeBoyaRotateFromPayload(parseFrameBase64(info.buffer).payload);
}

function protocolLines(lines) {
  return lines.map(({ iconId, axleId, lineNum, score, multi, odds }) => ({
    iconId,
    axleId,
    lineNum,
    score,
    multi,
    odds
  }));
}

test("every deterministic route remains formula-correct after protobuf compilation", () => {
  for (const scenario of createRouteAndCascadeScenarios()) {
    const initialScatterCount = scenario.initialBoard.filter((symbol) => symbol === 1).length;
    assert.equal(initialScatterCount, scenario.expect.scatterCount ?? 0, scenario.key);
    assert.ok(initialScatterCount <= 2, `${scenario.key} must not trigger free spins`);
    const store = openLocalStore(":memory:");
    store.updateTestState({
      suiteKey: "route-and-cascade",
      scenarioKey: scenario.key,
      cursor: 0,
      cycle: true
    });
    const responder = createControlledResponder({
      rawFrames,
      connectionIndex: 1,
      mode: "test",
      store,
      seed: `compiled-${scenario.key}`
    });
    const decoded = [];
    for (let step = 0; step < 12; step += 1) {
      const rotate = decodeResponse(responder.nextResponsesForClientFrame(spinRequest)[0]);
      const calculated = calculateWays(rotate.drawResult, {
        betMulti: rotate.betMulti,
        multiplier: rotate.gameNum,
        mode: "base",
        cascadeIndex: step
      });
      assert.deepEqual(protocolLines(rotate.lines), protocolLines(calculated.lines), scenario.key);
      assert.equal(rotate.roundWin, calculated.roundWin, scenario.key);
      decoded.push(rotate);
      if (!rotate.lines.length) break;
    }
    assert.equal(decoded.filter((rotate) => rotate.lines.length).length, scenario.expect.winSteps, scenario.key);
    assert.equal(decoded.at(-1).lines.length, 0, scenario.key);
    responder.close("test-done");
    store.close();
  }
});

test("live responder starts from and persists the selected local user balance", () => {
  const store = openLocalStore(":memory:");
  const payload = structuredClone(store.getActiveConfig().payload);
  payload.modes.base.outcomeWeights = { miss: 1, small: 0, medium: 0, big: 0, mega: 0, super: 0 };
  payload.modes.base.scatterCap = 0;
  for (const phase of ["initial", "cascade"]) {
    payload.modes.base[phase].goldRateByReel = [0, 0, 0, 0, 0];
    payload.modes.base[phase].symbolWeights = [3, 5, 7, 9, 11].map((symbol) => ({ [symbol]: 1 }));
  }
  store.activateConfig(store.createDraft("user-miss", payload).id);
  const user = store.getOrCreateUser("user1");
  const responder = createControlledResponder({
    rawFrames,
    connectionIndex: 1,
    mode: "live",
    store,
    user,
    seed: "user-balance"
  });

  const enter = responder.nextResponsesForClientFrame(enterRequest)[0];
  assert.equal(decodeBoyaEnterBalanceFromPayload(parseFrameBase64(enter.buffer).payload), 100_000_000);
  const spin = decodeResponse(responder.nextResponsesForClientFrame(spinRequest)[0]);
  assert.equal(spin.coin, 99_999_600);
  assert.equal(store.getUser("user1").balance, 99_999_600);
  assert.equal(store.listRounds({ token: "user1" }).length, 1);
  responder.close("test-done");
  store.close();
});

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

test("controlled responder uses the bet multiplier carried by each normal-spin request", () => {
  const store = openLocalStore(":memory:");
  const responder = createControlledResponder({
    rawFrames,
    connectionIndex: 1,
    mode: "test",
    store,
    seed: "dynamic-bet"
  });
  const selectedBetRequest = requestWithBet(40002, 100);
  const win = decodeResponse(responder.nextResponsesForClientFrame(selectedBetRequest)[0]);
  const settle = decodeResponse(responder.nextResponsesForClientFrame(selectedBetRequest)[0]);
  const history = store.listRounds({ limit: 1 })[0];

  assert.equal(win.betMulti, 100);
  assert.equal(win.betCoin, 2000);
  assert.equal(win.roundWin, 500);
  assert.equal(win.lines.reduce((sum, line) => sum + line.score, 0), 500);
  assert.equal(settle.betMulti, 100);
  assert.equal(settle.betCoin, 2000);
  assert.equal(history.bet, 2000);
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

test("live purchase uses the request bet and randomizes the weighted trigger board", () => {
  const store = openLocalStore(":memory:");
  const payload = structuredClone(store.getActiveConfig().payload);
  payload.modes.buy.scatterWeights = { scatter3: 1, scatter4: 0, scatter5: 0, scatter6plus: 0 };
  store.activateConfig(store.createDraft("forced-three-scatter", payload).id);
  const responder = createControlledResponder({
    rawFrames,
    connectionIndex: 1,
    mode: "live",
    store,
    seed: "random-trigger-board"
  });
  const trigger = decodeResponse(responder.nextResponsesForClientFrame(requestWithBet(40006, 100))[0]);
  const positions = trigger.drawResult
    .map((symbol, index) => symbol === 1 ? index : null)
    .filter((index) => index !== null);

  assert.equal(trigger.betMulti, 100);
  assert.equal(trigger.betCoin, 160000);
  assert.equal(trigger.freeRemainCount, 10);
  assert.equal(positions.length, 3);
  assert.notDeepEqual(positions, [3, 6, 12]);
  assert.ok(!positions.includes(0) && !positions.includes(20));
  const firstFree = decodeResponse(responder.nextResponsesForClientFrame(freeRequest)[0]);
  assert.equal(firstFree.betMulti, 100);
  assert.equal(firstFree.betCoin, 2000);
  responder.close("test-done");
  store.close();
});

test("live purchase reads newly activated scatter weights without reconnecting", () => {
  const store = openLocalStore(":memory:");
  const initial = structuredClone(store.getActiveConfig().payload);
  initial.modes.buy.scatterWeights = { scatter3: 1, scatter4: 0, scatter5: 0, scatter6plus: 0 };
  store.activateConfig(store.createDraft("initial-three", initial).id);
  const responder = createControlledResponder({
    rawFrames,
    connectionIndex: 1,
    mode: "live",
    store,
    seed: "hot-config"
  });
  const updated = structuredClone(initial);
  updated.modes.buy.scatterWeights = { scatter3: 0, scatter4: 1, scatter5: 0, scatter6plus: 0 };
  store.activateConfig(store.createDraft("updated-four", updated).id);

  const trigger = decodeResponse(responder.nextResponsesForClientFrame(buyRequest)[0]);
  assert.equal(trigger.drawResult.filter((symbol) => symbol === 1).length, 4);
  assert.equal(trigger.freeRemainCount, 12);
  responder.close("test-done");
  store.close();
});

test("live purchase applies buy initial reel weights to non-scatter trigger symbols", () => {
  const store = openLocalStore(":memory:");
  const payload = structuredClone(store.getActiveConfig().payload);
  payload.modes.buy.scatterWeights = { scatter3: 1, scatter4: 0, scatter5: 0, scatter6plus: 0 };
  payload.modes.buy.initial.goldRateByReel = [0, 0, 100, 0, 0];
  payload.modes.buy.initial.symbolWeights = [3, 5, 7, 9, 11].map((symbol) => ({ [symbol]: 1 }));
  store.activateConfig(store.createDraft("forced-buy-reels", payload).id);
  const responder = createControlledResponder({
    rawFrames,
    connectionIndex: 1,
    mode: "live",
    store,
    seed: "buy-reel-weights"
  });

  const trigger = decodeResponse(responder.nextResponsesForClientFrame(buyRequest)[0]);
  const expectedByReel = [3, 5, 8, 9, 11];
  for (const index of PLAYABLE_INDEXES) {
    const reel = Math.floor(index / 5);
    assert.ok(
      trigger.drawResult[index] === 1 || trigger.drawResult[index] === expectedByReel[reel],
      `index ${index} on reel ${reel} must use the configured symbol`
    );
  }

  responder.close("test-done");
  store.close();
});

test("live purchase applies buy cascade reel weights to trigger buffers", () => {
  const store = openLocalStore(":memory:");
  const payload = structuredClone(store.getActiveConfig().payload);
  payload.modes.buy.scatterWeights = { scatter3: 1, scatter4: 0, scatter5: 0, scatter6plus: 0 };
  payload.modes.buy.cascade.goldRateByReel = [0, 0, 100, 0, 0];
  payload.modes.buy.cascade.symbolWeights = [19, 17, 15, 13, 11].map((symbol) => ({ [symbol]: 1 }));
  store.activateConfig(store.createDraft("forced-buy-buffers", payload).id);
  const responder = createControlledResponder({
    rawFrames,
    connectionIndex: 1,
    mode: "live",
    store,
    seed: "buy-buffer-weights"
  });

  const trigger = decodeResponse(responder.nextResponsesForClientFrame(buyRequest)[0]);
  assert.deepEqual(trigger.topResult, [19, 17, 16, 13, 11]);
  assert.deepEqual(trigger.buttomResult, [19, 17, 16, 13, 11]);

  responder.close("test-done");
  store.close();
});

test("live round history records the config version activated for that round", () => {
  const store = openLocalStore(":memory:");
  const responder = createControlledResponder({
    rawFrames,
    connectionIndex: 1,
    mode: "live",
    store,
    seed: "round-config-version"
  });
  const payload = structuredClone(store.getActiveConfig().payload);
  payload.modes.base.outcomeWeights = { miss: 1, small: 0, medium: 0, big: 0, mega: 0, super: 0 };
  payload.modes.base.scatterCap = 0;
  for (const phase of ["initial", "cascade"]) {
    payload.modes.base[phase].goldRateByReel = [0, 0, 0, 0, 0];
    payload.modes.base[phase].symbolWeights = [3, 5, 7, 9, 11].map((symbol) => ({ [symbol]: 1 }));
  }
  const activated = store.activateConfig(store.createDraft("round-config", payload).id);

  responder.nextResponsesForClientFrame(spinRequest);

  assert.equal(store.listRounds({ limit: 1 })[0].configId, activated.id);
  responder.close("test-done");
  store.close();
});
