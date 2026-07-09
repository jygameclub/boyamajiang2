import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildLocalGameUrl,
  createConnectionReplay,
  createGeneratedWinFrame,
  createReplayResponder,
  createWinLadderFrameFromBase,
  decodeBoyaRotateFromPayload,
  extractAssetsFromHarObject,
  extractBoardFields,
  importFramesFromHarObject,
  normalizeReplayMode,
  parseFrameBase64
} from "../../tools/lib/boya-har.mjs";

function frameBase64(rawCmd, payload = Buffer.alloc(0)) {
  const frame = Buffer.alloc(12 + payload.length);
  frame.writeUInt32BE(frame.length - 4, 0);
  frame.writeUInt32BE(rawCmd >>> 0, 4);
  frame.writeUInt32BE(0, 8);
  payload.copy(frame, 12);
  return frame.toString("base64");
}

function miniHar() {
  return {
    log: {
      entries: [
        {
          request: { url: "https://game.666789.site/v2/" },
          response: {
            status: 200,
            content: {
              mimeType: "text/html",
              text: "<!doctype html><script src=\"src/settings.058af.js\"></script>"
            }
          }
        },
        {
          request: { url: "https://game.666789.site/v2/src/settings.058af.js" },
          response: {
            status: 200,
            content: {
              mimeType: "application/javascript",
              text: "window._CCSettings={};"
            }
          }
        },
        {
          request: { url: "https://game.666789.site/v2/assets/internal/native/aa/demo.png" },
          response: {
            status: 200,
            content: {
              mimeType: "image/png",
              encoding: "base64",
              text: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")
            }
          }
        },
        {
          request: { url: "wss://gateway.666789.site/gate/ws?login" },
          response: { status: 101, content: { mimeType: "x-unknown" } },
          _webSocketMessages: [
            { time: 1, type: "send", opcode: 2, data: frameBase64(10000, Buffer.from([1])) },
            { time: 2, type: "receive", opcode: 2, data: frameBase64(10001, Buffer.from([2])) }
          ]
        },
        {
          request: { url: "wss://gateway.666789.site/gate/ws?game" },
          response: { status: 101, content: { mimeType: "x-unknown" } },
          _webSocketMessages: [
            { time: 3, type: "send", opcode: 2, data: frameBase64(40000) },
            { time: 4, type: "receive", opcode: 2, data: frameBase64(40001, Buffer.from([3])) },
            { time: 5, type: "send", opcode: 2, data: frameBase64(40002, Buffer.from([4])) },
            { time: 6, type: "receive", opcode: 2, data: frameBase64(40003, Buffer.from([5])) }
          ]
        }
      ]
    }
  };
}

test("parseFrameBase64 extracts length, high-bit command, and payload", () => {
  const payload = Buffer.from([0x1f, 0x8b, 0x08]);
  const parsed = parseFrameBase64(frameBase64(0x80004e25, payload));

  assert.equal(parsed.length, 15);
  assert.equal(parsed.declaredLength, 11);
  assert.equal(parsed.rawCmd, 0x80004e25);
  assert.equal(parsed.cmd, 0x4e25);
  assert.equal(parsed.compressed, true);
  assert.deepEqual([...parsed.payload], [...payload]);
});

