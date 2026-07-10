#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import {
  decodeBoyaRotateFromPayload,
  NORMAL_WIN_AMOUNTS,
  normalWinScenarios,
  parseFrameBase64
} from "../../tools/lib/boya-har.mjs";

function parseArgs(argv) {
  const args = {
    url: "http://127.0.0.1:18082/__game/normalwin",
    out: "",
    spins: NORMAL_WIN_AMOUNTS.length,
    heartbeatWaitMs: 10000,
    perScenario: true,
    headed: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") args.url = argv[++index];
    else if (arg === "--out") args.out = argv[++index];
    else if (arg === "--spins") args.spins = Number(argv[++index]);
    else if (arg === "--heartbeat-wait-ms") args.heartbeatWaitMs = Number(argv[++index]);
    else if (arg === "--single-session") args.perScenario = false;
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
  return {
    coin: rotate.coin,
    betCoin: rotate.betCoin,
    totalWin: rotate.totalWin,
    roundWin: rotate.roundWin,
    roundScore: rotate.roundScore,
    roundScoreSigned: rotate.roundScoreSigned,
    lineSum: rotate.lines.reduce((sum, line) => sum + (line.score || 0), 0),
    lines: rotate.lines,
    purchase: rotate.purchase,
    freeRemainCount: rotate.freeRemainCount,
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
    if (parsed.cmd === 40003) {
      record.rotate = summarizeRotate(parsed.payload);
    }
    observedFrames.push(record);
    for (const listener of [...observedFrames.listeners]) listener(record);
  } catch {
    // Ignore non-game frames.
  }
}

function symbolMatchesLine(symbol, iconId) {
  return symbol === 2 || symbol === iconId || (symbol - 1 === iconId && symbol % 2 === 0);
}

function matchedRowsByColumn(drawResult, iconId) {
  const rowsByColumn = [];
  for (let col = 0; col < 5; col += 1) {
    rowsByColumn.push(
      drawResult
        .slice(col * 5, col * 5 + 5)
        .map((symbol, row) => (symbolMatchesLine(symbol, iconId) ? row : null))
        .filter((row) => row !== null)
    );
  }
  return rowsByColumn;
}

function winningWays(drawResult) {
  return [3, 5, 7, 9, 11, 13, 15, 17, 19].flatMap((iconId) => {
    const matchingRows = matchedRowsByColumn(drawResult, iconId);
    let reels = 0;
    while (reels < matchingRows.length && matchingRows[reels].length) reels += 1;
    return reels >= 3 ? [{ iconId, matchingRows: matchingRows.slice(0, reels) }] : [];
  });
}

function bindPageEvents(page, consoleLines, pageErrors, httpErrors, clientCloses, observedFrames, isActive) {
  let pageActive = true;
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
      if (isActive() && pageActive) clientCloses.push({ url: ws.url(), frameCount: observedFrames.length });
    });
  });
  return () => {
    pageActive = false;
  };
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

