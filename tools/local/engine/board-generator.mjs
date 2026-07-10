import {
  PAYING_SYMBOLS,
  SCATTER_SYMBOL,
  SENTINEL_SYMBOL,
  WILD_SYMBOL,
  boardIndex,
  playableRowsForReel
} from "./constants.mjs";
import { weightedChoice } from "./rng.mjs";

function entriesFor(weights, { allowScatter = true } = {}) {
  return Object.entries(weights || {})
    .map(([symbol, weight]) => [Number(symbol), Number(weight)])
    .filter(([symbol, weight]) => Number.isInteger(symbol)
      && weight > 0
      && symbol !== WILD_SYMBOL
      && symbol !== SENTINEL_SYMBOL
      && (allowScatter || symbol !== SCATTER_SYMBOL));
}

function maybeGold(symbol, reel, rng, goldRateByReel, mode) {
  if (!PAYING_SYMBOLS.includes(symbol)) return symbol;
  const forced = (mode === "free" || mode === "buy") && reel === 2;
  const rate = forced ? 100 : Math.max(0, Math.min(100, Number(goldRateByReel?.[reel]) || 0));
  return rng.next() * 100 < rate ? symbol + 1 : symbol;
}

function sampleSymbol({ rng, weights, reel, goldRateByReel, mode, allowScatter }) {
  const symbol = weightedChoice(rng, entriesFor(weights, { allowScatter }));
  return maybeGold(symbol, reel, rng, goldRateByReel, mode);
}

export function generateBoard({
  rng,
  weightsByReel,
  goldRateByReel = [0, 0, 0, 0, 0],
  mode = "base",
  scatterCap = 2
}) {
  if (!rng || !Array.isArray(weightsByReel) || weightsByReel.length !== 5) {
    throw new Error("generateBoard requires an RNG and five reel weight maps");
  }
  const board = Array(25).fill(null);
  board[0] = SENTINEL_SYMBOL;
  board[20] = SENTINEL_SYMBOL;
  let scatterCount = 0;
  for (let reel = 0; reel < 5; reel += 1) {
    for (const row of playableRowsForReel(reel)) {
      const allowScatter = scatterCount < scatterCap;
      const symbol = sampleSymbol({
        rng,
        weights: weightsByReel[reel],
        reel,
        goldRateByReel,
        mode,
        allowScatter
      });
      if (symbol === SCATTER_SYMBOL) scatterCount += 1;
      board[boardIndex(reel, row)] = symbol;
    }
  }
  return board;
}

export function generateBuffers({
  rng,
  weightsByReel,
  goldRateByReel = [0, 0, 0, 0, 0],
  mode = "base"
}) {
  const sample = (reel) => sampleSymbol({
    rng,
    weights: weightsByReel[reel],
    reel,
    goldRateByReel,
    mode,
    allowScatter: true
  });
  return {
    topResult: Array.from({ length: 5 }, (_, reel) => sample(reel)),
    buttomResult: Array.from({ length: 5 }, (_, reel) => sample(reel))
  };
}

export function createCascadeSampler({ rng, weightsByReel, goldRateByReel, mode = "base" }) {
  return (reel) => sampleSymbol({
    rng,
    weights: weightsByReel[reel],
    reel,
    goldRateByReel,
    mode,
    allowScatter: true
  });
}

