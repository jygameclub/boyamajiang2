import {
  createBoyaRotateFrameFromTemplate,
  createConnectionReplay,
  createGeneratedHeartbeatFrame,
  decodeBoyaRotateFromPayload,
  parseFrameBase64
} from "../../lib/boya-har.mjs";
import {
  BASE_MULTIPLIERS,
  FREE_MULTIPLIERS,
  PLAYABLE_INDEXES,
  freeSpinCountForScatter
} from "../engine/constants.mjs";
import { classifyOutcome, generateLiveRound } from "../engine/outcome-selector.mjs";
import { createSeededRng, weightedChoice } from "../engine/rng.mjs";
import { buildRoundPlan } from "../engine/round-engine.mjs";
import {
  createOutcomeFallbackScenario,
  createRouteAndCascadeScenarios,
  createSmallWinScenarios
} from "../engine/scenarios.mjs";

function findRecordedFrame(rawFrames, connectionIndex, cmd) {
  const local = rawFrames?.connections?.[connectionIndex]?.messages?.find(
    (message) => message.type === "receive" && message.cmd === cmd
  );
  const any = rawFrames?.frames?.find((message) => message.type === "receive" && message.cmd === cmd);
  const selected = local || any;
  if (!selected) throw new Error(`Missing recorded response frame ${cmd}`);
  return Buffer.from(selected.rawFrameBase64, "base64");
}

function groupRecordedFreeSpins(templates) {
  const frames = templates.map((template, index) => ({
    index,
    template,
    rotate: decodeBoyaRotateFromPayload(parseFrameBase64(template).payload)
  }));
  const groups = [];
  let previousRemain = Symbol("first");
  for (const frame of frames) {
    const remain = frame.rotate.freeRemainCount;
    if (!Object.is(remain, previousRemain)) {
      groups.push({ remain, frames: [] });
      previousRemain = remain;
    }
    groups.at(-1).frames.push(frame);
  }
  return groups.map((group) => ({
    ...group,
    totalWin: Number(group.frames.at(-1).rotate.totalWin || 0)
  }));
}

function selectFreeSpinGroups(groups, freeCount, mode) {
  const misses = groups.filter((group) => group.totalWin === 0);
  const wins = groups.filter((group) => group.totalWin > 0);
  if (!misses.length || wins.length > freeCount) throw new Error("Recorded free-spin groups cannot fill the feature");
  if (mode === "test") {
    const missCount = freeCount - wins.length;
    return [
      ...Array.from({ length: missCount }, (_, index) => misses[index % misses.length]),
      ...wins.toSorted((left, right) => left.totalWin - right.totalWin)
    ];
  }
  const extraMisses = Array.from({ length: Math.max(0, freeCount - groups.length) }, (_, index) => (
    misses[index % misses.length]
  ));
  return [...groups.slice(0, -1), ...extraMisses, groups.at(-1)].slice(0, freeCount);
}

