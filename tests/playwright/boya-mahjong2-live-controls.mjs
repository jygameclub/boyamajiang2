#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import {
  clickUntilObservedFrame,
  decodeObservedFrame,
  waitForObservedFrame as waitForFrame
} from "./boya-observed-frame.mjs";

function parseArgs(argv) {
  const args = { baseUrl: "http://127.0.0.1:18082", out: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base-url") args.baseUrl = argv[++index];
    else if (argv[index] === "--out") args.out = argv[++index];
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!args.out) throw new Error("--out is required");
  return args;
}

function bindPage(page, diagnostics, frames) {
  let active = true;
  page.on("console", (message) => {
    const text = `[${message.type()}] ${message.text()}`;
    diagnostics.console.push(text);
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.stack || error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      diagnostics.httpErrors.push({ status: response.status(), url: response.url() });
    }
  });
  page.on("websocket", (socket) => {
    socket.on("framesent", (event) => {
      const frame = decodeObservedFrame("send", event.payload, frames.length + 1);
      if (frame) {
        frames.push(frame);
        frames.listeners.forEach((listener) => listener(frame));
      }
    });
    socket.on("framereceived", (event) => {
      const frame = decodeObservedFrame("receive", event.payload, frames.length + 1);
      if (frame) {
        frames.push(frame);
        frames.listeners.forEach((listener) => listener(frame));
      }
    });
    socket.on("close", () => {
      if (active) diagnostics.clientCloses.push(socket.url());
    });
  });
  return () => { active = false; };
}

async function api(baseUrl, pathname) {
  const response = await fetch(new URL(pathname, baseUrl));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${pathname}`);
  const payload = await response.json();
  return payload?.data ?? payload;
}

async function openGame({ browser, baseUrl, out, name, diagnostics, frames }) {
  const context = await browser.newContext({ viewport: { width: 900, height: 1400 } });
  const page = await context.newPage();
  const deactivate = bindPage(page, diagnostics, frames);
  const start = frames.length;
  await page.goto(new URL("/__game/live", baseUrl).toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await page.waitForSelector("canvas#GameCanvas", { state: "visible", timeout: 60000 });
  await waitForFrame(
    frames,
    (frame) => frame.id > start && frame.direction === "receive" && frame.cmd === 40001,
    90000,
    `${name} 40001`
  );
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, `${name}-enter.png`) });
  await page.mouse.click(450, 1075);
  await page.waitForTimeout(7000);
  return {
    context,
    page,
    async close() {
      deactivate();
      await context.close();
    }
  };
}

async function verifyAuto(options) {
  const opened = await openGame({ ...options, name: "auto" });
  const { page } = opened;
  await page.mouse.click(635, 1305);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(options.out, "auto-dialog.png") });
  const start = options.frames.length;
  await page.mouse.click(450, 1190);
  const requests = [];
  let previousId = start;
  for (let index = 0; index < 3; index += 1) {
    const request = await waitForFrame(
      options.frames,
      (frame) => frame.id > previousId && frame.direction === "send" && frame.cmd === 40002,
      60000,
      `auto 40002 #${index + 1}`
    );
    requests.push(request);
    previousId = request.id;
  }
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(options.out, "auto-running.png") });
  const responses = options.frames.filter((frame) => (
    frame.id > start && frame.direction === "receive" && frame.cmd === 40003
  ));
  await opened.close();
  return { requests: requests.length, responses: responses.length };
}

async function verifyBet(options) {
  const opened = await openGame({ ...options, name: "bet" });
  const { page } = opened;
  await page.mouse.click(570, 1185);
  await page.waitForTimeout(800);
  const start = options.frames.length;
  const request = await clickUntilObservedFrame({
    page,
    frames: options.frames,
    predicate: (frame) => frame.id > start && frame.direction === "send" && frame.cmd === 40002,
    x: 450,
    y: 1315,
    timeoutMs: 30000,
    label: "dynamic bet 40002"
  });
  const response = await waitForFrame(
    options.frames,
    (frame) => frame.id > request.id && frame.direction === "receive" && frame.cmd === 40003,
    45000,
    "dynamic bet 40003"
  );
  await page.waitForTimeout(2800);
  await page.screenshot({ path: path.join(options.out, "bet-20-result.png") });
  await opened.close();
  return {
    betMulti: response.rotate.betMulti,
    betCoin: response.rotate.betCoin,
    roundWin: response.rotate.roundWin
  };
}

async function verifyBuy(options) {
  const opened = await openGame({ ...options, name: "buy" });
  const { page } = opened;
  await page.mouse.click(570, 1185);
  await page.waitForTimeout(800);
  await page.mouse.click(145, 1090);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(options.out, "buy-dialog-20.png") });
  const start = options.frames.length;
  await page.mouse.click(590, 1150);
  const trigger = await waitForFrame(
    options.frames,
    (frame) => frame.id > start && frame.direction === "receive" && frame.cmd === 40007,
    45000,
    "buy 40007"
  );
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(options.out, "buy-trigger.png") });
  const firstFree = await waitForFrame(
    options.frames,
    (frame) => frame.id > trigger.id && frame.direction === "receive" && frame.cmd === 40005,
    90000,
    "buy first 40005"
  );
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(options.out, "buy-first-free.png") });
  const scatterPositions = trigger.rotate.drawResult
    .map((symbol, index) => symbol === 1 ? index : null)
    .filter((index) => index !== null);
  await opened.close();
  return {
    betMulti: trigger.rotate.betMulti,
    buyCost: trigger.rotate.betCoin,
    scatterCount: scatterPositions.length,
    scatterPositions,
    freeCount: trigger.rotate.freeRemainCount,
    firstFreeBetMulti: firstFree.rotate.betMulti,
    firstFreeBetCoin: firstFree.rotate.betCoin,
    firstFreeRoundWin: firstFree.rotate.roundWin
  };
}

