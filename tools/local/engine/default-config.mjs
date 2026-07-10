import { PAYING_SYMBOLS, SCATTER_SYMBOL } from "./constants.mjs";

const BASE_WEIGHTS = Object.freeze({
  [SCATTER_SYMBOL]: 1,
  3: 2,
  5: 3,
  7: 4,
  9: 5,
  11: 7,
  13: 8,
  15: 10,
  17: 12,
  19: 12
});

function reelWeights() {
  return Array.from({ length: 5 }, (_, reel) => {
    const bias = reel === 2 ? 1 : 0;
    return Object.fromEntries([
      [SCATTER_SYMBOL, BASE_WEIGHTS[SCATTER_SYMBOL]],
      ...PAYING_SYMBOLS.map((symbol) => [symbol, BASE_WEIGHTS[symbol] + bias])
    ]);
  });
}

function phase(goldRateByReel) {
  return {
    symbolWeights: reelWeights(),
    goldRateByReel
  };
}

export const DEFAULT_CONTROL_CONFIG = Object.freeze({
  version: 1,
  buyCostMultiplier: 80,
  modes: {
    base: {
      initial: phase([0, 3, 6, 3, 0]),
      cascade: phase([0, 4, 7, 4, 0]),
      cascadeLimit: 4,
      scatterCap: 2,
      outcomeWeights: { miss: 70, small: 20, medium: 7, big: 2, mega: 1, super: 0 }
    },
    free: {
      initial: phase([0, 4, 100, 4, 0]),
      cascade: phase([0, 4, 100, 4, 0]),
      cascadeLimit: 5,
      scatterCap: 23,
      outcomeWeights: { miss: 45, small: 35, medium: 14, big: 4, mega: 2, super: 0 }
    },
    buy: {
      initial: phase([0, 3, 100, 3, 0]),
      cascade: phase([0, 4, 100, 4, 0]),
      cascadeLimit: 6,
      scatterCap: 23,
      scatterWeights: { scatter3: 70, scatter4: 20, scatter5: 8, scatter6plus: 2 }
    }
  }
});

export function cloneDefaultControlConfig() {
  return structuredClone(DEFAULT_CONTROL_CONFIG);
}

