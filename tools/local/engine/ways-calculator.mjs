import {
  BOARD_SIZE,
  PAYING_SYMBOLS,
  WILD_SYMBOL,
  baseSymbolFor,
  boardIndex,
  isGoldSymbol,
  multiplierForCascade,
  payoutFor,
  playableRowsForReel
} from "./constants.mjs";

function matchingPositions(board, reel, iconId) {
  return playableRowsForReel(reel)
    .map((row) => boardIndex(reel, row))
    .filter((index) => {
      const symbol = board[index];
      return symbol === WILD_SYMBOL || baseSymbolFor(symbol) === iconId;
    });
}

export function calculateWays(board, {
  betMulti = 20,
  multiplier,
  cascadeIndex = 0,
  mode = "base"
} = {}) {
  if (!Array.isArray(board) || board.length !== BOARD_SIZE) {
    throw new Error(`Boya board must contain ${BOARD_SIZE} symbols`);
  }
  const effectiveMultiplier = multiplier ?? multiplierForCascade(cascadeIndex, mode);
  const candidates = new Set();
  for (const symbol of board) {
    const base = baseSymbolFor(symbol);
    if (base && PAYING_SYMBOLS.includes(base)) candidates.add(base);
  }

  const lines = [];
  const elimination = new Set();
  const goldToWild = new Set();
  for (const iconId of [...candidates].sort((a, b) => a - b)) {
    const positionsByReel = [];
    for (let reel = 0; reel < 5; reel += 1) {
      const positions = matchingPositions(board, reel, iconId);
      if (!positions.length) break;
      positionsByReel.push(positions);
    }
    if (positionsByReel.length < 3) continue;

    const positions = positionsByReel.flat();
    const lineNum = positionsByReel.reduce((ways, reelPositions) => ways * reelPositions.length, 1);
    const odds = payoutFor(iconId, positionsByReel.length);
    const score = odds * lineNum * effectiveMultiplier * Number(betMulti);
    const wildPositions = [];
    const goldPositions = [];
    for (const index of positions) {
      if (board[index] === WILD_SYMBOL) {
        wildPositions.push(index);
        elimination.add(index);
      } else if (isGoldSymbol(board[index])) {
        goldPositions.push(index);
        goldToWild.add(index);
      } else {
        elimination.add(index);
      }
    }
    lines.push({
      iconId,
      axleId: positionsByReel.length - 1,
      lineNum,
      score,
      multi: effectiveMultiplier,
      odds,
      positions,
      wildPositions,
      goldPositions
    });
  }

  return {
    lines,
    roundWin: lines.reduce((sum, line) => sum + line.score, 0),
    eliminationPositions: [...elimination].sort((a, b) => a - b),
    goldToWildPositions: [...goldToWild].sort((a, b) => a - b)
  };
}