async function verifyHistory(options) {
  const opened = await openGame({ ...options, name: "history" });
  const { page } = opened;
  await page.mouse.click(785, 1305);
  await page.waitForTimeout(1000);
  const start = options.frames.length;
  await page.mouse.click(518, 1305);
  const list = await waitForFrame(
    options.frames,
    (frame) => frame.id > start && frame.direction === "receive" && frame.cmd === 20048,
    30000,
    "history 20048"
  );
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(options.out, "history-list.png") });
  await page.mouse.click(795, 310);
  const detail = await waitForFrame(
    options.frames,
    (frame) => frame.id > list.id && frame.direction === "receive" && frame.cmd === 20052,
    30000,
    "history 20052"
  );
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(options.out, "history-detail.png") });
  await opened.close();
  return { listBytes: list.bytes, detailBytes: detail.bytes };
}

function markdown(report) {
  return `${[
    "# Boya Mahjong2 live controls verification",
    "",
    `- verdict: ${report.verdict}`,
    `- baseUrl: ${report.baseUrl}`,
    `- error: ${report.error || "none"}`,
    `- HTTP >= 400: ${report.diagnostics.httpErrors.length}`,
    `- pageErrors: ${report.diagnostics.pageErrors.length}`,
    `- clientCloses: ${report.diagnostics.clientCloses.length}`,
    `- authTimeout: ${report.authTimeout}`,
    `- serverMismatches: ${report.serverMismatches}`,
    "",
    "## Controls",
    "",
    `- auto: requests=${report.auto?.requests}, responses=${report.auto?.responses}`,
    `- bet: betMulti=${report.bet?.betMulti}, betCoin=${report.bet?.betCoin}, roundWin=${report.bet?.roundWin}`,
    `- buy: cost=${report.buy?.buyCost}, scatter=${report.buy?.scatterCount}, positions=${report.buy?.scatterPositions?.join(",")}, free=${report.buy?.freeCount}`,
    `- buy first free: betMulti=${report.buy?.firstFreeBetMulti}, betCoin=${report.buy?.firstFreeBetCoin}, roundWin=${report.buy?.firstFreeRoundWin}`,
    `- in-game history: list=${report.history?.listBytes} bytes, detail=${report.history?.detailBytes} bytes`,
    `- persisted live rows: ${report.persistedLiveRows}`,
    ""
  ].join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
await mkdir(args.out, { recursive: true });
const diagnostics = { console: [], pageErrors: [], httpErrors: [], clientCloses: [] };
const frames = [];
frames.listeners = [];
const report = { baseUrl: args.baseUrl, diagnostics, verdict: "FAIL" };
let browser;

try {
  browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"]
  });
  const options = { browser, baseUrl: args.baseUrl, out: args.out, diagnostics, frames };
  report.auto = await verifyAuto(options);
  report.bet = await verifyBet(options);
  report.buy = await verifyBuy(options);
  report.history = await verifyHistory(options);
  const rounds = await api(args.baseUrl, "/api/history/rounds?mode=live&limit=20");
  const replayHistory = await api(args.baseUrl, "/__history.json");
  report.persistedLiveRows = rounds.length;
  report.serverMismatches = replayHistory.counts.mismatches;
  report.authTimeout = diagnostics.console.some((line) => /登录超时|登录认证超时|loginAuthFail/i.test(line));
  const fixedTrigger = JSON.stringify(report.buy.scatterPositions) === JSON.stringify([3, 6, 12]);
  report.verdict = report.auto.requests >= 3
    && report.auto.responses >= 2
    && report.bet.betMulti === 100
    && report.bet.betCoin === 2000
    && report.buy.betMulti === 100
    && report.buy.buyCost === 160000
    && report.buy.scatterCount >= 3
    && !fixedTrigger
    && report.buy.freeCount >= 10
    && report.buy.firstFreeBetMulti === 100
    && report.buy.firstFreeBetCoin === 2000
    && report.history.listBytes > 12
    && report.history.detailBytes > 12
    && report.persistedLiveRows > 0
    && report.serverMismatches === 0
    && !report.authTimeout
    && diagnostics.httpErrors.length === 0
    && diagnostics.pageErrors.length === 0
    && diagnostics.clientCloses.length === 0
    ? "PASS"
    : "FAIL";
} catch (error) {
  report.error = error.stack || error.message;
} finally {
  if (browser) await browser.close();
  await writeFile(path.join(args.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(args.out, "report.md"), markdown(report));
  await writeFile(path.join(args.out, "console.log"), `${diagnostics.console.join("\n")}\n`);
}

if (report.verdict !== "PASS") process.exitCode = 1;
