import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_MULTIPLIERS,
  BOYA_PAYTABLE,
  FREE_MULTIPLIERS,
  PLAYABLE_INDEXES,
  freeSpinCountForScatter,
  multiplierForCascade
} from "../../tools/local/engine/constants.mjs";
import { cascadeBoard } from "../../tools/local/engine/cascade-engine.mjs";
import { DEFAULT_CONTROL_CONFIG } from "../../tools/local/engine/default-config.mjs";
import { generateBoard, generateBuffers } from "../../tools/local/engine/board-generator.mjs";
import { generateLiveRound } from "../../tools/local/engine/outcome-selector.mjs";
import { createSeededRng, weightedChoice } from "../../tools/local/engine/rng.mjs";
import { buildRoundPlan } from "../../tools/local/engine/round-engine.mjs";
import {
  createRouteAndCascadeScenarios,
  createSmallWinScenarios
} from "../../tools/local/engine/scenarios.mjs";
import { validateStep } from "../../tools/local/engine/validator.mjs";
import { calculateWays } from "../../tools/local/engine/ways-calculator.mjs";

test("Boya constants keep the verified board and free-spin rules", () => {
  assert.equal(PLAYABLE_INDEXES.length, 23);
  assert.ok(!PLAYABLE_INDEXES.includes(0));
  assert.ok(!PLAYABLE_INDEXES.includes(20));
  assert.deepEqual(BOYA_PAYTABLE[17], [1, 3, 6]);
  assert.deepEqual(BASE_MULTIPLIERS, [1, 2, 3, 5]);
  assert.deepEqual(FREE_MULTIPLIERS, [2, 4, 6, 10]);
  assert.equal(freeSpinCountForScatter(2), 0);
  assert.equal(freeSpinCountForScatter(3), 10);
  assert.equal(freeSpinCountForScatter(4), 12);
  assert.equal(freeSpinCountForScatter(5), 14);
  assert.equal(freeSpinCountForScatter(6), 15);
  assert.equal(freeSpinCountForScatter(7), 16);
  assert.equal(multiplierForCascade(7, "base"), 5);
  assert.equal(multiplierForCascade(7, "free"), 10);
});

test("seeded RNG is reproducible and weighted choice respects zero weights", () => {
  const first = createSeededRng("same-seed");
  const second = createSeededRng("same-seed");
  assert.deepEqual(
    Array.from({ length: 8 }, () => first.nextUint32()),
    Array.from({ length: 8 }, () => second.nextUint32())
  );
  assert.equal(weightedChoice(first, [[3, 0], [17, 10], [19, 0]]), 17);
});

test("Ways calculation reuses Wild across symbols like the recorded Boya frames", () => {
  const board = [
    101, 13, 19, 7, 19,
    13, 19, 2, 9, 17,
    13, 19, 2, 7, 17,
    13, 19, 9, 7, 17,
    101, 11, 15, 3, 5
  ];
  const result = calculateWays(board, { betMulti: 20, multiplier: 2 });
  const icon13 = result.lines.find((line) => line.iconId === 13);
  const icon19 = result.lines.find((line) => line.iconId === 19);

  assert.ok(icon13);
  assert.ok(icon19);
  assert.ok(icon13.lineNum > 0);
  assert.ok(icon19.lineNum > 0);
  assert.ok(result.eliminationPositions.includes(7));
  assert.ok(result.eliminationPositions.includes(12));
  assert.equal(result.roundWin, result.lines.reduce((sum, line) => sum + line.score, 0));
});

test("gold matches its base symbol and becomes Wild instead of being removed", () => {
  const board = [
    101, 17, 3, 5, 7,
    18, 9, 11, 13, 15,
    17, 3, 5, 7, 9,
    17, 11, 13, 15, 19,
    101, 3, 5, 7, 9
  ];
  const result = calculateWays(board, { betMulti: 20, multiplier: 1 });
  const line = result.lines.find((entry) => entry.iconId === 17);
  assert.ok(line);
  assert.ok(result.goldToWildPositions.includes(5));
  assert.ok(!result.eliminationPositions.includes(5));

  const next = cascadeBoard(board, result, {
    nextSymbol: (reel) => [3, 5, 7, 9, 11][reel]
  });
  assert.ok(next.board.includes(2));
  assert.equal(next.board[0], 101);
  assert.equal(next.board[20], 101);
});

