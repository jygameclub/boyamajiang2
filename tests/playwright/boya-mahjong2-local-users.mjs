#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import {
  clickUntilObservedFrame,
  collectRotateSequence,
  decodeObservedFrame,
  waitForGameCanvas,
  waitForObservedFrame as waitForFrame
} from "./boya-observed-frame.mjs";

const TOKENS = ["user1", "user2", "usergame1"];
const DEFAULT_BALANCE = 100_000_000;
const HIGHLIGHT_DELAY_MS = 2700;

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

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(new URL(pathname, baseUrl), options);
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}: ${pathname}`);
  return payload.data;
}

function bindPage(page, token, diagnostics, frames, socketUrls) {
  let active = true;
  page.on("console", (message) => diagnostics.console.push(`[${token}][${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => diagnostics.pageErrors.push({ token, error: error.stack || error.message }));
  page.on("response", (response) => {
    if (response.status() >= 400) diagnostics.httpErrors.push({ token, status: response.status(), url: response.url() });
  });
  page.on("websocket", (socket) => {
    socketUrls.push(socket.url());
    for (const [event, direction] of [["framesent", "send"], ["framereceived", "receive"]]) {
      socket.on(event, (entry) => {
        const frame = decodeObservedFrame(direction, entry.payload, frames.length + 1);
        if (!frame) return;
        frame.token = token;
        frames.push(frame);
        frames.listeners.forEach((listener) => listener(frame));
      });
    }
    socket.on("close", () => {
      if (active) diagnostics.clientCloses.push({ token, url: socket.url() });
    });
  });
  return () => { active = false; };
}

async function openUserGame({ browser, baseUrl, out, token, diagnostics, frames }) {
  const context = await browser.newContext({ viewport: { width: 900, height: 1400 } });
  const page = await context.newPage();
  const socketUrls = [];
  const deactivate = bindPage(page, token, diagnostics, frames, socketUrls);
  const start = frames.length;
  await page.goto(new URL(`/__game/live?token=${encodeURIComponent(token)}`, baseUrl).toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await waitForGameCanvas(page);
  const enter = await waitForFrame(
    frames,
    (frame) => frame.id > start && frame.token === token && frame.direction === "receive" && frame.cmd === 40001,
    90000,
    `${token} 40001`
  );
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, `${token}-enter.png`) });
  await page.mouse.click(450, 1075);
  await page.waitForTimeout(7000);
  return {
    context,
    page,
    socketUrls,
    enterBalance: enter.enterBalance,
    finalUrl: page.url(),
    async close() {
      deactivate();
      await context.close();
    }
  };
}

async function spinOnce({ opened, token, out, frames }) {
  const start = frames.length;
  const request = await clickUntilObservedFrame({
    page: opened.page,
    frames,
    predicate: (frame) => frame.id > start && frame.token === token
      && frame.direction === "send" && frame.cmd === 40002,
    x: 450,
    y: 1315,
    timeoutMs: 45000,
    label: `${token} 40002`
  });
  const first = await waitForFrame(
    frames,
    (frame) => frame.id > request.id && frame.token === token
      && frame.direction === "receive" && frame.cmd === 40003,
    45000,
    `${token} first 40003`
  );
  await opened.page.waitForTimeout(first.rotate.lines.length ? HIGHLIGHT_DELAY_MS : 2400);
  await opened.page.screenshot({ path: path.join(out, `${token}-spin.png`) });
  const sequence = await collectRotateSequence({
    frames,
    firstFrame: first,
    responseCmd: 40003,
    timeoutMs: 60000,
    label: `${token} terminal 40003`
  });
  const terminal = sequence.at(-1).rotate;
  await opened.page.waitForTimeout(1800);
  return {
    bet: first.rotate.betCoin,
    totalWin: terminal.totalWin,
    finalBalance: terminal.coin,
    steps: sequence.map((frame) => ({
      roundWin: frame.rotate.roundWin,
      totalWin: frame.rotate.totalWin,
      lineCount: frame.rotate.lines.length,
      gameNum: frame.rotate.gameNum
    }))
  };
}

