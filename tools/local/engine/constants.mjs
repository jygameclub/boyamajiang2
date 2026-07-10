export const BOARD_SIZE = 25;
export const REEL_COUNT = 5;
export const ROWS_PER_REEL = 5;
export const SENTINEL_SYMBOL = 101;
export const SENTINEL_INDEXES = Object.freeze([0, 20]);
export const SCATTER_SYMBOL = 1;
export const WILD_SYMBOL = 2;
export const PAYING_SYMBOLS = Object.freeze([3, 5, 7, 9, 11, 13, 15, 17, 19]);
export const GOLD_SYMBOLS = Object.freeze(PAYING_SYMBOLS.map((symbol) => symbol + 1));
export const VALID_SYMBOLS = Object.freeze([
  SCATTER_SYMBOL,
  WILD_SYMBOL,
  ...PAYING_SYMBOLS,
  ...GOLD_SYMBOLS,
  SENTINEL_SYMBOL
]);
export const PLAYABLE_INDEXES = Object.freeze(
  Array.from({ length: BOARD_SIZE }, (_, index) => index)
    .filter((index) => !SENTINEL_INDEXES.includes(index))
);
export const BASE_MULTIPLIERS = Object.freeze([1, 2, 3, 5]);
export const FREE_MULTIPLIERS = Object.freeze([2, 4, 6, 10]);

export const BOYA_PAYTABLE = Object.freeze({
  3: Object.freeze([10, 25, 50]),
  5: Object.freeze([8, 20, 40]),
  7: Object.freeze([6, 15, 30]),
  9: Object.freeze([5, 10, 15]),
  11: Object.freeze([3, 5, 12]),
  13: Object.freeze([3, 5, 12]),
  15: Object.freeze([2, 4, 10]),
  17: Object.freeze([1, 3, 6]),
  19: Object.freeze([1, 3, 6])
});

export function playableRowsForReel(reel) {
  if (!Number.isInteger(reel) || reel < 0 || reel >= REEL_COUNT) {
    throw new RangeError(`Invalid reel ${reel}`);
  }
  return reel === 0 || reel === 4 ? [1, 2, 3, 4] : [0, 1, 2, 3, 4];
}

export function boardIndex(reel, row) {
  return reel * ROWS_PER_REEL + row;
}

export function isPayingSymbol(symbol) {
  return PAYING_SYMBOLS.includes(Number(symbol));
}

export function isGoldSymbol(symbol) {
  return GOLD_SYMBOLS.includes(Number(symbol));
}

export function baseSymbolFor(symbol) {
  const value = Number(symbol);
  if (isPayingSymbol(value)) return value;
  if (isGoldSymbol(value)) return value - 1;
  return null;
}

export function payoutFor(iconId, matchLength) {
  const rates = BOYA_PAYTABLE[Number(iconId)];
  if (!rates || matchLength < 3 || matchLength > 5) return 0;
  return rates[matchLength - 3];
}

export function multiplierForCascade(cascadeIndex, mode = "base") {
  const multipliers = mode === "free" || mode === "buy"
    ? FREE_MULTIPLIERS
    : BASE_MULTIPLIERS;
  const index = Math.max(0, Math.min(multipliers.length - 1, Number(cascadeIndex) || 0));
  return multipliers[index];
}

export function freeSpinCountForScatter(scatterCount) {
  const count = Math.max(0, Math.trunc(Number(scatterCount) || 0));
  if (count < 3) return 0;
  if (count === 3) return 10;
  if (count === 4) return 12;
  return 14 + (count - 5);
}

