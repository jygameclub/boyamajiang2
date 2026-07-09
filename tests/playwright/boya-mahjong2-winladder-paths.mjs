#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import { decodeBoyaRotateFromPayload, parseFrameBase64 } from "../../tools/lib/boya-har.mjs";

function parseArgs(argv) {
  const args = {
    url: "http://127.0.0.1:18082/__game/winladder",
    out: "",
    spins: 6,
    heartbeatWaitMs: 70000,
    headed: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") args.url = argv[++index];
    else if (arg === "--out") args.out = argv[++index];
    else if (arg === "--spins") args.spins = Number(argv[++index]);
    else if (arg === "--heartbeat-wait-ms") args.heartbeatWaitMs = Number(argv[++index]);
    else if (arg === "--headed") args.headed = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.out) {
    throw new Error("--out is required");
  }
  return args;
}

function framePayloadToBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (typeof payload === "string") return Buffer.from(payload, "base64");
  return Buffer.alloc(0);
}

function summarizeRotate(payload) {
  const rotate = decodeBoyaRotateFromPayload(payload);
  const lineSum = rotate.lines.reduce((sum, line) => sum + (line.score || 0), 0);
  return {
    totalWin: rotate.totalWin,
    roundWin: rotate.roundWin,
    roundScore: rotate.roundScore,
    lineSum,
    lines: rotate.lines,
    status: rotate.status,
    originalStatus: rotate.originalStatus,
    purchase: rotate.purchase,
    freeRemainCount: rotate.freeRemainCount,
    freeTotalWin: rotate.freeTotalWin,
    goldToWildPos: rotate.goldToWildPos,
    drawResult: rotate.drawResult,
    topResult: rotate.topResult,
    buttomResult: rotate.buttomResult
  };
}

function captureWsFrame(direction, payload, observedFrames) {
  const buffer = framePayloadToBuffer(payload);
  if (buffer.length < 12) return;
  try {
    const parsed = parseFrameBase64(buffer);
    const record = {
      id: observedFrames.length + 1,
      direction,
      cmd: parsed.cmd,
      rawCmd: parsed.rawCmd,
      bytes: buffer.length
    };
    if (parsed.cmd === 40003 || parsed.cmd === 40005 || parsed.cmd === 40007) {
      record.rotate = summarizeRotate(parsed.payload);
    }
    observedFrames.push(record);
    for (const listener of [...observedFrames.listeners]) listener(record);
  } catch {
    // Ignore non-game frames.
  }
}

function waitForFrame(observedFrames, predicate, timeoutMs, label) {
  const existing = observedFrames.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    function listener(frame) {
      if (predicate(frame)) {
        cleanup();
        resolve(frame);
      }
    }
    function cleanup() {
      clearTimeout(timer);
      const index = observedFrames.listeners.indexOf(listener);
      if (index >= 0) observedFrames.listeners.splice(index, 1);
    }
    observedFrames.listeners.push(listener);
  });
}

async function launch(headed) {
  const options = {
    headless: !headed,
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--ignore-gpu-blocklist",
      "--enable-webgl"
    ]
  };
  try {
    return await chromium.launch(options);
  } catch {
    return chromium.launch({ ...options, channel: "chrome" });
  }
}