async function openInGameHistory({ opened, token, out, frames }) {
  await opened.page.mouse.click(785, 1305);
  await opened.page.waitForTimeout(1000);
  const start = frames.length;
  await opened.page.mouse.click(518, 1305);
  const list = await waitForFrame(
    frames,
    (frame) => frame.id > start && frame.token === token
      && frame.direction === "receive" && frame.cmd === 20048,
    30000,
    `${token} history 20048`
  );
  await opened.page.waitForTimeout(2500);
  await opened.page.screenshot({ path: path.join(out, `${token}-history-list.png`) });
  if (!list.historyList.records.length) throw new Error(`${token} history list is empty`);
  await opened.page.mouse.click(795, 310);
  const detail = await waitForFrame(
    frames,
    (frame) => frame.id > list.id && frame.token === token
      && frame.direction === "receive" && frame.cmd === 20052,
    30000,
    `${token} history 20052`
  );
  await opened.page.waitForTimeout(5000);
  await opened.page.screenshot({ path: path.join(out, `${token}-history-detail.png`) });
  return {
    records: list.historyList.records,
    detailBetId: detail.historyDetail.betId,
    detailRows: detail.historyDetail.details.length
  };
}

function calculateStats(rounds) {
  const totalWager = rounds.reduce((sum, round) => (
    sum + (round.kind === "base" ? round.bet : round.kind === "buy" ? round.buyCost : 0)
  ), 0);
  const totalWin = rounds.reduce((sum, round) => (
    sum + (round.kind === "base" || round.kind === "free-feature" ? round.totalWin : 0)
  ), 0);
  return {
    totalWager,
    totalWin,
    rtp: totalWager > 0 ? totalWin / totalWager : 0
  };
}

async function verifyAdmin({ browser, baseUrl, out, diagnostics }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => diagnostics.pageErrors.push({ token: "admin", error: error.message }));
  page.on("response", (response) => {
    if (response.status() >= 400) diagnostics.httpErrors.push({ token: "admin", status: response.status(), url: response.url() });
  });
  await page.goto(new URL("/__admin", baseUrl).toString(), { waitUntil: "networkidle" });
  await page.locator('.tab[data-tab="users"]').click();
  await page.waitForFunction((tokens) => tokens.every((token) => document.querySelector("#user-rows")?.textContent.includes(token)), TOKENS);
  await page.screenshot({ path: path.join(out, "admin-users.png"), fullPage: true });
  const userTableText = await page.locator("#user-rows").textContent();
  await page.locator('[data-user-history="usergame1"]').click();
  await page.waitForFunction(() => document.querySelector("#history-token")?.value === "usergame1");
  await page.waitForFunction(() => [...document.querySelectorAll("#history-rows tr")].some((row) => row.textContent.includes("usergame1")));
  await page.screenshot({ path: path.join(out, "admin-usergame1-history.png"), fullPage: true });
  const historyTokens = await page.locator("#history-rows tr").evaluateAll((rows) => rows.map((row) => row.children[2]?.textContent.trim()));
  await context.close();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobile = await mobileContext.newPage();
  await mobile.goto(new URL("/__admin#users", baseUrl).toString(), { waitUntil: "networkidle" });
  await mobile.waitForFunction((tokens) => tokens.every((token) => document.querySelector("#user-rows")?.textContent.includes(token)), TOKENS);
  await mobile.screenshot({ path: path.join(out, "admin-users-mobile.png"), fullPage: true });
  const mobileOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  await mobileContext.close();
  return { userTableText, historyTokens, mobileOverflow };
}