function createTestPlan(store, betMulti, betCoin) {
  const state = store.getTestState();
  if (state.suiteKey === "route-and-cascade") {
    const routeScenarios = createRouteAndCascadeScenarios({ betMulti, betCoin });
    const fixed = state.scenarioKey
      ? routeScenarios.find((scenario) => scenario.key === state.scenarioKey)
      : null;
    const index = fixed ? routeScenarios.indexOf(fixed) : Math.max(0, state.cursor) % routeScenarios.length;
    const scenario = fixed || routeScenarios[index];
    if (!scenario) throw new Error(`Unknown test scenario ${state.scenarioKey}`);
    const nextCursor = state.cycle
      ? (index + 1) % routeScenarios.length
      : Math.min(index + 1, routeScenarios.length - 1);
    store.advanceTestCursor(nextCursor);
    const plan = buildRoundPlan({
      initialBoard: scenario.initialBoard,
      initialBuffers: scenario.initialBuffers,
      betMulti,
      betCoin,
      mode: "base",
      maxCascades: scenario.maxCascades,
      nextSymbol: scenario.createNextSymbol()
    });
    return {
      plan,
      source: "scenario",
      scenarioKey: scenario.key,
      datasetIndex: index,
      datasetCount: routeScenarios.length,
      outcome: classifyOutcome(plan.totalWin, betCoin)
    };
  }
  const scenarios = createSmallWinScenarios({ betMulti });
  if (state.suiteKey !== "base-small-ladder") {
    const scenario = createOutcomeFallbackScenario("miss", { betMulti, betCoin });
    return {
      plan: buildRoundPlan({
        initialBoard: scenario.board,
        initialBuffers: { topResult: scenario.fillerByReel, buttomResult: scenario.fillerByReel },
        betMulti,
        betCoin,
        mode: "base",
        maxCascades: 4,
        nextSymbol: (reel) => scenario.fillerByReel[reel]
      }),
      source: "scenario",
      scenarioKey: scenario.key,
      datasetIndex: 0,
      datasetCount: 1,
      outcome: "miss"
    };
  }
  const fixed = state.scenarioKey
    ? scenarios.find((scenario) => scenario.key === state.scenarioKey)
    : null;
  const index = fixed ? scenarios.indexOf(fixed) : Math.max(0, state.cursor) % scenarios.length;
  const scenario = fixed || scenarios[index];
  if (!scenario) throw new Error(`Unknown test scenario ${state.scenarioKey}`);
  const nextCursor = state.cycle
    ? (index + 1) % scenarios.length
    : Math.min(index + 1, scenarios.length - 1);
  store.advanceTestCursor(nextCursor);
  return {
    plan: buildRoundPlan({
      initialBoard: scenario.board,
      initialBuffers: {
        topResult: scenario.fillerByReel,
        buttomResult: scenario.fillerByReel
      },
      betMulti,
      betCoin,
      mode: "base",
      maxCascades: 4,
      nextSymbol: (reel) => scenario.fillerByReel[reel]
    }),
    source: "scenario",
    scenarioKey: scenario.key,
    datasetIndex: index,
    datasetCount: scenarios.length,
    outcome: "small"
  };
}

