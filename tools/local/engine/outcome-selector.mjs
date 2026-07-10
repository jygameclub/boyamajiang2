import { createCascadeSampler, generateBoard, generateBuffers } from "./board-generator.mjs";
import { createSeededRng, weightedChoice } from "./rng.mjs";
import { buildRoundPlan } from "./round-engine.mjs";
import { createOutcomeFallbackScenario } from "./scenarios.mjs";

export function classifyOutcome(totalWin, betCoin) {
  const win = Math.max(0, Number(totalWin) || 0);
  const bet = Math.max(1, Number(betCoin) || 1);
  const multiple = win / bet;
  if (win === 0) return "miss";
  if (multiple < 5) return "small";
  if (multiple < 10) return "medium";
  if (multiple < 20) return "big";
  if (multiple < 30) return "mega";
  return "super";
}

function chooseTarget(rng, weights) {
  return weightedChoice(rng, Object.entries(weights || {}));
}

export function generateLiveRound({
  config,
  seed,
  betMulti = 20,
  betCoin = 400,
  mode = "base",
  maxAttempts = 128
}) {
  const modeConfig = config.modes[mode];
  if (!modeConfig) throw new Error(`Missing config for mode ${mode}`);
  const rng = createSeededRng(seed);
  const targetOutcome = chooseTarget(rng, modeConfig.outcomeWeights);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const board = generateBoard({
        rng,
        weightsByReel: modeConfig.initial.symbolWeights,
        goldRateByReel: modeConfig.initial.goldRateByReel,
        mode,
        scatterCap: modeConfig.scatterCap
      });
      const buffers = generateBuffers({
        rng,
        weightsByReel: modeConfig.initial.symbolWeights,
        goldRateByReel: modeConfig.initial.goldRateByReel,
        mode
      });
      const plan = buildRoundPlan({
        initialBoard: board,
        initialBuffers: buffers,
        betMulti,
        betCoin,
        mode,
        maxCascades: modeConfig.cascadeLimit,
        nextSymbol: createCascadeSampler({
          rng,
          weightsByReel: modeConfig.cascade.symbolWeights,
          goldRateByReel: modeConfig.cascade.goldRateByReel,
          mode
        })
      });
      const outcome = classifyOutcome(plan.totalWin, betCoin);
      if (outcome === targetOutcome) {
        return { plan, outcome, targetOutcome, source: "weighted", attempts: attempt, seed };
      }
    } catch (error) {
      lastError = error;
    }
  }

  const scenario = createOutcomeFallbackScenario(targetOutcome, {
    betMulti,
    betCoin,
    multiplier: mode === "free" || mode === "buy" ? 2 : 1
  });
  const plan = buildRoundPlan({
    initialBoard: scenario.board,
    initialBuffers: {
      topResult: scenario.fillerByReel,
      buttomResult: scenario.fillerByReel
    },
    betMulti,
    betCoin,
    mode,
    maxCascades: modeConfig.cascadeLimit,
    nextSymbol: (reel) => scenario.fillerByReel[reel]
  });
  return {
    plan,
    outcome: classifyOutcome(plan.totalWin, betCoin),
    targetOutcome,
    source: "template-fallback",
    fallbackReason: lastError?.message || `No ${targetOutcome} result in ${maxAttempts} attempts`,
    attempts: maxAttempts,
    scenarioKey: scenario.key,
    seed
  };
}
