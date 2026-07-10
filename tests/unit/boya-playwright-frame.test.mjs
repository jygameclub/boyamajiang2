import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  clickUntilObservedFrame,
  clickSequenceUntilObservedFrame,
  collectRotateSequence,
  decodeObservedFrame,
  renderControlledReport,
  waitForGameCanvas
} from "../playwright/boya-observed-frame.mjs";

const frames = JSON.parse(
  readFileSync(new URL("../../debugserver-data/boya-mahjong2/raw-frames.json", import.meta.url), "utf8")
);

function recordedFrame(cmd) {
  const message = frames.connections[1].messages.find((entry) => entry.cmd === cmd && entry.rawFrameBase64);
  assert.ok(message, `missing recorded frame ${cmd}`);
  return Buffer.from(message.rawFrameBase64, "base64");
}

test("Playwright frame observer decodes 40001 as an enter balance instead of a rotate result", () => {
  const observed = decodeObservedFrame("receive", recordedFrame(40001), 7);

  assert.deepEqual(observed, {
    id: 7,
    direction: "receive",
    cmd: 40001,
    bytes: recordedFrame(40001).length,
    enterBalance: 455706238
  });
});

test("Playwright frame observer decodes actual rotate result frames", () => {
  const observed = decodeObservedFrame("receive", recordedFrame(40003), 8);

  assert.equal(observed.cmd, 40003);
  assert.ok(Array.isArray(observed.rotate.drawResult));
  assert.ok(Array.isArray(observed.rotate.lines));
});

test("controlled Playwright report preserves an early failure", () => {
  const markdown = renderControlledReport({
    verdict: "FAIL",
    baseUrl: "http://127.0.0.1:18082",
    error: "Timed out waiting for 40001",
    diagnostics: { httpErrors: [], pageErrors: [], clientCloses: [] }
  });

  assert.match(markdown, /Timed out waiting for 40001/);
  assert.match(markdown, /## Base Ladder/);
  assert.match(markdown, /## Buy Free/);
});

test("controlled Playwright click retries until the client emits the expected frame", async () => {
  const observedFrames = [];
  observedFrames.listeners = [];
  let clicks = 0;
  const page = {
    mouse: {
      async click() {
        clicks += 1;
        if (clicks !== 2) return;
        const frame = { id: 1, direction: "send", cmd: 40002 };
        observedFrames.push(frame);
        observedFrames.listeners.forEach((listener) => listener(frame));
      }
    }
  };

  const frame = await clickUntilObservedFrame({
    page,
    frames: observedFrames,
    predicate: (entry) => entry.cmd === 40002,
    x: 450,
    y: 1315,
    timeoutMs: 100,
    intervalMs: 1,
    label: "spin request"
  });

  assert.equal(clicks, 2);
  assert.equal(frame.cmd, 40002);
});

test("controlled Playwright retries a dialog click sequence until purchase is emitted", async () => {
  const observedFrames = [];
  observedFrames.listeners = [];
  const clicks = [];
  const page = {
    mouse: {
      async click(x, y) {
        clicks.push([x, y]);
        if (clicks.length !== 4) return;
        const frame = { id: 1, direction: "send", cmd: 40006 };
        observedFrames.push(frame);
        observedFrames.listeners.forEach((listener) => listener(frame));
      }
    },
    async waitForTimeout() {}
  };

  const frame = await clickSequenceUntilObservedFrame({
    page,
    frames: observedFrames,
    predicate: (entry) => entry.cmd === 40006,
    clicks: [{ x: 145, y: 1090 }, { x: 590, y: 1150 }],
    clickDelayMs: 0,
    timeoutMs: 100,
    intervalMs: 1,
    label: "buy request"
  });

  assert.deepEqual(clicks, [[145, 1090], [590, 1150], [145, 1090], [590, 1150]]);
  assert.equal(frame.cmd, 40006);
});

test("controlled Playwright collects every cascade through the zero-win terminal frame", async () => {
  const frames = [
    { id: 1, direction: "receive", cmd: 40003, rotate: { lines: [{ score: 100 }], roundWin: 100 } },
    { id: 2, direction: "receive", cmd: 5001 },
    { id: 3, direction: "receive", cmd: 40003, rotate: { lines: [{ score: 200 }], roundWin: 200 } },
    { id: 4, direction: "receive", cmd: 40003, rotate: { lines: [], roundWin: 0 } }
  ];
  frames.listeners = [];

  const sequence = await collectRotateSequence({
    frames,
    firstFrame: frames[0],
    responseCmd: 40003,
    timeoutMs: 10,
    label: "live cascade"
  });

  assert.deepEqual(sequence.map((frame) => frame.rotate.roundWin), [100, 200, 0]);
});

test("Playwright canvas wait enters the local live iframe", async () => {
  const waits = [];
  const canvas = {
    async waitFor(options) {
      waits.push(options);
    }
  };
  const page = {
    locator(selector) {
      assert.equal(selector, "iframe#local-game-frame");
      return { async count() { return 1; } };
    },
    frameLocator(selector) {
      assert.equal(selector, "iframe#local-game-frame");
      return {
        locator(canvasSelector) {
          assert.equal(canvasSelector, "canvas#GameCanvas");
          return canvas;
        }
      };
    }
  };

  assert.equal(await waitForGameCanvas(page, { timeoutMs: 1234 }), canvas);
  assert.deepEqual(waits, [{ state: "visible", timeout: 1234 }]);
});