function markdown(report) {
  return `${[
    "# Boya Mahjong2 local user verification",
    "",
    `- verdict: ${report.verdict}`,
    `- error: ${report.error || "none"}`,
    `- HTTP >= 400: ${report.diagnostics.httpErrors.length}`,
    `- pageErrors: ${report.diagnostics.pageErrors.length}`,
    `- clientCloses: ${report.diagnostics.clientCloses.length}`,
    `- authTimeout: ${report.authTimeout}`,
    `- serverMismatches: ${report.serverMismatches}`,
    "",
    ...TOKENS.map((token) => {
      const user = report.users?.[token];
      return `- ${token}: enter=${user?.enterBalance}, final=${user?.spin?.finalBalance}, rounds=${user?.rounds?.length}, RTP=${user?.stats?.rtp}`;
    }),
    `- game history: ${report.gameHistory?.records?.length || 0} records, detailRows=${report.gameHistory?.detailRows || 0}`,
    `- cross-user detail status: ${report.crossUserDetailStatus}`,
    ""
  ].join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
await mkdir(args.out, { recursive: true });
const diagnostics = { console: [], pageErrors: [], httpErrors: [], clientCloses: [] };
const frames = [];
frames.listeners = [];
const report = { baseUrl: args.baseUrl, diagnostics, users: {}, verdict: "FAIL" };
let browser;

try {
  const baselineUsers = await jsonRequest(args.baseUrl, "/api/admin/users");
  const baselineByToken = new Map(baselineUsers.map((user) => [user.token, user]));
  const baselineRoundIds = new Map();
  for (const token of TOKENS) {
    const rounds = await jsonRequest(args.baseUrl, `/api/history/rounds?mode=live&token=${encodeURIComponent(token)}&limit=1000`);
    baselineRoundIds.set(token, new Set(rounds.map((round) => round.id)));
  }

  browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"]
  });
  for (const token of TOKENS) {
    const opened = await openUserGame({ browser, baseUrl: args.baseUrl, out: args.out, token, diagnostics, frames });
    const expectedEnterBalance = baselineByToken.get(token)?.balance ?? DEFAULT_BALANCE;
    const spin = await spinOnce({ opened, token, out: args.out, frames });
    const gameHistory = token === "usergame1"
      ? await openInGameHistory({ opened, token, out: args.out, frames })
      : null;
    report.users[token] = {
      expectedEnterBalance,
      enterBalance: opened.enterBalance,
      finalUrl: opened.finalUrl,
      socketUrls: opened.socketUrls,
      spin
    };
    if (gameHistory) report.gameHistory = gameHistory;
    await opened.close();
  }

  const users = await jsonRequest(args.baseUrl, "/api/admin/users");
  const userStats = new Map(users.map((user) => [user.token, user]));
  for (const token of TOKENS) {
    const rounds = await jsonRequest(args.baseUrl, `/api/history/rounds?mode=live&token=${encodeURIComponent(token)}&limit=1000`);
    const newRounds = rounds.filter((round) => !baselineRoundIds.get(token).has(round.id));
    report.users[token].rounds = rounds;
    report.users[token].newRoundIds = newRounds.map((round) => round.id);
    report.users[token].stats = userStats.get(token);
    report.users[token].calculatedStats = calculateStats(rounds);
  }

  const user1RoundId = report.users.user1.newRoundIds[0];
  const crossUserResponse = await fetch(new URL(`/api/history/rounds/${user1RoundId}?token=user2`, args.baseUrl));
  report.crossUserDetailStatus = crossUserResponse.status;
  report.admin = await verifyAdmin({ browser, baseUrl: args.baseUrl, out: args.out, diagnostics });
  const replayHistory = await fetch(new URL("/__history.json", args.baseUrl)).then((response) => response.json());
  report.serverMismatches = replayHistory.counts.mismatches;
  report.authTimeout = diagnostics.console.some((line) => /登录超时|登录认证超时|loginAuthFail/i.test(line));

  const usersPass = TOKENS.every((token) => {
    const result = report.users[token];
    const expectedFinal = result.enterBalance - result.spin.bet + result.spin.totalWin;
    return result.enterBalance === result.expectedEnterBalance
      && result.spin.finalBalance === expectedFinal
      && result.stats.balance === expectedFinal
      && result.newRoundIds.length === 1
      && result.rounds.every((round) => round.token === token)
      && result.finalUrl === new URL(`/__game/live?token=${encodeURIComponent(token)}`, args.baseUrl).toString()
      && result.socketUrls.length >= 2
      && result.socketUrls.every((url) => decodeURIComponent(url).includes(`userToken=${token}`))
      && result.stats.totalWager === result.calculatedStats.totalWager
      && result.stats.totalWin === result.calculatedStats.totalWin
      && Math.abs(result.stats.rtp - result.calculatedStats.rtp) < 1e-12;
  });
  const gameHistoryPass = report.gameHistory.records.length > 0
    && report.gameHistory.records.every((record) => report.users.usergame1.rounds.some((round) => round.id === record.betId))
    && report.gameHistory.detailBetId === report.gameHistory.records[0].betId
    && report.gameHistory.detailRows > 0;
  const adminPass = TOKENS.every((token) => report.admin.userTableText.includes(token))
    && report.admin.historyTokens.length > 0
    && report.admin.historyTokens.every((token) => token === "usergame1")
    && !report.admin.mobileOverflow;
  report.verdict = usersPass
    && gameHistoryPass
    && adminPass
    && report.crossUserDetailStatus === 404
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
