#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import { parseFrameBase64 } from "../../tools/lib/boya-har.mjs";

function parseArgs(argv) {
  const args = {
    url: "",
    out: "",
    headed: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") {
      args.url = argv[++index];
    } else if (arg === "--out") {
      args.out = argv[++index];
    } else if (arg === "--headed") {
      args.headed = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.url) {
    throw new Error("--url is required");
  }
  if (!args.out) {
    throw new Error("--out is required");
  }

  return args;
}

function usage() {
  console.log(`Usage:
  npx --yes --package playwright node tests/playwright/boya-mahjong2-bet.mjs --url "$(cat .boya-local-server-url)" --out testwebgame/boya-mahjong2/20260709-135000`);
}

function framePayloadToBuffer(payload) {
  if (Buffer.isBuffer(payload)) {
    return payload;
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload);
  }
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (typeof payload === "string") {
    return Buffer.from(payload, "base64");
  }
  return Buffer.alloc(0);
}

function waitForObservedCmd(observedFrames, cmd, direction, timeoutMs) {
  const existing = observedFrames.find((frame) => frame.cmd === cmd && frame.direction === direction);
  if (existing) {
    return Promise.resolve(existing);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${direction} cmd ${cmd}`));
    }, timeoutMs);

    function onFrame(frame) {
      if (frame.cmd === cmd && frame.direction === direction) {
        cleanup();
        resolve(frame);
      }
    }

    function cleanup() {
      clearTimeout(timeout);
      const index = observedFrames.listeners.indexOf(onFrame);
      if (index >= 0) {
        observedFrames.listeners.splice(index, 1);
      }
    }

    observedFrames.listeners.push(onFrame);
  });
}

function recordFrame(observedFrames, frame) {
  observedFrames.push(frame);
  for (const listener of [...observedFrames.listeners]) {
    listener(frame);
  }
}

async function launchBrowser(headed) {
  try {
    return await chromium.launch({ headless: !headed });
  } catch (error) {
    return chromium.launch({ channel: "chrome", headless: !headed });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });

  const consoleLines = [];
  const network = [];
  const pageErrors = [];
  const observedFrames = [];
  observedFrames.listeners = [];

  const browser = await launchBrowser(args.headed);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1"
  });
  const page = await context.newPage();

  page.on("console", (message) => {
    consoleLines.push(`[${message.type()}] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.stack || error.message);
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) {
      network.push({ status, url: response.url() });
    }
  });
  page.on("websocket", (ws) => {
    const socketRecord = { url: ws.url(), frames: [] };
    network.push({ websocket: socketRecord.url });
    ws.on("framesent", (event) => {
      captureWsFrame("send", event.payload, socketRecord, observedFrames);
    });
    ws.on("framereceived", (event) => {
      captureWsFrame("receive", event.payload, socketRecord, observedFrames);
    });
  });

  const result = {
    url: args.url,
    out: args.out,
    canvasVisible: false,
    startClicked: false,
    enterResponseCmd: null,
    betRequestCmd: null,
    betResponseCmd: null,
    triggerMethod: null,
    verdict: "FAIL"
  };

  try {
    await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("canvas#GameCanvas", { state: "visible", timeout: 60000 });
    result.canvasVisible = true;

    const enterFrame = await waitForObservedCmd(observedFrames, 40001, "receive", 90000);
    result.enterResponseCmd = enterFrame.cmd;
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(args.out, "screenshot-enter.png"), fullPage: true });

    await clickStartButton(page);
    result.startClicked = true;
    await page.waitForTimeout(3000);

    result.triggerMethod = await triggerBet(page);
    const betRequest = await waitForObservedCmd(observedFrames, 40002, "send", 20000).catch(() => null);
    if (!betRequest) {
      await page.mouse.click(332, 738);
      result.triggerMethod = `${result.triggerMethod}+canvas-click`;
    }
    const finalBetRequest = await waitForObservedCmd(observedFrames, 40002, "send", 30000);
    const betResponse = await waitForObservedCmd(observedFrames, 40003, "receive", 30000);
    result.betRequestCmd = finalBetRequest.cmd;
    result.betResponseCmd = betResponse.cmd;
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(args.out, "screenshot-after-bet.png"), fullPage: true });

    result.verdict = "PASS";
  } finally {
    await writeFile(path.join(args.out, "console.log"), `${consoleLines.join("\n")}\n`, "utf8");
    await writeFile(path.join(args.out, "network.json"), `${JSON.stringify({ network, observedFrames, pageErrors }, null, 2)}\n`, "utf8");
    await writeReport(args.out, result, pageErrors, network, observedFrames);
    await browser.close();
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.verdict !== "PASS") {
    process.exit(1);
  }
}

function captureWsFrame(direction, payload, socketRecord, observedFrames) {
  const buffer = framePayloadToBuffer(payload);
  if (buffer.length < 12) {
    return;
  }
  try {
    const parsed = parseFrameBase64(buffer);
    const record = {
      direction,
      cmd: parsed.cmd,
      rawCmd: parsed.rawCmd,
      bytes: buffer.length
    };
    socketRecord.frames.push(record);
    recordFrame(observedFrames, record);
  } catch {
    // Ignore non-game websocket frames.
  }
}

async function triggerBet(page) {
  return page.evaluate(() => {
    const req = window.__require;
    if (typeof req !== "function") {
      return "no-__require";
    }

    try {
      const gameNetModule = req("GameNet_dy_mjlltwo_en");
      const gameNet = gameNetModule?.default?.getInstance?.();
      if (gameNet && typeof gameNet.requestNormalSpin === "function") {
        gameNet.requestNormalSpin();
        return "GameNet.requestNormalSpin";
      }
    } catch (error) {
      console.warn("GameNet requestNormalSpin failed", error);
    }

    try {
      const netModule = req("net_dy_mjlltwo_en");
      const request = netModule?.dy_mjlltwo_en_request;
      if (request && typeof request.USER_ROTATE_NORMAL_REQ === "function") {
        request.USER_ROTATE_NORMAL_REQ({ betMult: 20 });
        return "net.USER_ROTATE_NORMAL_REQ";
      }
    } catch (error) {
      console.warn("direct USER_ROTATE_NORMAL_REQ failed", error);
    }

    return "no-trigger-hook";
  });
}

async function clickStartButton(page) {
  const viewport = page.viewportSize() || { width: 390, height: 844 };
  const x = Math.round(viewport.width / 2);
  const y = Math.round(viewport.height * 0.735);
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(800);
  await page.touchscreen.tap(x, y);
}

async function writeReport(outDir, result, pageErrors, network, observedFrames) {
  const lines = [
    "# Boya Mahjong2 Bet Verification",
    "",
    `- verdict: ${result.verdict}`,
    `- url: ${result.url}`,
    `- canvasVisible: ${result.canvasVisible}`,
    `- startClicked: ${result.startClicked}`,
    `- enterResponseCmd: ${result.enterResponseCmd}`,
    `- betRequestCmd: ${result.betRequestCmd}`,
    `- betResponseCmd: ${result.betResponseCmd}`,
    `- triggerMethod: ${result.triggerMethod}`,
    `- pageerror: ${pageErrors.length}`,
    `- networkErrors: ${network.filter((item) => item.status >= 400).length}`,
    `- observedFrameCount: ${observedFrames.length}`,
    "",
    "## Screenshots",
    "",
    "- screenshot-enter.png",
    "- screenshot-after-bet.png",
    ""
  ];
  await writeFile(path.join(outDir, "report.md"), `${lines.join("\n")}\n`, "utf8");
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
