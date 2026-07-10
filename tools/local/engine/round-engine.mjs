import {
  BASE_MULTIPLIERS,
  FREE_MULTIPLIERS,
  multiplierForCascade
} from "./constants.mjs";
import { cascadeBoard } from "./cascade-engine.mjs";
import { validateStep } from "./validator.mjs";
import { calculateWays } from "./ways-calculator.mjs";

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

export function buildRoundPlan({
  initialBoard,
  initialBuffers = { topResult: [3, 5, 7, 9, 11], buttomResult: [3, 5, 7, 9, 11] },
  betMulti = 20,
  betCoin = 400,
  mode = "base",
  maxCascades = 4,
  nextSymbol
}) {
  let board = [...initialBoard];
  let buffers = {
    topResult: [...initialBuffers.topResult],
    buttomResult: [...initialBuffers.buttomResult]
  };
  let totalWin = 0;
  const steps = [];
  let cascadeLimitHit = false;

  for (let cascadeIndex = 0; cascadeIndex <= maxCascades; cascadeIndex += 1) {
    const gameNum = multiplierForCascade(cascadeIndex, mode);
    const gameNumList = mode === "free" || mode === "buy"
      ? [...FREE_MULTIPLIERS]
      : [...BASE_MULTIPLIERS];
    const evaluation = calculateWays(board, { betMulti, multiplier: gameNum, mode, cascadeIndex });
    totalWin += evaluation.roundWin;
    const step = {
      board: [...board],
      topResult: [...buffers.topResult],
      buttomResult: [...buffers.buttomResult],
      lines: protocolLines(evaluation.lines),
      roundWin: evaluation.roundWin,
      totalWin,
      betMulti,
      betCoin,
      mode,
      cascadeIndex,
      gameNum,
      gameNumList,
      goldToWildPositions: [...evaluation.goldToWildPositions],
      eliminationPositions: [...evaluation.eliminationPositions]
    };
    validateStep(step);
    steps.push(step);
    if (!evaluation.lines.length) break;

    const cascaded = cascadeBoard(board, evaluation, { nextSymbol });
    step.topResult = cascaded.incomingByReel.map((incoming, reel) => (
      incoming.at(-1) ?? buffers.topResult[reel]
    ));
    board = cascaded.board;
    if (cascadeIndex === maxCascades) {
      const terminalCascadeIndex = cascadeIndex + 1;
      const terminalGameNum = multiplierForCascade(terminalCascadeIndex, mode);
      const terminalEvaluation = calculateWays(board, {
        betMulti,
        multiplier: terminalGameNum,
        mode,
        cascadeIndex: terminalCascadeIndex
      });
      if (terminalEvaluation.lines.length) {
        throw new Error("CASCADE_LIMIT_UNRESOLVED: safe terminal drop still contains a winning route");
      }
      const terminalStep = {
        board: [...board],
        topResult: [...buffers.topResult],
        buttomResult: [...buffers.buttomResult],
        lines: [],
        roundWin: 0,
        totalWin,
        betMulti,
        betCoin,
        mode,
        cascadeIndex: terminalCascadeIndex,
        gameNum: terminalGameNum,
        gameNumList: mode === "free" || mode === "buy" ? [...FREE_MULTIPLIERS] : [...BASE_MULTIPLIERS],
        goldToWildPositions: [],
        eliminationPositions: [],
        cascadeLimitHit: true
      };
      validateStep(terminalStep);
      steps.push(terminalStep);
      cascadeLimitHit = true;
      break;
    }
  }

  return {
    steps,
    totalWin,
    betCoin,
    betMulti,
    mode,
    cascadeLimitHit
  };
}