test("small-win scenarios derive 1/2/3/5/6/8 amounts from legal Ways", () => {
  const scenarios = createSmallWinScenarios({ betMulti: 20 });
  assert.deepEqual(scenarios.map((scenario) => scenario.amount), [100, 200, 300, 500, 600, 800]);

  for (const scenario of scenarios) {
    const result = calculateWays(scenario.board, { betMulti: 20, multiplier: 1 });
    assert.equal(result.lines.length, 1, scenario.key);
    assert.equal(result.roundWin, scenario.amount, scenario.key);
    assert.deepEqual(
      result.lines.map(({ iconId, axleId, lineNum, odds, multi, score }) => ({ iconId, axleId, lineNum, odds, multi, score })),
      [scenario.expectedLine],
      scenario.key
    );
    assert.doesNotThrow(() => validateStep({
      board: scenario.board,
      lines: result.lines,
      roundWin: result.roundWin,
      totalWin: result.roundWin,
      betMulti: 20,
      mode: "base",
      cascadeIndex: 0,
      gameNum: 1,
      gameNumList: BASE_MULTIPLIERS
    }));
  }
});

test("validator rejects a display amount that does not equal the board formula", () => {
  const [scenario] = createSmallWinScenarios({ betMulti: 20 });
  const result = calculateWays(scenario.board, { betMulti: 20, multiplier: 1 });
  assert.throws(() => validateStep({
    board: scenario.board,
    lines: result.lines,
    roundWin: result.roundWin + 100,
    totalWin: result.roundWin + 100,
    betMulti: 20,
    mode: "base",
    cascadeIndex: 0,
    gameNum: 1,
    gameNumList: BASE_MULTIPLIERS
  }), /PAYOUT_FORMULA_MISMATCH/);
});

test("weighted board generation keeps sentinels and never generates Wild directly", () => {
  const rng = createSeededRng("forced-board");
  const weightsByReel = Array.from({ length: 5 }, () => ({ 17: 1 }));
  const board = generateBoard({
    rng,
    weightsByReel,
    goldRateByReel: [0, 0, 100, 0, 0],
    mode: "free",
    scatterCap: 0
  });
  assert.equal(board[0], 101);
  assert.equal(board[20], 101);
  assert.ok(board.every((symbol) => symbol !== 2));
  for (const row of [0, 1, 2, 3, 4]) assert.equal(board[10 + row], 18);
  assert.deepEqual(generateBuffers({ rng, weightsByReel, goldRateByReel: [0, 0, 100, 0, 0], mode: "free" }).topResult.length, 5);
});

test("round plan preserves the formula through a winning step and a legal terminal drop", () => {
  const [scenario] = createSmallWinScenarios({ betMulti: 20 });
  const plan = buildRoundPlan({
    initialBoard: scenario.board,
    initialBuffers: { topResult: scenario.fillerByReel, buttomResult: scenario.fillerByReel },
    betMulti: 20,
    betCoin: 400,
    mode: "base",
    maxCascades: 4,
    nextSymbol: (reel) => scenario.fillerByReel[reel]
  });
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].roundWin, 100);
  assert.equal(plan.steps[1].roundWin, 0);
  assert.equal(plan.totalWin, 100);
  for (const step of plan.steps) assert.doesNotThrow(() => validateStep(step));
});

test("winning frame exposes the symbols that refill its following cascade", () => {
  const scenario = createRouteAndCascadeScenarios({ betMulti: 20, betCoin: 400 })
    .find((entry) => entry.key === "cascade-limit-terminal");
  const plan = buildRoundPlan({
    initialBoard: scenario.initialBoard,
    initialBuffers: scenario.initialBuffers,
    betMulti: 20,
    betCoin: 400,
    mode: "base",
    maxCascades: scenario.maxCascades,
    nextSymbol: scenario.createNextSymbol()
  });

  assert.deepEqual(plan.steps[0].topResult.slice(0, 3), [7, 7, 7]);
  assert.deepEqual(plan.steps[1].topResult.slice(0, 3), [3, 5, 11]);
});

