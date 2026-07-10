import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createBoyaRotateFrameFromTemplate,
  decodeBoyaRotateFromPayload,
  parseFrameBase64
} from "../../tools/lib/boya-har.mjs";
import { BASE_MULTIPLIERS, freeSpinCountForScatter } from "../../tools/local/engine/constants.mjs";
import { createSmallWinScenarios } from "../../tools/local/engine/scenarios.mjs";
import { calculateWays } from "../../tools/local/engine/ways-calculator.mjs";

async function recordedFrame(cmd) {
  const raw = JSON.parse(await readFile("debugserver-data/boya-mahjong2/raw-frames.json", "utf8"));
  const message = raw.connections[1].messages.find((entry) => entry.type === "receive" && entry.cmd === cmd);
  return Buffer.from(message.rawFrameBase64, "base64");
}

test("controlled compiler writes a formula-correct base 40003 into the recorded shell", async () => {
  const template = await recordedFrame(40003);
  const [scenario] = createSmallWinScenarios({ betMulti: 20 });
  const calculated = calculateWays(scenario.board, { betMulti: 20, multiplier: 1 });
  const frame = createBoyaRotateFrameFromTemplate(template, {
    cmd: 40003,
    omitFreeFields: true,
    rotate: {
      seq: "local-test-1",
      coin: 1000000 - 400,
      betMulti: 20,
      betCoin: 400,
      purchase: false,
      drawResult: scenario.board,
      topResult: scenario.fillerByReel,
      buttomResult: scenario.fillerByReel,
      lines: calculated.lines,
      gameNumList: BASE_MULTIPLIERS,
      gameNum: 1,
      goldToWildPos: calculated.goldToWildPositions,
      roundScore: calculated.roundWin - 400,
      totalWin: calculated.roundWin,
      roundWin: calculated.roundWin
    }
  });
  const parsed = parseFrameBase64(frame);
  const rotate = decodeBoyaRotateFromPayload(parsed.payload);
  assert.equal(parsed.cmd, 40003);
  assert.deepEqual(rotate.drawResult, scenario.board);
  assert.deepEqual(rotate.gameNumList, BASE_MULTIPLIERS);
  assert.equal(rotate.gameNum, 1);
  assert.equal(rotate.roundScoreSigned, -300);
  assert.equal(rotate.roundWin, 100);
  assert.equal(rotate.lines.reduce((sum, line) => sum + line.score, 0), 100);
  assert.equal(rotate.bFree, undefined);
});

test("controlled compiler patches exact scatter/free counts in a recorded 40007 shell", async () => {
  const template = await recordedFrame(40007);
  const base = decodeBoyaRotateFromPayload(parseFrameBase64(template).payload);
  const board = [...base.drawResult];
  const playable = board.map((_, index) => index).filter((index) => index !== 0 && index !== 20);
  for (const index of playable) if (board[index] === 1) board[index] = 19;
  for (const index of playable.slice(0, 4)) board[index] = 1;
  const count = freeSpinCountForScatter(4);
  const frame = createBoyaRotateFrameFromTemplate(template, {
    cmd: 40007,
    rotate: {
      ...base,
      drawResult: board,
      purchase: true,
      bFree: true,
      freeAppend: count,
      freeRemainCount: count,
      freeMaxCount: count
    }
  });
  const rotate = decodeBoyaRotateFromPayload(parseFrameBase64(frame).payload);
  assert.equal(rotate.drawResult.filter((symbol) => symbol === 1).length, 4);
  assert.equal(rotate.freeAppend, 12);
  assert.equal(rotate.freeRemainCount, 12);
  assert.equal(rotate.freeMaxCount, 12);
  assert.equal(rotate.purchase, true);
  assert.equal(rotate.bFree, true);
});