test("extractAssetsFromHarObject writes v2 assets and MIME manifest from HAR content", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boya-assets-"));
  try {
    const result = await extractAssetsFromHarObject(miniHar(), dir);

    assert.equal(result.written, 3);
    assert.equal(
      await readFile(path.join(dir, "v2/index.html"), "utf8"),
      "<!doctype html><script src=\"src/settings.058af.js\"></script>"
    );
    assert.equal(
      await readFile(path.join(dir, "v2/src/settings.058af.js"), "utf8"),
      "window._CCSettings={};"
    );
    const png = await readFile(path.join(dir, "v2/assets/internal/native/aa/demo.png"));
    assert.deepEqual([...png], [0x89, 0x50, 0x4e, 0x47]);

    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.files["/v2/src/settings.058af.js"].contentType, "application/javascript");
    assert.equal(manifest.files["/v2/assets/internal/native/aa/demo.png"].encoding, "base64");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("importFramesFromHarObject keeps WebSocket connections separate and writes enter/bet files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boya-frames-"));
  try {
    const result = await importFramesFromHarObject(miniHar(), dir);

    assert.equal(result.connections.length, 2);
    assert.equal(result.summary.commands["40001"].receive, 1);
    assert.equal(result.summary.commands["40003"].receive, 1);

    const raw = JSON.parse(await readFile(path.join(dir, "raw-frames.json"), "utf8"));
    assert.equal(raw.connections[0].messages.length, 2);
    assert.equal(raw.connections[1].messages.length, 4);

    const enter = JSON.parse(await readFile(path.join(dir, "000.json"), "utf8"));
    assert.equal(enter.type, "enter");
    assert.equal(enter.cmd, 40001);
    assert.equal(enter.connectionIndex, 1);

    const bet = JSON.parse(await readFile(path.join(dir, "001.json"), "utf8"));
    assert.equal(bet.type, "normal-bet");
    assert.equal(bet.cmd, 40003);
    assert.equal(bet.connectionIndex, 1);

    await stat(path.join(dir, "coverage-config.yaml"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createConnectionReplay advances one connection without using frames from another connection", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boya-replay-"));
  try {
    await importFramesFromHarObject(miniHar(), dir);
    const raw = JSON.parse(await readFile(path.join(dir, "raw-frames.json"), "utf8"));

    const loginReplay = createConnectionReplay(raw, 0);
    const gameReplay = createConnectionReplay(raw, 1);

    assert.equal(parseFrameBase64(loginReplay.nextResponseForClientFrame(frameBase64(10000))).cmd, 10001);
    assert.equal(parseFrameBase64(gameReplay.nextResponseForClientFrame(frameBase64(40000))).cmd, 40001);
    assert.equal(parseFrameBase64(gameReplay.nextResponseForClientFrame(frameBase64(40002))).cmd, 40003);
    assert.throws(
      () => loginReplay.nextResponseForClientFrame(frameBase64(40002)),
      /No replay response/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildLocalGameUrl encodes mode in the local WebSocket gateway URL", () => {
  const url = new URL(buildLocalGameUrl({ host: "127.0.0.1", port: 18082, mode: "dataset" }));
  const wsUrl = Buffer.from(url.searchParams.get("g"), "base64").toString("utf8");

  assert.equal(url.origin, "http://127.0.0.1:18082");
  assert.equal(url.pathname, "/v2/");
  assert.equal(url.searchParams.get("localMode"), "dataset");
  assert.equal(wsUrl, "ws://127.0.0.1:18082/gate/ws?mode=dataset");
});

test("normalizeReplayMode tolerates client-appended WebSocket query suffixes", () => {
  assert.equal(normalizeReplayMode("dataset?CAFNMQJL"), "dataset");
  assert.equal(normalizeReplayMode("replay?BAJJMAVX"), "replay");
  assert.equal(normalizeReplayMode("winladder?BAJJMAVX"), "winladder");
  assert.equal(normalizeReplayMode(null), "replay");
});

test("createReplayResponder loops local dataset bet responses after HAR replay is exhausted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boya-dataset-"));
  try {
    const raw = await importFramesFromHarObject({
      log: {
        entries: [
          {
            request: { url: "wss://gateway.666789.site/gate/ws?game" },
            response: { status: 101, content: { mimeType: "x-unknown" } },
            _webSocketMessages: [
              { time: 1, type: "send", opcode: 2, data: frameBase64(40000) },
              { time: 2, type: "receive", opcode: 2, data: frameBase64(40001, Buffer.from([1])) },
              { time: 3, type: "send", opcode: 2, data: frameBase64(40002) },
              { time: 4, type: "receive", opcode: 2, data: frameBase64(40003, Buffer.from([10])) },
              { time: 5, type: "send", opcode: 2, data: frameBase64(40002) },
              { time: 6, type: "receive", opcode: 2, data: frameBase64(40003, Buffer.from([20])) }
            ]
          }
        ]
      }
    }, dir);

    const responder = createReplayResponder(raw, 0, "dataset");
    assert.equal(parseFrameBase64(responder.nextResponsesForClientFrame(frameBase64(40000))[0].buffer).cmd, 40001);

    const first = responder.nextResponsesForClientFrame(frameBase64(40002))[0];
    const second = responder.nextResponsesForClientFrame(frameBase64(40002))[0];
    const third = responder.nextResponsesForClientFrame(frameBase64(40002))[0];

    assert.equal(first.source, "dataset");
    assert.equal(first.datasetIndex, 0);
    assert.deepEqual([...parseFrameBase64(first.buffer).payload], [10]);
    assert.equal(second.datasetIndex, 1);
    assert.deepEqual([...parseFrameBase64(second.buffer).payload], [20]);
    assert.equal(third.datasetIndex, 0);
    assert.deepEqual([...parseFrameBase64(third.buffer).payload], [10]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createGeneratedWinFrame builds a 40003 response with the requested totalWin", () => {
  const frame = createGeneratedWinFrame({ winAmount: 2400, sequence: 3, coin: 456000 });
  const parsed = parseFrameBase64(frame);
  const rotate = decodeBoyaRotateFromPayload(parsed.payload);

  assert.equal(parsed.cmd, 40003);
  assert.equal(rotate.totalWin, 2400);
  assert.equal(rotate.roundWin, 2400);
  assert.equal(rotate.lines[0].score, 2400);
  assert.equal(rotate.coin, 456000);
  assert.match(rotate.seq, /^local-winladder-3-/);
});

