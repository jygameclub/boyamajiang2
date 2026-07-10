import {
  BASE_MULTIPLIERS,
  BOARD_SIZE,
  FREE_MULTIPLIERS,
  SENTINEL_SYMBOL,
  VALID_SYMBOLS,
  multiplierForCascade
} from "./constants.mjs";
import { calculateWays } from "./ways-calculator.mjs";

export class BoyaValidationError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "BoyaValidationError";
    this.code = code;
    this.details = details;
  }
}

function normalizedLines(lines = []) {
  return lines
    .map(({ iconId, axleId, lineNum, score, multi, odds }) => ({ iconId, axleId, lineNum, score, multi, odds }))
    .sort((a, b) => a.iconId - b.iconId);
}

function fail(code, message, details) {
  throw new BoyaValidationError(code, message, details);
}

export function validateBoard(board) {
  if (!Array.isArray(board) || board.length !== BOARD_SIZE) {
    fail("BOARD_LENGTH_INVALID", `expected ${BOARD_SIZE} symbols`);
  }
  if (board[0] !== SENTINEL_SYMBOL || board[20] !== SENTINEL_SYMBOL) {
    fail("BOARD_SENTINEL_INVALID", "drawResult[0] and drawResult[20] must be 101");
  }
  for (let index = 0; index < board.length; index += 1) {
    const symbol = board[index];
    if (!VALID_SYMBOLS.includes(symbol)) {
      fail("BOARD_SYMBOL_INVALID", `unsupported symbol ${symbol}`, { index, symbol });
    }
    if (symbol === SENTINEL_SYMBOL && index !== 0 && index !== 20) {
      fail("BOARD_SENTINEL_INVALID", `unexpected sentinel at ${index}`);
    }
  }
  return true;
}

export function validateStep(step) {
  validateBoard(step.board);
  const expectedMultiplier = multiplierForCascade(step.cascadeIndex, step.mode);
  const expectedList = step.mode === "free" || step.mode === "buy"
    ? FREE_MULTIPLIERS
    : BASE_MULTIPLIERS;
  if (step.gameNum !== expectedMultiplier
      || JSON.stringify(step.gameNumList) !== JSON.stringify(expectedList)) {
    fail("MULTIPLIER_STATE_MISMATCH", "gameNum/gameNumList do not match the cascade state");
  }

  const calculated = calculateWays(step.board, {
    betMulti: step.betMulti,
    multiplier: expectedMultiplier,
    mode: step.mode,
    cascadeIndex: step.cascadeIndex
  });
  const actualLines = normalizedLines(step.lines);
  const expectedLines = normalizedLines(calculated.lines);
  if (JSON.stringify(actualLines) !== JSON.stringify(expectedLines)) {
    fail("LINE_WAYS_MISMATCH", "lines do not match the board", { actualLines, expectedLines });
  }
  if (Number(step.roundWin) !== calculated.roundWin) {
    fail("PAYOUT_FORMULA_MISMATCH", "roundWin does not equal the line score sum", {
      actual: step.roundWin,
      expected: calculated.roundWin
    });
  }
  if (Number(step.totalWin) < Number(step.roundWin)) {
    fail("TOTAL_WIN_INVALID", "totalWin cannot be smaller than roundWin");
  }
  return { ok: true, calculated };
}