export function createControlledResponder({
  rawFrames,
  connectionIndex,
  mode,
  store,
  seed = `${Date.now()}`
}) {
  if (mode !== "test" && mode !== "live") throw new Error(`Unsupported controlled mode ${mode}`);
  const replay = createConnectionReplay(rawFrames, connectionIndex);
  const baseTemplate = findRecordedFrame(rawFrames, connectionIndex, 40003);
  const triggerTemplate = findRecordedFrame(rawFrames, connectionIndex, 40007);
  const freeTemplates = (rawFrames?.connections?.[connectionIndex]?.messages || [])
    .filter((message) => message.type === "receive" && message.cmd === 40005)
    .map((message) => Buffer.from(message.rawFrameBase64, "base64"));
  if (!freeTemplates.length) throw new Error("Missing recorded free-spin frames");
  const recordedFreeGroups = groupRecordedFreeSpins(freeTemplates);
  const freeShells = freeTemplates.map((template) => ({
    template,
    rotate: decodeBoyaRotateFromPayload(parseFrameBase64(template).payload)
  }));
  const baseRotate = decodeBoyaRotateFromPayload(parseFrameBase64(baseTemplate).payload);
  const triggerRotate = decodeBoyaRotateFromPayload(parseFrameBase64(triggerTemplate).payload);
  const activeConfig = store.getActiveConfig();
  const session = store.createSession({ mode, seed, configId: activeConfig.id });
  const betCoin = Number(baseRotate.betCoin || 400);
  const betMulti = Number(baseRotate.betMulti || 20);
  let balance = Number(baseRotate.coin || 100000000);
  let roundNo = 0;
  let pending = [];
  let pendingFree = [];
  let lastFreeResponse = null;
  let closed = false;

  function prepareBaseRound() {
    roundNo += 1;
    const roundSeed = `${seed}:base:${roundNo}`;
    const generated = mode === "test"
      ? createTestPlan(store, betMulti, betCoin)
      : generateLiveRound({
        config: activeConfig.payload,
        seed: roundSeed,
        betMulti,
        betCoin,
        mode: "base"
      });
    const plan = generated.plan;
    const balanceAfterBet = balance - betCoin;
    const finalBalance = balanceAfterBet + plan.totalWin;
    const round = store.recordRound({
      sessionId: session.id,
      roundNo,
      kind: "base",
      bet: betCoin,
      totalWin: plan.totalWin,
      outcome: generated.outcome || classifyOutcome(plan.totalWin, betCoin),
      source: generated.source,
      scenarioKey: generated.scenarioKey,
      seed: roundSeed,
      validationStatus: "ok",
      fallbackReason: generated.fallbackReason,
      steps: plan.steps.map((step, stepNo) => ({
        stepNo,
        cmd: 40003,
        board: step.board,
        topResult: step.topResult,
        buttomResult: step.buttomResult,
        lines: step.lines,
        multiplier: step.gameNum,
        roundWin: step.roundWin,
        totalWin: step.totalWin,
        freeRemain: 0,
        goldToWild: step.goldToWildPositions
      }))
    });
    pending = plan.steps.map((step, stepIndex) => {
      const terminal = stepIndex === plan.steps.length - 1;
      const coin = terminal ? finalBalance : balanceAfterBet;
      const buffer = createBoyaRotateFrameFromTemplate(baseTemplate, {
        cmd: 40003,
        omitFreeFields: true,
        rotate: {
          seq: `local-${session.id}-${roundNo}-${stepIndex + 1}`,
          coin,
          betMulti,
          betCoin,
          purchase: false,
          drawResult: step.board,
          topResult: step.topResult,
          buttomResult: step.buttomResult,
          lines: step.lines,
          gameNumList: step.gameNumList,
          gameNum: step.gameNum,
          goldToWildPos: step.goldToWildPositions,
          roundScoreSigned: plan.totalWin - betCoin,
          totalWin: step.totalWin,
          roundWin: step.roundWin
        }
      });
      return {
        buffer,
        source: generated.source,
        scenarioKey: generated.scenarioKey,
        datasetIndex: generated.datasetIndex,
        datasetCount: generated.datasetCount,
        targetOutcome: generated.targetOutcome,
        generationAttempts: generated.attempts,
        roundId: round.id,
        roundNo,
        stepIndex,
        winAmount: step.roundWin
      };
    });
    balance = finalBalance;
  }

  function selectScatterCount() {
    if (mode === "test") {
      const state = store.getTestState();
      if (state.suiteKey !== "buyfree-ladder") return 3;
      const fixed = /^buyfree-scatter(\d+)$/.exec(state.scenarioKey || "");
      if (fixed) return Math.max(3, Math.min(8, Number(fixed[1])));
      const counts = [3, 4, 5, 6];
      const index = Math.max(0, state.cursor) % counts.length;
      store.advanceTestCursor((index + 1) % counts.length);
      return counts[index];
    }
    const rng = createSeededRng(`${seed}:buy:${roundNo + 1}`);
    const selected = weightedChoice(rng, Object.entries(activeConfig.payload.modes.buy.scatterWeights));
    return selected === "scatter3" ? 3 : selected === "scatter4" ? 4 : selected === "scatter5" ? 5 : 6;
  }

  function createTriggerBoard(scatterCount) {
    const board = [...triggerRotate.drawResult];
    for (const index of PLAYABLE_INDEXES) {
      if (board[index] === 1 || board[index] === 2) board[index] = 19;
    }
    const positions = [3, 6, 12, 18, 24, 9, 14, 16];
    positions.slice(0, scatterCount).forEach((index) => { board[index] = 1; });
    board[0] = 101;
    board[20] = 101;
    return board;
  }

  function prepareRecordedFreeQueue({ freeCount, buyBalance, featureRoundNo }) {
    const selectedGroups = selectFreeSpinGroups(recordedFreeGroups, freeCount, mode);
    const finalShell = freeTemplates.at(-1);
    const finalState = decodeBoyaRotateFromPayload(parseFrameBase64(finalShell).payload);
    let cumulativeFeatureWin = 0;
    const responses = [];
    const historySteps = [];

    selectedGroups.forEach((group, spinIndex) => {
      const freeRemainCount = freeCount - spinIndex - 1;
      const finalSpin = spinIndex === selectedGroups.length - 1;
      group.frames.forEach((frame, frameIndex) => {
        const recorded = frame.rotate;
        const finalFrame = frameIndex === group.frames.length - 1;
        const featureExit = finalSpin && finalFrame;
        const completedWin = finalFrame ? group.totalWin : 0;
        const rotate = {
          ...recorded,
          originalStatus: featureExit ? finalState.originalStatus : 1,
          status: featureExit ? finalState.status : 1,
          seq: `local-free-${session.id}-${featureRoundNo}-${spinIndex + 1}-${frameIndex + 1}`,
          coin: buyBalance + cumulativeFeatureWin + completedWin,
          purchase: true,
          bFree: featureExit ? finalState.bFree : true,
          freeTotalWin: cumulativeFeatureWin + Number(recorded.totalWin || 0),
          freeRemainCount,
          freeMaxCount: freeCount
        };
        const template = featureExit ? finalShell : frame.template;
        const buffer = createBoyaRotateFrameFromTemplate(template, { cmd: 40005, rotate });
        responses.push({
          buffer,
          source: mode === "test" ? "recorded-free-ascending" : "recorded-free-template",
          roundNo: featureRoundNo,
          stepIndex: responses.length,
          winAmount: recorded.roundWin || 0
        });
        historySteps.push({
          stepNo: historySteps.length,
          cmd: 40005,
          board: rotate.drawResult,
          topResult: rotate.topResult,
          buttomResult: rotate.buttomResult,
          lines: rotate.lines,
          multiplier: rotate.gameNum,
          roundWin: rotate.roundWin || 0,
          totalWin: rotate.totalWin || 0,
          freeRemain: freeRemainCount,
          goldToWild: rotate.goldToWildPos || []
        });
      });
      cumulativeFeatureWin += group.totalWin;
    });

    const round = store.recordRound({
      sessionId: session.id,
      roundNo: featureRoundNo,
      kind: "free-feature",
      bet: 0,
      totalWin: cumulativeFeatureWin,
      outcome: classifyOutcome(cumulativeFeatureWin, betCoin),
      source: mode === "test" ? "recorded-free-ascending" : "recorded-free-template",
      scenarioKey: `buyfree-${freeCount}`,
      seed: `${seed}:free:${featureRoundNo}`,
      validationStatus: "ok",
      steps: historySteps
    });
    responses.forEach((response) => { response.roundId = round.id; });
    balance = buyBalance + cumulativeFeatureWin;
    pendingFree = responses;
    lastFreeResponse = responses.at(-1);
  }

  function prepareGeneratedFreeQueue({ freeCount, buyBalance, featureRoundNo }) {
    const finalShell = freeShells.at(-1);
    const missShell = freeShells.find((shell) => (
      !shell.rotate.lines.length
      && shell.rotate.roundScoreSigned === undefined
      && shell.rotate.freeRemainCount !== undefined
    ));
    const terminalShell = freeShells.find((shell) => (
      !shell.rotate.lines.length && shell.rotate.roundScoreSigned !== undefined
    ));
    if (!missShell || !terminalShell) throw new Error("Missing free-spin miss or terminal shell");

    const freeConfig = structuredClone(activeConfig.payload);
    freeConfig.modes.free.scatterCap = Math.min(2, Number(freeConfig.modes.free.scatterCap) || 0);
    const generatedSpins = Array.from({ length: freeCount }, (_, spinIndex) => generateLiveRound({
      config: freeConfig,
      seed: `${seed}:free:${featureRoundNo}:${spinIndex + 1}`,
      betMulti,
      betCoin,
      mode: "free"
    }));
    const responses = [];
    const historySteps = [];
    let cumulativeFeatureWin = 0;

    generatedSpins.forEach((generated, spinIndex) => {
      const freeRemainCount = freeCount - spinIndex - 1;
      const finalSpin = spinIndex === generatedSpins.length - 1;
      generated.plan.steps.forEach((step, stepIndex) => {
        const terminal = stepIndex === generated.plan.steps.length - 1;
        const featureExit = finalSpin && terminal;
        let shell;
        if (featureExit) {
          shell = finalShell;
        } else if (step.lines.length) {
          shell = freeShells.find((candidate) => (
            candidate.rotate.lines.length && candidate.rotate.gameNum === step.gameNum
          )) || freeShells.find((candidate) => candidate.rotate.lines.length);
        } else {
          shell = step.cascadeIndex === 0 ? missShell : terminalShell;
        }
        if (!shell) throw new Error(`Missing free-spin shell for multiplier ${step.gameNum}`);
        const rotate = {
          ...shell.rotate,
          originalStatus: featureExit ? finalShell.rotate.originalStatus : 1,
          status: featureExit ? finalShell.rotate.status : 1,
          seq: `local-live-free-${session.id}-${featureRoundNo}-${spinIndex + 1}-${stepIndex + 1}`,
          coin: buyBalance + cumulativeFeatureWin + (terminal ? generated.plan.totalWin : 0),
          betMulti,
          purchase: true,
          drawResult: step.board,
          topResult: step.topResult,
          buttomResult: step.buttomResult,
          lines: step.lines,
          gameNumList: step.gameNumList,
          gameNum: step.gameNum,
          goldToWildPos: step.goldToWildPositions,
          roundScoreSigned: terminal ? generated.plan.totalWin : undefined,
          totalWin: step.totalWin,
          roundWin: step.roundWin,
          bFree: featureExit ? finalShell.rotate.bFree : true,
          freeAppend: 0,
          freeTotalWin: cumulativeFeatureWin + step.totalWin,
          freeRemainCount,
          freeMaxCount: freeCount
        };
        const buffer = createBoyaRotateFrameFromTemplate(shell.template, { cmd: 40005, rotate });
        const source = generated.source === "weighted" ? "weighted-free" : "template-fallback-free";
        responses.push({
          buffer,
          source,
          roundNo: featureRoundNo,
          stepIndex: responses.length,
          winAmount: step.roundWin,
          targetOutcome: generated.targetOutcome,
          generationAttempts: generated.attempts
        });
        historySteps.push({
          stepNo: historySteps.length,
          cmd: 40005,
          board: step.board,
          topResult: step.topResult,
          buttomResult: step.buttomResult,
          lines: step.lines,
          multiplier: step.gameNum,
          roundWin: step.roundWin,
          totalWin: step.totalWin,
          freeRemain: freeRemainCount,
          goldToWild: step.goldToWildPositions
        });
      });
      cumulativeFeatureWin += generated.plan.totalWin;
    });

    const allWeighted = generatedSpins.every((generated) => generated.source === "weighted");
    const round = store.recordRound({
      sessionId: session.id,
      roundNo: featureRoundNo,
      kind: "free-feature",
      bet: 0,
      totalWin: cumulativeFeatureWin,
      outcome: classifyOutcome(cumulativeFeatureWin, betCoin),
      source: allWeighted ? "weighted-free" : "mixed-free",
      scenarioKey: "live-free-probability",
      seed: `${seed}:free:${featureRoundNo}`,
      validationStatus: "ok",
      fallbackReason: generatedSpins.find((generated) => generated.fallbackReason)?.fallbackReason,
      steps: historySteps
    });
    responses.forEach((response) => { response.roundId = round.id; });
    balance = buyBalance + cumulativeFeatureWin;
    pendingFree = responses;
    lastFreeResponse = responses.at(-1);
  }

  function prepareBuyFree() {
    roundNo += 1;
    const buyRoundNo = roundNo;
    const scatterCount = selectScatterCount();
    const freeCount = freeSpinCountForScatter(scatterCount);
    const buyCost = betCoin * Number(activeConfig.payload.buyCostMultiplier || 80);
    const buyBalance = balance - buyCost;
    const board = createTriggerBoard(scatterCount);
    const round = store.recordRound({
      sessionId: session.id,
      roundNo: buyRoundNo,
      kind: "buy",
      bet: 0,
      buyCost,
      totalWin: 0,
      outcome: "feature",
      source: mode === "test" ? "scenario" : "weighted",
      scenarioKey: `buyfree-scatter${scatterCount}`,
      seed: `${seed}:buy:${buyRoundNo}`,
      validationStatus: "ok",
      steps: [{
        stepNo: 0,
        cmd: 40007,
        board,
        topResult: triggerRotate.topResult,
        buttomResult: triggerRotate.buttomResult,
        lines: [],
        multiplier: 1,
        roundWin: 0,
        totalWin: 0,
        freeRemain: freeCount,
        goldToWild: []
      }]
    });
    const buffer = createBoyaRotateFrameFromTemplate(triggerTemplate, {
      cmd: 40007,
      rotate: {
        ...triggerRotate,
        seq: `local-buy-${session.id}-${buyRoundNo}`,
        coin: buyBalance,
        betMulti,
        betCoin: buyCost,
        purchase: true,
        drawResult: board,
        lines: [],
        gameNumList: BASE_MULTIPLIERS,
        gameNum: 1,
        goldToWildPos: [],
        roundScoreSigned: -buyCost,
        totalWin: 0,
        roundWin: 0,
        bFree: true,
        freeAppend: freeCount,
        freeTotalWin: 0,
        freeRemainCount: freeCount,
        freeMaxCount: freeCount
      }
    });
    balance = buyBalance;
    const featureRoundNo = buyRoundNo + 1;
    if (mode === "live") {
      prepareGeneratedFreeQueue({ freeCount, buyBalance, featureRoundNo });
    } else {
      prepareRecordedFreeQueue({ freeCount, buyBalance, featureRoundNo });
    }
    roundNo = featureRoundNo;
    return {
      buffer,
      source: mode === "test" ? "scenario-buy" : "weighted-buy",
      scenarioKey: `buyfree-scatter${scatterCount}`,
      roundId: round.id,
      roundNo: buyRoundNo,
      stepIndex: 0,
      scatterCount,
      freeCount,
      winAmount: 0
    };
  }

  return {
    mode,
    sessionId: session.id,
    get cursor() {
      return replay.cursor;
    },
    nextResponsesForClientFrame(input) {
      if (closed) throw new Error("Controlled responder is closed");
      const request = parseFrameBase64(input);
      if (request.cmd === 5000) {
        return [{ buffer: createGeneratedHeartbeatFrame(), source: "heartbeat", sessionId: session.id }];
      }
      if (request.cmd === 40002) {
        if (!pending.length) prepareBaseRound();
        return [pending.shift()];
      }
      if (request.cmd === 40006) {
        return [prepareBuyFree()];
      }
      if (request.cmd === 40004) {
        if (pendingFree.length) return [pendingFree.shift()];
        if (lastFreeResponse) return [{ ...lastFreeResponse, source: "free-terminal-repeat" }];
      }
      return replay.nextResponsesForClientFrame(input).map((buffer) => ({ buffer, source: "har", sessionId: session.id }));
    },
    close(reason = "closed") {
      if (closed) return;
      closed = true;
      store.closeSession(session.id, reason);
    }
  };
}