test("createWinLadderFrameFromBase overrides only money fields and preserves the recorded spin", () => {
  const base = createGeneratedWinFrame({ winAmount: 0, sequence: 7, coin: 987654 });
  const baseRotate = decodeBoyaRotateFromPayload(parseFrameBase64(base).payload);

  const patched = createWinLadderFrameFromBase(base, { winAmount: 6000 });
  const parsed = parseFrameBase64(patched);
  const rotate = decodeBoyaRotateFromPayload(parsed.payload);

  assert.equal(parsed.cmd, 40003);
  assert.equal(rotate.totalWin, 6000);
  assert.equal(rotate.roundWin, 6000);
  assert.equal(rotate.roundScore, 6000 - 400);
  // Everything else must survive untouched so the client keeps a valid game state.
  assert.equal(rotate.coin, baseRotate.coin);
  assert.equal(rotate.seq, baseRotate.seq);
  assert.deepEqual(rotate.drawResult, baseRotate.drawResult);
});

test("winladder responder keeps the recorded base spin safe when no free data exists", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boya-winladder-clone-"));
  try {
    const recordedBet = createGeneratedWinFrame({ winAmount: 0, sequence: 1, coin: 555000 }).toString("base64");
    const raw = await importFramesFromHarObject({
      log: {
        entries: [
          {
            request: { url: "wss://gateway.666789.site/gate/ws?game" },
            response: { status: 101, content: { mimeType: "x-unknown" } },
            _webSocketMessages: [
              { time: 1, type: "send", opcode: 2, data: frameBase64(40000) },
              { time: 2, type: "receive", opcode: 2, data: frameBase64(40001, Buffer.from([1])) },
              { time: 3, type: "send", opcode: 2, data: frameBase64(40002) },
              { time: 4, type: "receive", opcode: 2, data: recordedBet }
            ]
          }
        ]
      }
    }, dir);

    const responder = createReplayResponder(raw, 0, "winladder");
    responder.nextResponsesForClientFrame(frameBase64(40000));
    const spin = responder.nextResponsesForClientFrame(frameBase64(40002))[0];
    const rotate = decodeBoyaRotateFromPayload(parseFrameBase64(spin.buffer).payload);

    assert.equal(spin.source, "winladder-base");
    assert.equal(rotate.totalWin, 0);
    assert.equal(rotate.lines.length, 1);
    // coin comes from the recorded 40003, proving the frame is cloned, not fabricated.
    assert.equal(rotate.coin, 555000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("winladder real-data free cascades keep board, paths, and payout consistent", async () => {
  const raw = JSON.parse(await readFile(
    path.join(process.cwd(), "debugserver-data/boya-mahjong2/raw-frames.json"),
    "utf8"
  ));
  const responder = createReplayResponder(raw, 1, "winladder");

  const base = responder.nextResponsesForClientFrame(frameBase64(40002))[0];
  assert.equal(parseFrameBase64(base.buffer).cmd, 40003);
  assert.equal(base.source, "winladder-base");

  const trigger = responder.nextResponsesForClientFrame(frameBase64(40006))[0];
  assert.equal(parseFrameBase64(trigger.buffer).cmd, 40007);
  assert.equal(trigger.source, "freespin-trigger");

  const expectedWins = [400, 1200, 2400, 6000, 12000, 20000];
  const observedWins = [];
  for (let index = 0; observedWins.length < expectedWins.length && index < 20; index += 1) {
    const step = responder.nextResponsesForClientFrame(frameBase64(40004))[0];
    const parsed = parseFrameBase64(step.buffer);
    const rotate = decodeBoyaRotateFromPayload(parsed.payload);
    if (!rotate.lines.length) {
      continue;
    }
    const scoreSum = rotate.lines.reduce((sum, line) => sum + line.score, 0);
    const visibleSymbols = new Set([
      ...rotate.drawResult,
      ...rotate.topResult,
      ...rotate.buttomResult
    ]);

    assert.equal(parsed.cmd, 40005);
    assert.equal(scoreSum, step.winAmount);
    assert.equal(rotate.roundWin, scoreSum);
    for (const line of rotate.lines) {
      assert.ok(
        visibleSymbols.has(line.iconId),
        `line icon ${line.iconId} must exist on the visible board`
      );
    }
    observedWins.push(rotate.roundWin);
  }

  assert.deepEqual(observedWins, expectedWins);
});

test("createWinLadderFrameFromBase swaps in a supplied board while keeping the win override", () => {
  const base = createGeneratedWinFrame({ winAmount: 0, sequence: 1, coin: 222 });
  const board = extractBoardFields(base);

  const framed = createWinLadderFrameFromBase(base, { winAmount: 2400, board });
  const rotate = decodeBoyaRotateFromPayload(parseFrameBase64(framed).payload);

  assert.equal(rotate.totalWin, 2400);
  assert.deepEqual(
    rotate.drawResult,
    decodeBoyaRotateFromPayload(parseFrameBase64(base).payload).drawResult
  );
});

test("winladder responder replays the recorded free-spin trigger and cascade steps", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boya-freespin-"));
  try {
    const raw = await importFramesFromHarObject({
      log: {
        entries: [
          {
            request: { url: "wss://gateway.666789.site/gate/ws?game" },
            response: { status: 101, content: { mimeType: "x-unknown" } },
            _webSocketMessages: [
              { time: 1, type: "send", opcode: 2, data: frameBase64(40000) },
              { time: 2, type: "receive", opcode: 2, data: frameBase64(40001, Buffer.from([1])) },
              { time: 3, type: "send", opcode: 2, data: frameBase64(40002) },
              { time: 4, type: "receive", opcode: 2, data: frameBase64(40003, Buffer.from([10])) },
              { time: 5, type: "send", opcode: 2, data: frameBase64(40006) },
              { time: 6, type: "receive", opcode: 2, data: frameBase64(40007, Buffer.from([70])) },
              { time: 7, type: "send", opcode: 2, data: frameBase64(40004) },
              { time: 8, type: "receive", opcode: 2, data: frameBase64(40005, Buffer.from([51])) },
              { time: 9, type: "send", opcode: 2, data: frameBase64(40004) },
              { time: 10, type: "receive", opcode: 2, data: frameBase64(40005, Buffer.from([52])) }
            ]
          }
        ]
      }
    }, dir);

    const responder = createReplayResponder(raw, 0, "winladder");
    responder.nextResponsesForClientFrame(frameBase64(40000));

    const trigger = responder.nextResponsesForClientFrame(frameBase64(40006))[0];
    assert.equal(trigger.source, "freespin-trigger");
    assert.equal(parseFrameBase64(trigger.buffer).cmd, 40007);

    const step1 = responder.nextResponsesForClientFrame(frameBase64(40004))[0];
    const step2 = responder.nextResponsesForClientFrame(frameBase64(40004))[0];
    const step3 = responder.nextResponsesForClientFrame(frameBase64(40004))[0];

    assert.equal(step1.source, "freespin-cascade");
    assert.deepEqual([...parseFrameBase64(step1.buffer).payload], [51]);
    assert.deepEqual([...parseFrameBase64(step2.buffer).payload], [52]);
    // Once the recorded cascade is exhausted it clamps to the last (settle) step
    // instead of throwing, so the connection never dies mid-feature.
    assert.deepEqual([...parseFrameBase64(step3.buffer).payload], [52]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createReplayResponder winladder mode keeps heartbeat replies available after generated spins", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boya-winladder-heartbeat-"));
  try {
    const raw = await importFramesFromHarObject({
      log: {
        entries: [
          {
            request: { url: "wss://gateway.666789.site/gate/ws?game" },
            response: { status: 101, content: { mimeType: "x-unknown" } },
            _webSocketMessages: [
              { time: 1, type: "send", opcode: 2, data: frameBase64(40000) },
              { time: 2, type: "receive", opcode: 2, data: frameBase64(40001, Buffer.from([1])) },
              { time: 3, type: "send", opcode: 2, data: frameBase64(40002) },
              { time: 4, type: "receive", opcode: 2, data: frameBase64(40003, Buffer.from([10])) },
              { time: 5, type: "send", opcode: 2, data: frameBase64(5000) },
              { time: 6, type: "receive", opcode: 2, data: frameBase64(5001, Buffer.from([50])) }
            ]
          }
        ]
      }
    }, dir);

    const responder = createReplayResponder(raw, 0, "winladder");
    responder.nextResponsesForClientFrame(frameBase64(40000));
    responder.nextResponsesForClientFrame(frameBase64(40002));
    responder.nextResponsesForClientFrame(frameBase64(40002));

    const firstHeartbeat = responder.nextResponsesForClientFrame(frameBase64(5000))[0];
    const secondHeartbeat = responder.nextResponsesForClientFrame(frameBase64(5000))[0];

    assert.equal(firstHeartbeat.source, "heartbeat");
    assert.equal(secondHeartbeat.source, "heartbeat");
    assert.equal(parseFrameBase64(firstHeartbeat.buffer).cmd, 5001);
    assert.equal(parseFrameBase64(secondHeartbeat.buffer).cmd, 5001);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