async function clickAndWait(page, x, y, delayMs = 600) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(delayMs);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });

  const consoleLines = [];
  const pageErrors = [];
  const httpErrors = [];
  const observedFrames = [];
  observedFrames.listeners = [];
  const clientCloses = [];
  let testActive = true;

  const browser = await launch(args.headed);
  const context = await browser.newContext({
    viewport: { width: 900, height: 1400 },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();

  page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      httpErrors.push({ status: response.status(), url: response.url() });
    }
  });
  page.on("websocket", (ws) => {
    ws.on("framesent", (event) => captureWsFrame("send", event.payload, observedFrames));
    ws.on("framereceived", (event) => captureWsFrame("receive", event.payload, observedFrames));
    ws.on("close", () => {
      if (testActive) clientCloses.push({ url: ws.url(), frameCount: observedFrames.length });
    });
  });

  const spinResults = [];
  const freeSpinResults = [];
  const result = {
    verdict: "FAIL",
    url: args.url,
    out: args.out,
    spins: args.spins,
    heartbeatWaitMs: args.heartbeatWaitMs,
    finalUrl: null
  };

  try {
    await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("canvas#GameCanvas", { state: "visible", timeout: 60000 });
    await waitForFrame(observedFrames, (frame) => frame.direction === "receive" && frame.cmd === 40001, 90000, "40001 enter");
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(args.out, "00-enter-before-start.png"), fullPage: true });

    await clickAndWait(page, 450, 1075, 2500);
    await page.screenshot({ path: path.join(args.out, "01-started.png"), fullPage: true });

    const beforeSpin = observedFrames.length;
    await clickAndWait(page, 145, 1090, 800);
    await page.screenshot({ path: path.join(args.out, "02-buy-open.png"), fullPage: true });
    await clickAndWait(page, 590, 1150, 1000);
    const trigger = await waitForFrame(
      observedFrames,
      (frame) => frame.id > beforeSpin && frame.direction === "receive" && frame.cmd === 40007,
      45000,
      "40007 winladder free trigger"
    );
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(args.out, "03-free-entry.png"), fullPage: true });
    freeSpinResults.push({ type: "trigger", frameId: trigger.id, rotate: trigger.rotate });

    let lastSeenFrameId = trigger.id;
    for (let spin = 0; spin < args.spins; spin += 1) {
      const response = await waitForFrame(
        observedFrames,
        (frame) => (
          frame.id > lastSeenFrameId
          && frame.direction === "receive"
          && frame.cmd === 40005
          && (frame.rotate?.lines || []).length > 0
        ),
        90000,
        `40005 free win ${spin + 1}`
      );
      lastSeenFrameId = response.id;
      await page.waitForTimeout(1800);
      await page.screenshot({ path: path.join(args.out, `spin-${String(spin + 1).padStart(2, "0")}-highlight.png`), fullPage: true });
      await page.waitForTimeout(6500);
      await page.screenshot({ path: path.join(args.out, `spin-${String(spin + 1).padStart(2, "0")}-settled.png`), fullPage: true });

      const rotate = response.rotate;
      const visibleSymbols = new Set([
        ...(rotate?.drawResult || []),
        ...(rotate?.topResult || []),
        ...(rotate?.buttomResult || [])
      ]);
      spinResults.push({
        spin: spin + 1,
        frameId: response.id,
        totalWin: rotate?.totalWin,
        roundWin: rotate?.roundWin,
        freeTotalWin: rotate?.freeTotalWin,
        lineSum: rotate?.lineSum,
        lines: rotate?.lines || [],
        status: rotate?.status,
        originalStatus: rotate?.originalStatus,
        purchase: rotate?.purchase,
        freeRemainCount: rotate?.freeRemainCount,
        lineIconsOnBoard: (rotate?.lines || []).every((line) => visibleSymbols.has(line.iconId))
      });
      freeSpinResults.push({ type: "cascade", frameId: response.id, rotate });
    }

    await page.waitForTimeout(args.heartbeatWaitMs);
    await page.screenshot({ path: path.join(args.out, "after-heartbeat-wait.png"), fullPage: true });

    result.finalUrl = page.url();
    const spinConsistency = spinResults.every((spin) => (
      spin.lines.length > 0
      && spin.roundWin === spin.lineSum
      && spin.totalWin >= spin.roundWin
      && spin.lineIconsOnBoard
      && spin.status === 1
      && spin.originalStatus === 1
      && spin.purchase === true
    ));
    const expectedWins = [400, 1200, 2400, 6000, 12000, 20000].slice(0, args.spins);
    const winsMatch = spinResults.every((spin, index) => spin.roundWin === expectedWins[index]);
    const hasLoginTimeout = consoleLines.some((line) => /登录超时|登录认证超时|loginAuthFail|Login authentication timed out/.test(line));
    result.verdict = spinConsistency && winsMatch && !hasLoginTimeout && !httpErrors.length && !clientCloses.length && !pageErrors.length
      ? "PASS"
      : "FAIL";
  } finally {
    testActive = false;
    const report = {
      ...result,
      pageErrors,
      httpErrors,
      clientCloses,
      spinResults,
      freeSpinResults,
      counts: {
        send40002: observedFrames.filter((frame) => frame.direction === "send" && frame.cmd === 40002).length,
        receive40003: observedFrames.filter((frame) => frame.direction === "receive" && frame.cmd === 40003).length,
        send40006: observedFrames.filter((frame) => frame.direction === "send" && frame.cmd === 40006).length,
        receive40007: observedFrames.filter((frame) => frame.direction === "receive" && frame.cmd === 40007).length,
        send40004: observedFrames.filter((frame) => frame.direction === "send" && frame.cmd === 40004).length,
        receive40005: observedFrames.filter((frame) => frame.direction === "receive" && frame.cmd === 40005).length,
        send5000: observedFrames.filter((frame) => frame.direction === "send" && frame.cmd === 5000).length,
        receive5001: observedFrames.filter((frame) => frame.direction === "receive" && frame.cmd === 5001).length
      }
    };
    await writeFile(path.join(args.out, "console.log"), `${consoleLines.join("\n")}\n`, "utf8");
    await writeFile(path.join(args.out, "network.json"), `${JSON.stringify({ ...report, observedFrames }, null, 2)}\n`, "utf8");
    await writeFile(path.join(args.out, "report.md"), buildReport(report), "utf8");
    await browser.close();
    console.log(JSON.stringify(report, null, 2));
    if (report.verdict !== "PASS") process.exit(1);
  }
}

function buildReport(report) {
  return `${[
    "# Boya Mahjong2 Winladder Free-Cascade Path/Payout Verification",
    "",
    `- verdict: ${report.verdict}`,
    `- url: ${report.url}`,
    `- finalUrl: ${report.finalUrl}`,
    `- spins: ${report.spins}`,
    `- heartbeatWaitMs: ${report.heartbeatWaitMs}`,
    `- httpErrors: ${report.httpErrors.length}`,
    `- pageErrors: ${report.pageErrors.length}`,
    `- clientCloses: ${report.clientCloses.length}`,
    `- send40002/receive40003: ${report.counts.send40002}/${report.counts.receive40003}`,
    `- send40006/receive40007: ${report.counts.send40006}/${report.counts.receive40007}`,
    `- send40004/receive40005: ${report.counts.send40004}/${report.counts.receive40005}`,
    `- send5000/receive5001: ${report.counts.send5000}/${report.counts.receive5001}`,
    "",
    "## Win Results",
    "",
    ...report.spinResults.map((spin) => `- win ${spin.spin}: round=${spin.roundWin}, total=${spin.totalWin}, lineSum=${spin.lineSum}, lines=${spin.lines.length}, iconsOnBoard=${spin.lineIconsOnBoard}`),
    "",
    "## Screenshots",
    "",
    "- spin-01-highlight.png ... spin-06-highlight.png",
    "- after-heartbeat-wait.png",
    ""
  ].join("\n")}\n`;
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