function scenarioUrl(baseUrl, scenarioIndex, perScenario) {
  if (!perScenario) {
    return baseUrl;
  }
  const url = new URL(baseUrl);
  const match = /^\/__game\/normalwin(?:-\d+)?$/.exec(url.pathname);
  if (match) {
    url.pathname = `/__game/normalwin-${scenarioIndex + 1}`;
    return url.toString();
  }
  url.searchParams.set("localMode", `normalwin-${scenarioIndex + 1}`);
  const gateway = Buffer.from(`ws://${url.hostname}:${url.port || "80"}/gate/ws?mode=normalwin-${scenarioIndex + 1}`).toString("base64");
  url.searchParams.set("g", gateway);
  return url.toString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });

  const consoleLines = [];
  const pageErrors = [];
  const httpErrors = [];
  const clientCloses = [];
  const observedFrames = [];
  observedFrames.listeners = [];
  let testActive = true;

  const browser = await launch(args.headed);
  const context = await browser.newContext({
    viewport: { width: 900, height: 1400 },
    deviceScaleFactor: 1
  });
  let page = await context.newPage();
  let deactivatePage = bindPageEvents(page, consoleLines, pageErrors, httpErrors, clientCloses, observedFrames, () => testActive);

  const result = {
    verdict: "FAIL",
    url: args.url,
    out: args.out,
    spins: args.spins,
    heartbeatWaitMs: args.heartbeatWaitMs,
    perScenario: args.perScenario,
    finalUrl: null
  };
  const spinResults = [];
  const scenarios = normalWinScenarios();

  try {
    for (let spin = 0; spin < args.spins; spin += 1) {
      const currentUrl = scenarioUrl(args.url, spin, args.perScenario);
      if (args.perScenario && spin > 0) {
        deactivatePage();
        await page.close();
        const nextPage = await context.newPage();
        deactivatePage = bindPageEvents(nextPage, consoleLines, pageErrors, httpErrors, clientCloses, observedFrames, () => testActive);
        page = nextPage;
      }

      const enterStartFrameId = observedFrames.length;
      await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector("canvas#GameCanvas", { state: "visible", timeout: 60000 });
      await waitForFrame(
        observedFrames,
        (frame) => frame.id > enterStartFrameId && frame.direction === "receive" && frame.cmd === 40001,
        90000,
        `40001 enter ${spin + 1}`
      );
      await page.waitForTimeout(3000);
      if (spin === 0) {
        await page.screenshot({ path: path.join(args.out, "00-enter-before-start.png"), fullPage: true });
      }

      await clickAndWait(page, 450, 1075, 2500);
      if (spin === 0) {
        await page.screenshot({ path: path.join(args.out, "01-started.png"), fullPage: true });
      }

      const lastSeenFrameId = observedFrames.length;
      await clickAndWait(page, 450, 1315, 600);
      const response = await waitForFrame(
        observedFrames,
        (frame) => frame.id > lastSeenFrameId && frame.direction === "receive" && frame.cmd === 40003,
        45000,
        `40003 normal win ${spin + 1}`
      );
      const rotate = response.rotate;
      const scenario = scenarios[spin];
      const firstLine = rotate?.lines?.[0];
      const matchedRows = firstLine
        ? matchedRowsByColumn(rotate.drawResult || [], firstLine.iconId)
        : [];
      const boardWays = winningWays(rotate?.drawResult || []);
      const visibleSymbols = new Set([
        ...(rotate?.drawResult || []),
        ...(rotate?.topResult || []),
        ...(rotate?.buttomResult || [])
      ]);
      const summary = {
        spin: spin + 1,
        frameId: response.id,
        target: NORMAL_WIN_AMOUNTS[spin],
        coin: rotate?.coin,
        betCoin: rotate?.betCoin,
        totalWin: rotate?.totalWin,
        roundWin: rotate?.roundWin,
        roundScoreSigned: rotate?.roundScoreSigned,
        lineSum: rotate?.lineSum,
        lines: rotate?.lines || [],
        purchase: rotate?.purchase,
        freeRemainCount: rotate?.freeRemainCount,
        lineAxleId: firstLine?.axleId,
        lineNum: firstLine?.lineNum,
        lineIconsOnBoard: (rotate?.lines || []).every((line) => visibleSymbols.has(line.iconId)),
        targetPathMatches: Boolean(
          scenario
          && firstLine
          && firstLine.axleId === scenario.targetRows.length - 1
          && firstLine.lineNum === 1
          && scenario.targetRows.every((row, col) => rotate?.drawResult?.[col * 5 + row] === scenario.iconId)
          && matchedRows.every((rows, col) => (
            col < scenario.targetRows.length
              ? rows.length === 1 && rows[0] === scenario.targetRows[col]
              : rows.length === 0
          ))
        ),
        boardWays,
        declaredWaysOnly: Boolean(
          scenario
          && boardWays.length === 1
          && boardWays[0].iconId === scenario.iconId
          && boardWays[0].matchingRows.length === scenario.targetRows.length
          && boardWays[0].matchingRows.every((rows, col) => (
            rows.length === 1 && rows[0] === scenario.targetRows[col]
          ))
        ),
        targetRows: scenario?.targetRows || [],
        matchedRows
      };
      spinResults.push(summary);

      await page.waitForTimeout(1800);
      await page.screenshot({ path: path.join(args.out, `win-${String(summary.target).padStart(5, "0")}-highlight.png`), fullPage: true });
      const settleResponse = await waitForFrame(
        observedFrames,
        (frame) => frame.id > response.id && frame.direction === "receive" && frame.cmd === 40003,
        20000,
        `40003 normal win settle ${spin + 1}`
      );
      const settle = settleResponse.rotate;
      summary.settleFrameId = settleResponse.id;
      summary.settleCoin = settle?.coin;
      summary.settleTotalWin = settle?.totalWin;
      summary.settleRoundWin = settle?.roundWin;
      summary.settleRoundScoreSigned = settle?.roundScoreSigned;
      summary.settleLineSum = settle?.lineSum;
      summary.settleLines = settle?.lines || [];
      summary.settleBoardWays = winningWays(settle?.drawResult || []);
      summary.settlePurchase = settle?.purchase;
      summary.settleFreeRemainCount = settle?.freeRemainCount;

      await page.waitForTimeout(2500);
      await page.screenshot({ path: path.join(args.out, `win-${String(summary.target).padStart(5, "0")}-settled.png`), fullPage: true });
      await page.waitForTimeout(args.heartbeatWaitMs);
      await page.screenshot({ path: path.join(args.out, `win-${String(summary.target).padStart(5, "0")}-after-wait.png`), fullPage: true });
      summary.normalResponseCount = observedFrames.filter((frame) => (
        frame.id > enterStartFrameId
        && frame.direction === "receive"
        && frame.cmd === 40003
      )).length;
      result.finalUrl = page.url();
    }

    await page.screenshot({ path: path.join(args.out, "after-heartbeat-wait.png"), fullPage: true });
    try {
      const historyUrl = new URL("/__history.json", args.url);
      const historyResponse = await fetch(historyUrl);
      const history = await historyResponse.json();
      result.historyUrl = historyUrl.toString();
      result.serverMismatches = history?.counts?.mismatches;
    } catch (error) {
      result.historyError = error.stack || error.message;
      result.serverMismatches = null;
    }

    const expectedWins = NORMAL_WIN_AMOUNTS.slice(0, args.spins);
    const spinConsistency = spinResults.every((spin, index) => (
      spin.lines.length === 1
      && spin.roundWin === expectedWins[index]
      && spin.totalWin === expectedWins[index]
      && spin.roundScoreSigned === expectedWins[index] - 400
      && spin.lineSum === expectedWins[index]
      && spin.purchase === undefined
      && spin.freeRemainCount === undefined
      && spin.lineAxleId === spin.targetRows.length - 1
      && spin.lineNum === 1
      && spin.lineIconsOnBoard
      && spin.targetPathMatches
      && spin.declaredWaysOnly
      && spin.settleLines.length === 0
      && spin.settleRoundWin === 0
      && spin.settleTotalWin === expectedWins[index]
      && spin.settleRoundScoreSigned === expectedWins[index] - 400
      && spin.settleLineSum === 0
      && spin.settleBoardWays.length === 0
      && spin.settlePurchase === undefined
      && spin.settleFreeRemainCount === undefined
      && spin.settleCoin - spin.coin === expectedWins[index]
      && spin.normalResponseCount === 2
    ));
    const hasLoginTimeout = consoleLines.some((line) => /登录超时|登录认证超时|loginAuthFail|Login authentication timed out/.test(line));
    result.verdict = spinConsistency
      && result.serverMismatches === 0
      && !hasLoginTimeout
      && !httpErrors.length
      && !clientCloses.length
      && !pageErrors.length
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
    "# Boya Mahjong2 Normal Win Path/Payout Verification",
    "",
    `- verdict: ${report.verdict}`,
    `- url: ${report.url}`,
    `- finalUrl: ${report.finalUrl}`,
    `- spins: ${report.spins}`,
    `- heartbeatWaitMs: ${report.heartbeatWaitMs}`,
    `- perScenario: ${report.perScenario}`,
    `- httpErrors: ${report.httpErrors.length}`,
    `- pageErrors: ${report.pageErrors.length}`,
    `- clientCloses: ${report.clientCloses.length}`,
    `- serverMismatches: ${report.serverMismatches}`,
    `- send40002/receive40003: ${report.counts.send40002}/${report.counts.receive40003}`,
    `- send40006/receive40007: ${report.counts.send40006}/${report.counts.receive40007}`,
    `- send40004/receive40005: ${report.counts.send40004}/${report.counts.receive40005}`,
    `- send5000/receive5001: ${report.counts.send5000}/${report.counts.receive5001}`,
    "",
    "## Normal Win Results",
    "",
    ...report.spinResults.map((spin) => `- win ${spin.spin}: round=${spin.roundWin}, total=${spin.totalWin}, roundScoreSigned=${spin.roundScoreSigned}, lineSum=${spin.lineSum}, lines=${spin.lines.length}, axleId=${spin.lineAxleId}, lineNum=${spin.lineNum}, iconsOnBoard=${spin.lineIconsOnBoard}, targetPathMatches=${spin.targetPathMatches}, declaredWaysOnly=${spin.declaredWaysOnly}, targetRows=${spin.targetRows.join("/")}, matchedRows=${spin.matchedRows.map((rows) => `[${rows.join("/")}]`).join("/")}, settleRound=${spin.settleRoundWin}, settleTotal=${spin.settleTotalWin}, settleLines=${spin.settleLines.length}, settleWays=${spin.settleBoardWays.length}, responses=${spin.normalResponseCount}`),
    "",
    "## Screenshots",
    "",
    "- win-00100-highlight.png ... win-00800-highlight.png",
    "- after-heartbeat-wait.png",
    ""
  ].join("\n")}\n`;
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