test("route-and-cascade catalog covers routes, multi-line, Wild, gold, and the cascade limit", () => {
  const scenarios = createRouteAndCascadeScenarios({ betMulti: 20, betCoin: 400 });
  assert.ok(scenarios.length >= 28);
  assert.equal(new Set(scenarios.map((scenario) => scenario.key)).size, scenarios.length);

  const plans = Object.fromEntries(scenarios.map((scenario) => {
    const plan = buildRoundPlan({
      initialBoard: scenario.initialBoard,
      initialBuffers: scenario.initialBuffers,
      betMulti: 20,
      betCoin: 400,
      mode: "base",
      maxCascades: scenario.maxCascades,
      nextSymbol: scenario.createNextSymbol()
    });
    plan.steps.forEach((step) => assert.doesNotThrow(() => validateStep(step), scenario.key));
    const winningSteps = plan.steps.filter((step) => step.lines.length);
    assert.ok(scenario.expect, `${scenario.key} must declare expectations`);
    assert.equal(winningSteps.length, scenario.expect.winSteps, scenario.key);
    assert.deepEqual(winningSteps.map((step) => step.gameNum), scenario.expect.multipliers, scenario.key);
    assert.ok(
      Math.max(...plan.steps.map((step) => step.board.filter((symbol) => symbol === 2).length))
        >= (scenario.expect.minPeakWild || 0),
      scenario.key
    );
    assert.equal(
      plan.steps.some((step) => step.goldToWildPositions.length > 0),
      Boolean(scenario.expect.goldToWild),
      scenario.key
    );
    assert.equal(
      plan.steps[0].board.filter((symbol) => symbol === 1).length,
      scenario.expect.scatterCount || 0,
      scenario.key
    );
    assert.ok(
      plan.steps.every((step) => step.board.filter((symbol) => symbol === 1).length <= 2),
      `${scenario.key} must not trigger free spins`
    );
    assert.equal(plan.steps.at(-1).lines.length, 0, `${scenario.key} terminal step`);
    return [scenario.key, plan];
  }));

  assert.equal(plans["route-near-miss"].totalWin, 0);
  assert.equal(plans["route-zigzag-single"].steps[0].lines.length, 1);
  assert.ok(plans["route-multi-ways"].steps[0].lines[0].lineNum > 1);
  assert.equal(plans["route-five-axes"].steps[0].lines[0].axleId, 4);
  assert.equal(plans["route-multi-icon"].steps[0].lines.length, 2);
  assert.deepEqual(
    plans["cascade-two-win-steps"].steps.filter((step) => step.lines.length).map((step) => step.gameNum),
    [1, 2]
  );
  assert.deepEqual(
    plans["cascade-four-win-steps"].steps.filter((step) => step.lines.length).map((step) => step.gameNum),
    [1, 2, 3, 5]
  );
  assert.ok(plans["cascade-gold-to-wild"].steps[0].goldToWildPositions.length > 0);
  assert.ok(plans["cascade-gold-to-wild"].steps[1].board.includes(2));
  assert.ok(plans["cascade-wild-next-eliminate"].steps[1].eliminationPositions.some((index) => (
    plans["cascade-wild-next-eliminate"].steps[1].board[index] === 2
  )));
  assert.equal(plans["route-wild-reuse"].steps[0].lines.length, 2);
  assert.equal(plans["route-multiple-wild-same-line"].steps[0].lines.length, 1);
  assert.equal(plans["route-multiple-wild-same-line"].steps[0].lines[0].iconId, 13);
  assert.equal(plans["cascade-refill-win"].steps.filter((step) => step.lines.length).length, 2);
  assert.equal(plans["cascade-limit-terminal"].cascadeLimitHit, true);
  assert.equal(plans["cascade-limit-terminal"].steps.at(-1).roundWin, 0);
});

test("default control config has complete mode/reel weights", () => {
  for (const mode of ["base", "free", "buy"]) {
    for (const phase of ["initial", "cascade"]) {
      assert.equal(DEFAULT_CONTROL_CONFIG.modes[mode][phase].symbolWeights.length, 5);
    }
  }
});

test("free-mode fallback stays in the requested outcome band with the x2 opening multiplier", () => {
  const config = structuredClone(DEFAULT_CONTROL_CONFIG);
  config.modes.free.outcomeWeights = { miss: 0, small: 0, medium: 1, big: 0, mega: 0, super: 0 };
  config.modes.free.initial.goldRateByReel = [0, 0, 100, 0, 0];
  config.modes.free.initial.symbolWeights = [3, 5, 7, 9, 11].map((symbol) => ({ [symbol]: 1 }));
  config.modes.free.cascade.goldRateByReel = [0, 0, 100, 0, 0];
  config.modes.free.cascade.symbolWeights = [3, 5, 7, 9, 11].map((symbol) => ({ [symbol]: 1 }));

  const generated = generateLiveRound({
    config,
    seed: "free-medium-fallback",
    betMulti: 20,
    betCoin: 400,
    mode: "free",
    maxAttempts: 1
  });

  assert.equal(generated.targetOutcome, "medium");
  assert.equal(generated.outcome, "medium");
  assert.equal(generated.source, "template-fallback");
  assert.ok(generated.plan.totalWin >= 2000 && generated.plan.totalWin < 4000);
});
