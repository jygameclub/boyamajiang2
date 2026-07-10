import {
  REEL_COUNT,
  SENTINEL_INDEXES,
  SENTINEL_SYMBOL,
  WILD_SYMBOL,
  boardIndex,
  isGoldSymbol,
  playableRowsForReel
} from "./constants.mjs";

export function cascadeBoard(board, evaluation, { nextSymbol } = {}) {
  if (typeof nextSymbol !== "function") {
    throw new TypeError("cascadeBoard requires nextSymbol(reel, ordinal)");
  }
  const eliminated = new Set(evaluation.eliminationPositions || []);
  const goldToWild = new Set(evaluation.goldToWildPositions || []);
  const nextBoard = Array(25).fill(null);
  const incomingByReel = [];

  for (const index of SENTINEL_INDEXES) nextBoard[index] = SENTINEL_SYMBOL;

  for (let reel = 0; reel < REEL_COUNT; reel += 1) {
    const rows = playableRowsForReel(reel);
    const survivors = [];
    for (const row of rows) {
      const index = boardIndex(reel, row);
      if (eliminated.has(index)) continue;
      if (goldToWild.has(index)) {
        survivors.push(WILD_SYMBOL);
      } else {
        survivors.push(board[index]);
      }
    }

    const missing = rows.length - survivors.length;
    const incoming = [];
    for (let ordinal = 0; ordinal < missing; ordinal += 1) {
      const symbol = Number(nextSymbol(reel, ordinal));
      if (!Number.isInteger(symbol) || symbol === WILD_SYMBOL || symbol === SENTINEL_SYMBOL) {
        throw new Error(`Invalid cascade symbol ${symbol} for reel ${reel}`);
      }
      incoming.push(symbol);
    }
    incomingByReel.push(incoming);
    const column = [...incoming, ...survivors];
    rows.forEach((row, index) => {
      nextBoard[boardIndex(reel, row)] = column[index];
    });
  }

  if (nextBoard.some((symbol) => symbol === null)) {
    throw new Error("Cascade did not fill every board position");
  }
  return { board: nextBoard, incomingByReel };
}

