#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import {
  clickUntilObservedFrame,
  decodeObservedFrame,
  waitForGameCanvas,
  waitForObservedFrame as waitForFrame
} from "./boya-observed-frame.mjs";

function parseArgs(argv) {
  const args = { baseUrl: "http://127.0.0.1:18082", out: "", token: "user2" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base-url") args.baseUrl = argv[++index];
    else if (argv[index] === "--out") args.out = argv[++index];
    else if (argv[index] === "--token") args.token = argv[++index];
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!args.out) throw new Error("--out is required");
  return args;
}

function bindPage(page, name, baseUrl, diagnostics, frames) {
  let active = true;
  const origin = new URL(baseUrl).origin;
  page.on("console", (message) => diagnostics.console.push(`[${name}:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => diagnostics.pageErrors.push({ name, error: error.stack || error.message }));
  page.on("requestfailed", (request) => diagnostics.requestFailures.push({
    name,
    url: request.url(),
    error: request.failure()?.errorText
  }));
  page.on("request", (request) => {
    const requestUrl = request.url();
    if (/^https?:/i.test(requestUrl) && new URL(requestUrl).origin !== origin) {
      diagnostics.externalRequests.push({ name, url: requestUrl });
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      diagnostics.httpErrors.push({ name, status: response.status(), url: response.url() });
    }
  });
  page.on("websocket", (socket) => {
    let replayCompleted = false;
    const observe = (direction, payload) => {
      const frame = decodeObservedFrame(direction, payload, frames.length + 1);
      if (!frame) return;
      frame.page = name;
      frame.socketUrl = socket.url();
      if (frame.direction === "receive" && frame.cmd === 70001) replayCompleted = true;
      frames.push(frame);
      frames.listeners.forEach((listener) => listener(frame));
    };
    socket.on("framesent", (event) => observe("send", event.payload));
    socket.on("framereceived", (event) => observe("receive", event.payload));
    socket.on("close", () => {
      if (active && !replayCompleted) diagnostics.clientCloses.push({ name, url: socket.url() });
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

async function waitForChildFrame(page, matcher, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => matcher(candidate.url()));
    if (frame) return frame;
    await page.waitForTimeout(100);
  }
  throw new Error("Timed out waiting for child frame");
}

async function waitForChildFrameGone(page, matcher, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!page.frames().some((candidate) => matcher(candidate.url()))) return;
    await page.waitForTimeout(100);
  }
  throw new Error("Timed out waiting for child frame to close");
}

async function waitForNode(frame, nodeName, expected = true, timeoutMs = 30000) {
  await frame.waitForFunction(({ name, expectedState }) => {
    let found = false;
    const walk = (node) => {
      if (node.activeInHierarchy && node.name === name) found = true;
      for (const child of node.children || []) walk(child);
    };
    walk(cc.director.getScene());
    return found === expectedState;
  }, { name: nodeName, expectedState: expected }, { timeout: timeoutMs });
}

async function hasNode(frame, nodeName) {
  return frame.evaluate((name) => {
    let found = false;
    const walk = (node) => {
      if (node.activeInHierarchy && node.name === name) found = true;
      for (const child of node.children || []) walk(child);
    };
    walk(cc.director.getScene());
    return found;
  }, nodeName);
}

async function clickUntilNode({ page, frame, nodeName, expected = true, x, y, timeoutMs = 15000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(300);
    if (await hasNode(frame, nodeName) === expected) return;
  }
  throw new Error(`Timed out clicking ${nodeName} to ${expected ? "open" : "close"}`);
}

function gameFrame(page) {
  const frame = page.frames().find((candidate) => (
    candidate.url().includes("/v2/")
    && !candidate.url().includes("playid=")
    && !candidate.url().includes("/help/")
  ));
  if (!frame) throw new Error("Game frame is missing");
  return frame;
}

async function openGame(options, name) {
  const context = await options.browser.newContext({ viewport: { width: 900, height: 1400 } });
  const page = await context.newPage();
  const deactivate = bindPage(page, name, options.baseUrl, options.diagnostics, options.frames);
  const start = options.frames.length;
  await page.goto(new URL(`/__game/live?token=${encodeURIComponent(options.token)}`, options.baseUrl).toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await waitForGameCanvas(page);
  await waitForFrame(
    options.frames,
    (frame) => frame.id > start && frame.direction === "receive" && frame.cmd === 40001,
    90000,
    `${name} 40001`
  );
  await page.waitForTimeout(2500);
  await page.mouse.click(450, 1075);
  await page.waitForTimeout(7000);
  return {
    context,
    page,
    frame: gameFrame(page),
    async close() {
      deactivate();
      await context.close().catch(() => {});
    }
  };
}

async function openMenu(opened) {
  await opened.page.mouse.click(785, 1305);
  await waitForNode(opened.frame, "UIMenuPrefab");
  await opened.page.waitForTimeout(500);
}

async function controlState(frame) {
  return frame.evaluate(() => {
    const data = window.__require("data_dy_mjlltwo_en");
    const audio = window.__require("AudioManager").default.getInstance();
    return {
      isTurbo: data.gameConfigData.isTurbo,
      isAuto: data.gameConfigData.isAuto,
      betMulti: data.gameConfigData.betMulti,
      gameStartable: data.gameCacheData.isGameStartable,
      spaceEnabled: data.gameConfigData.isEnabledSpaceKey(),
      music: audio.getMusicStatus(),
      effects: audio.getEffectsStatus()
    };
  });
}

async function waitForGameReady(frame, timeoutMs = 45000) {
  await frame.waitForFunction(() => {
    const data = window.__require("data_dy_mjlltwo_en");
    return data.gameCacheData.isGameStartable === true && data.gameConfigData.isAuto === false;
  }, null, { timeout: timeoutMs });
}

async function clickUntilControlState({ page, frame, predicate, x, y, timeoutMs = 15000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await controlState(frame);
    if (predicate(state)) return state;
    await page.mouse.click(x, y);
    await page.waitForTimeout(300);
  }
  throw new Error("Timed out waiting for control state change");
}

async function verifyCoreControls(options) {
  const opened = await openGame(options, "core-controls");
  const { page, frame } = opened;
  const initial = await controlState(frame);

  const turboOn = await clickUntilControlState({
    page,
    frame,
    predicate: (state) => state.isTurbo !== initial.isTurbo,
    x: 250,
    y: 1305
  });

  const soundToggled = await clickUntilControlState({
    page,
    frame,
    predicate: (state) => state.music !== initial.music && state.effects !== initial.effects,
    x: 110,
    y: 1305
  });
  const soundRestored = await clickUntilControlState({
    page,
    frame,
    predicate: (state) => state.music === initial.music && state.effects === initial.effects,
    x: 110,
    y: 1305
  });

  const spaceStart = options.frames.length;
  await page.keyboard.press("Space");
  const spaceRequest = await waitForFrame(
    options.frames,
    (entry) => entry.id > spaceStart && entry.direction === "send" && entry.cmd === 40002,
    30000,
    "space 40002"
  );
  const spaceResponse = await waitForFrame(
    options.frames,
    (entry) => entry.id > spaceRequest.id && entry.direction === "receive" && entry.cmd === 40003,
    45000,
    "space 40003"
  );
  await waitForGameReady(frame);

  const turboOff = await clickUntilControlState({
    page,
    frame,
    predicate: (state) => state.isTurbo === initial.isTurbo,
    x: 250,
    y: 1305
  });

  const beforeBet = await controlState(frame);
  const increasedBet = await clickUntilControlState({
    page,
    frame,
    predicate: (state) => state.betMulti !== beforeBet.betMulti,
    x: 570,
    y: 1185
  });
  const betStart = options.frames.length;
  const betRequest = await clickUntilObservedFrame({
    page,
    frames: options.frames,
    predicate: (entry) => entry.id > betStart && entry.direction === "send" && entry.cmd === 40002,
    x: 450,
    y: 1315,
    timeoutMs: 30000,
    label: "increased bet 40002"
  });
  const betResponse = await waitForFrame(
    options.frames,
    (entry) => entry.id > betRequest.id && entry.direction === "receive" && entry.cmd === 40003,
    45000,
    "increased bet 40003"
  );
  await waitForGameReady(frame);
  const restoredBet = await clickUntilControlState({
    page,
    frame,
    predicate: (state) => state.betMulti === beforeBet.betMulti,
    x: 330,
    y: 1185
  });

  await clickUntilNode({ page, frame, nodeName: "UIAutoSpinPrefab", x: 635, y: 1305 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(options.out, "01-core-controls-auto-dialog.png") });
  await clickUntilNode({ page, frame, nodeName: "UIAutoSpinPrefab", expected: false, x: 450, y: 1310 });
  await page.screenshot({ path: path.join(options.out, "02-core-controls-restored.png") });
  await opened.close();

  return {
    initial,
    turboOn,
    turboOff,
    soundToggled,
    soundRestored,
    space: { request: spaceRequest.cmd, betMulti: spaceResponse.rotate.betMulti, betCoin: spaceResponse.rotate.betCoin },
    bet: {
      before: beforeBet.betMulti,
      increased: increasedBet.betMulti,
      responseMulti: betResponse.rotate.betMulti,
      responseCoin: betResponse.rotate.betCoin,
      restored: restoredBet.betMulti
    },
    autoDialog: true
  };
}

async function verifyRules(options) {
  const opened = await openGame(options, "rules");
  await openMenu(opened);
  await clickUntilNode({
    page: opened.page,
    frame: opened.frame,
    nodeName: "UIFunctionPrefab",
    x: 384,
    y: 1307
  });
  const help = await waitForChildFrame(opened.page, (url) => url.includes("/v2/help/dy_mjlltwo"));
  const text = await help.locator("body").innerText();
  await opened.page.waitForTimeout(800);
  await opened.page.screenshot({ path: path.join(options.out, "03-rules.png") });
  await clickUntilNode({
    page: opened.page,
    frame: opened.frame,
    nodeName: "UIFunctionPrefab",
    expected: false,
    x: 742,
    y: 1315
  });
  await opened.close();
  return { containsWays: text.includes("2000 Ways"), containsBuyRate: text.includes("80") };
}

async function verifyHistory(options) {
  const opened = await openGame(options, "history");
  await openMenu(opened);
  const start = options.frames.length;
  const list = await clickUntilObservedFrame({
    page: opened.page,
    frames: options.frames,
    predicate: (entry) => entry.id > start && entry.direction === "receive" && entry.cmd === 20048,
    x: 516,
    y: 1307,
    timeoutMs: 30000,
    label: "history 20048"
  });
  await opened.page.waitForTimeout(1800);
  await opened.page.screenshot({ path: path.join(options.out, "04-history-list.png") });
  await opened.page.mouse.click(795, 310);
  const detail = await waitForFrame(
    options.frames,
    (entry) => entry.id > list.id && entry.direction === "receive" && entry.cmd === 20052,
    30000,
    "history 20052"
  );
  await opened.page.waitForTimeout(2500);
  await opened.page.screenshot({ path: path.join(options.out, "05-history-detail.png") });
  await opened.close();
  return {
    listRecords: list.historyList?.records?.length || 0,
    detailRecords: detail.historyDetail?.details?.length || 0
  };
}

async function verifySettings(options) {
  const opened = await openGame(options, "settings");
  await openMenu(opened);
  await clickUntilNode({
    page: opened.page,
    frame: opened.frame,
    nodeName: "UIFunctionPrefab",
    x: 649,
    y: 1307
  });
  await opened.page.waitForTimeout(1000);

  const toggleCoordinates = [[745, 230], [745, 356], [745, 484], [745, 608], [745, 736]];
  for (const coordinate of toggleCoordinates) {
    await opened.page.mouse.click(...coordinate);
    await opened.page.waitForTimeout(180);
  }
  const storage = await opened.frame.evaluate(() => ({
    music: localStorage.getItem("com.shqp.xxxxsoundSwitch"),
    effects: localStorage.getItem("com.shqp.xxxxsoundEffectSwitch"),
    intro: localStorage.getItem("com.shqp.xxxxSHOW_DESCdy_mjlltwo"),
    fast: localStorage.getItem("com.shqp.xxxxFASTMODEdy_mjlltwo"),
    space: localStorage.getItem("com.shqp.xxxxSPACE_SCROLLdy_mjlltwo")
  }));
  await opened.page.screenshot({ path: path.join(options.out, "06-settings-toggled.png") });

  await opened.page.mouse.click(680, 870);
  await opened.page.waitForTimeout(1200);
  await opened.page.screenshot({ path: path.join(options.out, "07-language-selector.png") });
  const selectorVisible = await opened.frame.evaluate(() => {
    let found = false;
    const walk = (node) => {
      if (node.activeInHierarchy && /language|lang/i.test(node.name)) found = true;
      for (const child of node.children || []) walk(child);
    };
    walk(cc.director.getScene());
    return found;
  });
  await opened.close();
  return { storage, selectorVisible };
}

async function verifyReplayAndReentry(options) {
  const opened = await openGame(options, "replay");
  await openMenu(opened);
  const listStart = options.frames.length;
  const list = await clickUntilObservedFrame({
    page: opened.page,
    frames: options.frames,
    predicate: (entry) => entry.id > listStart && entry.direction === "receive" && entry.cmd === 20050,
    x: 786,
    y: 1307,
    timeoutMs: 30000,
    label: "playback list 20050"
  });
  await opened.page.waitForTimeout(1800);
  await opened.page.screenshot({ path: path.join(options.out, "08-replay-list.png") });

  const playbackStart = options.frames.length;
  await opened.page.mouse.click(276, 500);
  const replayFrame = await waitForChildFrame(opened.page, (url) => url.includes("playid=local-"), 30000);
  const request = await waitForFrame(
    options.frames,
    (entry) => entry.id > playbackStart && entry.direction === "send" && entry.cmd === 70000,
    30000,
    "playback 70000"
  );
  const data = await waitForFrame(
    options.frames,
    (entry) => entry.id > request.id && entry.direction === "receive" && entry.cmd === 70001,
    30000,
    "playback 70001"
  );
  await opened.page.waitForTimeout(6000);
  await opened.page.screenshot({ path: path.join(options.out, "09-replay-running.png") });
  await waitForNode(replayFrame, "ReplayOverPrefab", true, 45000);
  await opened.page.screenshot({ path: path.join(options.out, "10-replay-finished.png") });
  await opened.close();

  const reentered = await openGame(options, "reentry-after-replay");
  await reentered.page.screenshot({ path: path.join(options.out, "11-reentry-after-replay.png") });
  await reentered.close();
  return { listBytes: list.bytes, dataBytes: data.bytes, finished: true, reentered: true };
}

async function verifyLobby(options) {
  const opened = await openGame(options, "local-hub");
  await openMenu(opened);
  const start = options.frames.length;
  const response = await clickUntilObservedFrame({
    page: opened.page,
    frames: options.frames,
    predicate: (entry) => entry.id > start && entry.direction === "receive" && entry.cmd === 20153,
    x: 251,
    y: 1307,
    timeoutMs: 30000,
    label: "local hub 20153"
  });
  const activity = await waitForChildFrame(opened.page, (url) => url.includes("/v2/help/dy_activity/"));
  const text = await activity.locator("body").innerText();
  await opened.page.waitForTimeout(5500);
  const stayedOpen = opened.page.frames().includes(activity);
  await opened.page.screenshot({ path: path.join(options.out, "12-local-hub.png") });
  await activity.locator("#close").click();
  await waitForChildFrameGone(opened.page, (url) => url.includes("/v2/help/dy_activity/"));
  await opened.close();
  return { responseBytes: response.bytes, containsHub: text.includes("本地游戏大厅"), stayedOpen, closed: true };
}

async function verifyQuit(options) {
  const opened = await openGame(options, "quit");
  await openMenu(opened);
  await clickUntilNode({ page: opened.page, frame: opened.frame, nodeName: "UIQuitPopup", x: 114, y: 1307 });
  await opened.page.screenshot({ path: path.join(options.out, "13-quit-popup.png") });
  await clickUntilNode({
    page: opened.page,
    frame: opened.frame,
    nodeName: "UIQuitPopup",
    expected: false,
    x: 310,
    y: 807
  });
  await opened.page.screenshot({ path: path.join(options.out, "14-quit-cancelled.png") });
  await opened.close();
  return { popup: true, cancelled: true };
}

function markdown(report) {
  return `${[
    "# Mahjong Ways 2 Client Button Audit",
    "",
    `- verdict: ${report.verdict}`,
    `- baseUrl: ${report.baseUrl}`,
    `- token: ${report.token}`,
    `- error: ${report.error || "none"}`,
    `- HTTP >= 400: ${report.diagnostics.httpErrors.length}`,
    `- request failures: ${report.diagnostics.requestFailures.length}`,
    `- external HTTP requests: ${report.diagnostics.externalRequests.length}`,
    `- page errors: ${report.diagnostics.pageErrors.length}`,
    `- unexpected client closes: ${report.diagnostics.clientCloses.length}`,
    `- auth timeout: ${report.authTimeout}`,
    `- server mismatches: ${report.serverMismatches}`,
    "",
    "## Controls",
    "",
    `- turbo: ${report.core?.initial?.isTurbo} -> ${report.core?.turboOn?.isTurbo} -> ${report.core?.turboOff?.isTurbo}`,
    `- sound restored: ${report.core?.soundRestored?.music}/${report.core?.soundRestored?.effects}`,
    `- space spin: ${report.core?.space?.request}, bet=${report.core?.space?.betCoin}`,
    `- bet multiplier: ${report.core?.bet?.before} -> ${report.core?.bet?.increased} -> ${report.core?.bet?.restored}`,
    `- auto dialog: ${report.core?.autoDialog}`,
    `- rules: ${report.rules?.containsWays}/${report.rules?.containsBuyRate}`,
    `- history list/detail: ${report.history?.listRecords}/${report.history?.detailRecords}`,
    `- settings selector: ${report.settings?.selectorVisible}`,
    `- replay finish/reentry: ${report.replay?.finished}/${report.replay?.reentered}`,
    `- local hub open/close: ${report.lobby?.stayedOpen}/${report.lobby?.closed}`,
    `- quit popup/cancel: ${report.quit?.popup}/${report.quit?.cancelled}`,
    ""
  ].join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
await mkdir(args.out, { recursive: true });
const diagnostics = {
  console: [],
  httpErrors: [],
  requestFailures: [],
  externalRequests: [],
  pageErrors: [],
  clientCloses: []
};
const frames = [];
frames.listeners = [];
const report = { baseUrl: args.baseUrl, token: args.token, diagnostics, verdict: "FAIL" };
let browser;

try {
  browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"]
  });
  const options = { ...args, browser, diagnostics, frames };
  report.core = await verifyCoreControls(options);
  report.rules = await verifyRules(options);
  report.history = await verifyHistory(options);
  report.settings = await verifySettings(options);
  report.replay = await verifyReplayAndReentry(options);
  report.lobby = await verifyLobby(options);
  report.quit = await verifyQuit(options);
  const serverHistory = await api(args.baseUrl, "/__history.json");
  report.serverMismatches = serverHistory.counts.mismatches;
  report.authTimeout = diagnostics.console.some((line) => /登录超时|登录认证超时|loginAuthFail/i.test(line));

  const corePass = report.core.turboOn.isTurbo === true
    && report.core.turboOff.isTurbo === report.core.initial.isTurbo
    && report.core.soundToggled.music !== report.core.initial.music
    && report.core.soundToggled.effects !== report.core.initial.effects
    && report.core.soundRestored.music === report.core.initial.music
    && report.core.soundRestored.effects === report.core.initial.effects
    && report.core.space.request === 40002
    && report.core.bet.increased !== report.core.bet.before
    && report.core.bet.responseMulti === report.core.bet.increased
    && report.core.bet.restored === report.core.bet.before
    && report.core.autoDialog;
  const settingsSaved = Object.values(report.settings.storage).every((value) => value === "0" || value === "1");
  report.verdict = corePass
    && report.rules.containsWays
    && report.rules.containsBuyRate
    && report.history.listRecords > 0
    && report.history.detailRecords > 0
    && settingsSaved
    && report.settings.selectorVisible
    && report.replay.finished
    && report.replay.reentered
    && report.lobby.containsHub
    && report.lobby.stayedOpen
    && report.lobby.closed
    && report.quit.popup
    && report.quit.cancelled
    && report.serverMismatches === 0
    && !report.authTimeout
    && diagnostics.httpErrors.length === 0
    && diagnostics.requestFailures.length === 0
    && diagnostics.externalRequests.length === 0
    && diagnostics.pageErrors.length === 0
    && diagnostics.clientCloses.length === 0
    ? "PASS"
    : "FAIL";
} catch (error) {
  report.error = error.stack || error.message;
} finally {
  if (browser) await browser.close().catch(() => {});
  await writeFile(path.join(args.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(args.out, "report.md"), markdown(report));
  await writeFile(path.join(args.out, "console.log"), `${diagnostics.console.join("\n")}\n`);
}

if (report.verdict !== "PASS") process.exitCode = 1;
