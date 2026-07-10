import { decodeBoyaRotateFromPayload, parseFrameBase64 } from "../../tools/lib/boya-har.mjs";

function payloadBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (typeof payload === "string") return Buffer.from(payload, "base64");
  return Buffer.alloc(0);
}

export function decodeObservedFrame(direction, payload, id) {
  const buffer = payloadBuffer(payload);
  if (buffer.length < 12) return null;

  try {
    const parsed = parseFrameBase64(buffer);
    const frame = { id, direction, cmd: parsed.cmd, bytes: buffer.length };
    if ([40003, 40005, 40007].includes(parsed.cmd)) {
      frame.rotate = decodeBoyaRotateFromPayload(parsed.payload);
    }
    return frame;
  } catch {
    return null;
  }
}

export function waitForObservedFrame(frames, predicate, timeoutMs, label) {
  const existing = frames.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    const listener = (frame) => {
      if (!predicate(frame)) return;
      cleanup();
      resolve(frame);
    };
    function cleanup() {
      clearTimeout(timer);
      const index = frames.listeners.indexOf(listener);
      if (index >= 0) frames.listeners.splice(index, 1);
    }
    frames.listeners.push(listener);
  });
}

export async function clickUntilObservedFrame({
  page,
  frames,
  predicate,
  x,
  y,
  timeoutMs,
  intervalMs = 800,
  label
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.mouse.click(x, y);
    const remaining = Math.max(1, deadline - Date.now());
    try {
      return await waitForObservedFrame(frames, predicate, Math.min(intervalMs, remaining), label);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function clickSequenceUntilObservedFrame({
  page,
  frames,
  predicate,
  clicks,
  clickDelayMs = 800,
  timeoutMs,
  intervalMs = 800,
  label
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const click of clicks) {
      await page.mouse.click(click.x, click.y);
      if (clickDelayMs > 0) await page.waitForTimeout(clickDelayMs);
    }
    const remaining = Math.max(1, deadline - Date.now());
    try {
      return await waitForObservedFrame(frames, predicate, Math.min(intervalMs, remaining), label);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function collectRotateSequence({
  frames,
  firstFrame,
  responseCmd,
  timeoutMs,
  label,
  maxSteps = 20
}) {
  const sequence = [firstFrame];
  let current = firstFrame;
  while (current.rotate?.lines?.length) {
    if (sequence.length >= maxSteps) {
      throw new Error(`${label} exceeded ${maxSteps} response frames`);
    }
    current = await waitForObservedFrame(
      frames,
      (frame) => frame.id > current.id && frame.direction === "receive" && frame.cmd === responseCmd,
      timeoutMs,
      label
    );
    sequence.push(current);
  }
  return sequence;
}

export function renderControlledReport(report) {
  const diagnostics = report.diagnostics || { httpErrors: [], pageErrors: [], clientCloses: [] };
  const baseLadder = report.baseLadder || [];
  const routes = report.routes || {};
  const buyFree = report.buyFree || {};
  const live = report.live || [];
  const liveFree = report.liveFree || {};
  const admin = report.admin || {};
  return `${[
    "# Boya Mahjong2 Local Controlled Server Verification",
    "",
    `- verdict: ${report.verdict}`,
    `- baseUrl: ${report.baseUrl}`,
    `- error: ${report.error || "none"}`,
    `- httpErrors: ${diagnostics.httpErrors.length}`,
    `- pageErrors: ${diagnostics.pageErrors.length}`,
    `- clientCloses: ${diagnostics.clientCloses.length}`,
    `- serverMismatches: ${report.serverMismatches ?? "not-read"}`,
    "",
    "## Base Ladder",
    "",
    ...baseLadder.map((entry) => `- ${entry.amount}: icon=${entry.iconId}, axle=${entry.axleId}, ways=${entry.lineNum}, lineSum=${entry.lineSum}, formula=${entry.formulaMatches}, settle=${entry.settleRoundWin}`),
    "",
    "## Routes And Cascades",
    "",
    `- goldToWildCount: ${routes.goldToWildCount ?? "not-run"}`,
    `- wildNextLineCount: ${routes.wildNextLineCount ?? "not-run"}`,
    `- wildEliminatedNext: ${routes.wildEliminatedNext ?? "not-run"}`,
    `- reuseLineCount: ${routes.reuseLineCount ?? "not-run"}`,
    `- cascadeMultipliers: ${(routes.cascadeMultipliers || []).join("/") || "not-run"}`,
    `- formulaMatches: ${routes.formulaMatches ?? "not-run"}`,
    "",
    "## Buy Free",
    "",
    `- scatter/free: ${buyFree.scatterCount ?? "not-run"}/${buyFree.freeAppend ?? "not-run"}`,
    `- 40005 responses: ${buyFree.responseCount ?? "not-run"}`,
    `- multipliers: ${(buyFree.multipliers || []).join("/") || "not-run"}`,
    `- goldToWildFrames: ${buyFree.goldToWildFrames ?? "not-run"}`,
    `- formulaMatches: ${buyFree.formulaMatches ?? "not-run"}`,
    `- free spin totals: ${(buyFree.freeSpinTotals || []).join("/") || "not-run"}`,
    `- ascending spin totals: ${buyFree.ascendingSpinTotals ?? "not-run"}`,
    `- scatter/free cases: ${(buyFree.countCases || []).map((entry) => `${entry.scatterCount}->${entry.freeCount}`).join(", ") || "not-run"}`,
    "",
    "## Live",
    "",
    ...live.map((entry) => `- spin ${entry.spin}: win=${entry.roundWin}, lines=${entry.lineCount}, formula=${entry.formulaMatches}`),
    `- weighted free scatter/count: ${liveFree.scatterCount ?? "not-run"}/${liveFree.freeCount ?? "not-run"}`,
    `- weighted free responses: ${liveFree.responseCount ?? "not-run"}`,
    `- weighted free source: ${liveFree.historySource ?? "not-run"}`,
    `- weighted free columns/formula: ${liveFree.configuredColumnsMatch ?? "not-run"}/${liveFree.formulaMatches ?? "not-run"}`,
    "",
    "## Admin",
    "",
    `- weightRows: ${admin.weightRows ?? "not-run"}`,
    `- historyRows: ${admin.historyRows ?? "not-run"}`,
    `- mobileOverflow: ${admin.mobileOverflow ?? "not-run"}`,
    ""
  ].join("\n")}\n`;
}
