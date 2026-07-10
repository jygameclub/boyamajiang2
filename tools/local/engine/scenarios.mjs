import {
  PAYING_SYMBOLS,
  SENTINEL_SYMBOL,
  boardIndex,
  payoutFor,
  playableRowsForReel
} from "./constants.mjs";

const SMALL_WIN_DEFINITIONS = Object.freeze([
  { key: "base-small-100", amount: 100, iconId: 19, matchLength: 3, counts: [1, 1, 5], rows: [[1], [4], [0, 1, 2, 3, 4]] },
  { key: "base-small-200", amount: 200, iconId: 17, matchLength: 3, counts: [1, 2, 5], rows: [[2], [0, 3], [0, 1, 2, 3, 4]] },
  { key: "base-small-300", amount: 300, iconId: 13, matchLength: 3, counts: [1, 1, 5], rows: [[3], [1], [0, 1, 2, 3, 4]] },
  { key: "base-small-500", amount: 500, iconId: 13, matchLength: 4, counts: [1, 1, 1, 5], rows: [[4], [2], [0], [0, 1, 2, 3, 4]] },
  { key: "base-small-600", amount: 600, iconId: 7, matchLength: 3, counts: [1, 1, 5], rows: [[1], [2], [0, 1, 2, 3, 4]] },
  { key: "base-small-800", amount: 800, iconId: 5, matchLength: 3, counts: [1, 1, 5], rows: [[4], [0], [0, 1, 2, 3, 4]] }
]);

function buildBoard(definition) {
  const board = Array(25).fill(null);
  board[0] = SENTINEL_SYMBOL;
  board[20] = SENTINEL_SYMBOL;
  const fillers = PAYING_SYMBOLS.filter((symbol) => symbol !== definition.iconId).slice(0, 5);
  for (let reel = 0; reel < 5; reel += 1) {
    for (const row of playableRowsForReel(reel)) {
      board[boardIndex(reel, row)] = fillers[reel];
    }
  }
  definition.rows.forEach((rows, reel) => {
    for (const row of rows) board[boardIndex(reel, row)] = definition.iconId;
  });
  return { board, fillerByReel: fillers };
}

export function createSafeBoard(excludedSymbol = null) {
  const definition = {
    iconId: excludedSymbol ?? -1,
    rows: []
  };
  return buildBoard(definition);
}

export function createSmallWinScenarios({ betMulti = 20 } = {}) {
  return SMALL_WIN_DEFINITIONS.map((definition) => {
    const { board, fillerByReel } = buildBoard(definition);
    const lineNum = definition.counts.reduce((product, count) => product * count, 1);
    const odds = payoutFor(definition.iconId, definition.matchLength);
    const score = odds * lineNum * Number(betMulti);
    return {
      ...definition,
      amount: score,
      board,
      fillerByReel,
      expectedLine: {
        iconId: definition.iconId,
        axleId: definition.matchLength - 1,
        lineNum,
        odds,
        multi: 1,
        score
      }
    };
  });
}

export function createOutcomeFallbackScenario(
  outcome,
  { betMulti = 20, betCoin = 400, multiplier = 1 } = {}
) {
  const stepMultiplier = Math.max(1, Number(multiplier) || 1);
  if (outcome === "miss") {
    const { board, fillerByReel } = createSafeBoard();
    return { key: "fallback-miss", outcome, amount: 0, board, fillerByReel };
  }
  if (outcome === "small") {
    const scenario = createSmallWinScenarios({ betMulti })[0];
    return {
      ...scenario,
      outcome,
      amount: scenario.amount * stepMultiplier,
      expectedLine: {
        ...scenario.expectedLine,
        multi: stepMultiplier,
        score: scenario.expectedLine.score * stepMultiplier
      }
    };
  }
  const layouts = [
    { ways: 1, counts: [1, 1, 1, 1, 1], rows: [[1], [0], [1], [2], [3]] },
    { ways: 2, counts: [1, 2, 1, 1, 1], rows: [[1], [0, 2], [1], [3], [2]] },
    { ways: 4, counts: [1, 2, 1, 2, 1], rows: [[2], [0, 4], [3], [1, 4], [1]] },
    { ways: 5, counts: [1, 5, 1, 1, 1], rows: [[2], [0, 1, 2, 3, 4], [3], [1], [4]] },
    { ways: 6, counts: [1, 3, 1, 2, 1], rows: [[3], [0, 2, 4], [1], [1, 4], [2]] },
    { ways: 8, counts: [1, 2, 1, 4, 1], rows: [[3], [0, 4], [2], [0, 1, 3, 4], [1]] },
    { ways: 10, counts: [1, 2, 1, 5, 1], rows: [[3], [0, 4], [2], [0, 1, 2, 3, 4], [1]] },
    { ways: 12, counts: [1, 3, 1, 4, 1], rows: [[4], [0, 2, 4], [1], [0, 1, 3, 4], [3]] },
    { ways: 15, counts: [1, 3, 1, 5, 1], rows: [[4], [0, 2, 4], [1], [0, 1, 2, 3, 4], [3]] }
  ];
  if (!["medium", "big", "mega", "super"].includes(outcome)) {
    throw new Error(`Unknown outcome ${outcome}`);
  }
  const iconId = 3;
  const odds = payoutFor(iconId, 5);
  const selected = layouts.find((layout) => {
    const amount = odds * layout.ways * Number(betMulti) * stepMultiplier;
    const multiple = amount / Number(betCoin);
    if (outcome === "medium") return multiple >= 5 && multiple < 10;
    if (outcome === "big") return multiple >= 10 && multiple < 20;
    if (outcome === "mega") return multiple >= 20 && multiple < 30;
    return multiple >= 30;
  });
  if (!selected) throw new Error(`No fallback layout for ${outcome} at multiplier ${stepMultiplier}`);
  const definition = {
    key: `fallback-${outcome}`,
    iconId,
    matchLength: 5,
    counts: selected.counts,
    rows: selected.rows
  };
  const { board, fillerByReel } = buildBoard(definition);
  const amount = odds * selected.ways * Number(betMulti) * stepMultiplier;
  const multiple = amount / Number(betCoin);
  const valid = outcome === "medium"
    ? multiple >= 5 && multiple < 10
    : outcome === "big"
      ? multiple >= 10 && multiple < 20
      : outcome === "mega"
        ? multiple >= 20 && multiple < 30
        : multiple >= 30;
  if (!valid) throw new Error(`${outcome} fallback amount ${amount} is outside its band`);
  return {
    ...definition,
    outcome,
    amount,
    board,
    fillerByReel,
    expectedLine: {
      iconId,
      axleId: 4,
      lineNum: selected.ways,
      odds,
      multi: stepMultiplier,
      score: amount
    }
  };
}

function routeBoard(excludedSymbols, placements) {
  const fillers = PAYING_SYMBOLS.filter((symbol) => !excludedSymbols.includes(symbol)).slice(0, 5);
  if (fillers.length !== 5) throw new Error("Route scenario requires five distinct filler symbols");
  const board = Array(25).fill(null);
  board[0] = SENTINEL_SYMBOL;
  board[20] = SENTINEL_SYMBOL;
  for (let reel = 0; reel < 5; reel += 1) {
    for (const row of playableRowsForReel(reel)) {
      board[boardIndex(reel, row)] = fillers[reel];
    }
  }
  for (const { reel, row, symbol } of placements) {
    board[boardIndex(reel, row)] = symbol;
  }
  return { board, fillers };
}

function queuedSampler(queues, fillers) {
  return () => {
    const cursor = [0, 0, 0, 0, 0];
    return (reel) => queues[reel]?.[cursor[reel]++] ?? fillers[reel];
  };
}

function routeScenario({
  key,
  label,
  excluded,
  placements,
  queues = [[], [], [], [], []],
  maxCascades = 4,
  tags = [],
  expect
}) {
  const { board, fillers } = routeBoard(excluded, placements);
  return {
    key,
    label,
    tags,
    initialBoard: board,
    initialBuffers: { topResult: [...fillers], buttomResult: [...fillers] },
    maxCascades,
    expect,
    createNextSymbol: queuedSampler(queues, fillers)
  };
}

function pathPlacements(symbol, rowsByReel) {
  return rowsByReel.flatMap((rows, reel) => rows.map((row) => ({ reel, row, symbol })));
}

export function createRouteAndCascadeScenarios() {
  const scenarios = [];

  scenarios.push(routeScenario({
    key: "route-near-miss",
    label: "两轴同符号近失",
    excluded: [17],
    placements: pathPlacements(17, [[1], [3]]),
    tags: ["miss", "near-miss"],
    expect: { winSteps: 0, multipliers: [] }
  }));

  scenarios.push(routeScenario({
    key: "route-zigzag-single",
    label: "三轴单 Ways 折线",
    excluded: [19],
    placements: pathPlacements(19, [[4], [0], [3]]),
    tags: ["single-way", "zigzag"],
    expect: { winSteps: 1, multipliers: [1] }
  }));

  scenarios.push(routeScenario({
    key: "route-multi-ways",
    label: "三轴 6 Ways",
    excluded: [17],
    placements: pathPlacements(17, [[2], [0, 4], [1, 2, 3]]),
    tags: ["multi-way"],
    expect: { winSteps: 1, multipliers: [1] }
  }));

  scenarios.push(routeScenario({
    key: "route-five-axes",
    label: "五轴连续路线",
    excluded: [15],
    placements: pathPlacements(15, [[1], [4], [0], [3], [2]]),
    tags: ["five-reel"],
    expect: { winSteps: 1, multipliers: [1] }
  }));

  scenarios.push(routeScenario({
    key: "route-multi-icon",
    label: "同一步双图标中奖",
    excluded: [17, 19],
    placements: [
      ...pathPlacements(17, [[1], [0], [3]]),
      ...pathPlacements(19, [[4], [2], [1]])
    ],
    tags: ["multi-icon"],
    expect: { winSteps: 1, multipliers: [1] }
  }));

  scenarios.push(routeScenario({
    key: "cascade-two-win-steps",
    label: "两步中奖级联 x1 到 x2",
    excluded: [17, 19],
    placements: pathPlacements(19, [[4], [1], [3]]),
    queues: [[17], [17], [17], [], []],
    tags: ["cascade", "x2"],
    expect: { winSteps: 2, multipliers: [1, 2] }
  }));

  scenarios.push(routeScenario({
    key: "cascade-four-win-steps",
    label: "四步中奖级联 x1/x2/x3/x5",
    excluded: [13, 15, 17, 19],
    placements: pathPlacements(19, [[1], [3], [0]]),
    queues: [[17, 15, 13], [17, 15, 13], [17, 15, 13], [], []],
    tags: ["cascade", "x2", "x3", "x5"],
    expect: { winSteps: 4, multipliers: [1, 2, 3, 5] }
  }));

  scenarios.push(routeScenario({
    key: "cascade-gold-to-wild",
    label: "金牌中奖后转 Wild",
    excluded: [17, 19],
    placements: [
      { reel: 0, row: 1, symbol: 17 },
      { reel: 1, row: 2, symbol: 18 },
      { reel: 2, row: 4, symbol: 17 }
    ],
    queues: [[19], [], [19], [], []],
    tags: ["gold", "wild"],
    expect: { winSteps: 2, multipliers: [1, 2], minPeakWild: 1, goldToWild: true }
  }));

  scenarios.push(routeScenario({
    key: "cascade-wild-next-eliminate",
    label: "Wild 下一步参与路线并消除",
    excluded: [7, 15],
    placements: [
      { reel: 0, row: 3, symbol: 15 },
      { reel: 1, row: 4, symbol: 16 },
      { reel: 2, row: 1, symbol: 15 }
    ],
    queues: [[7], [], [7], [], []],
    tags: ["gold", "wild", "eliminate"],
    expect: { winSteps: 2, multipliers: [1, 2], minPeakWild: 1, goldToWild: true }
  }));

  scenarios.push(routeScenario({
    key: "route-wild-reuse",
    label: "一个 Wild 跨多个图标复用",
    excluded: [13, 19],
    placements: [
      { reel: 0, row: 1, symbol: 13 },
      { reel: 0, row: 2, symbol: 19 },
      { reel: 1, row: 2, symbol: 2 },
      { reel: 2, row: 0, symbol: 13 },
      { reel: 2, row: 1, symbol: 19 }
    ],
    tags: ["wild", "multi-icon"],
    expect: { winSteps: 1, multipliers: [1], minPeakWild: 1 }
  }));

  scenarios.push(routeScenario({
    key: "cascade-refill-win",
    label: "补牌后形成新路线",
    excluded: [3, 11],
    placements: pathPlacements(11, [[2], [4], [0]]),
    queues: [[3], [3], [3], [], []],
    tags: ["cascade", "refill"],
    expect: { winSteps: 2, multipliers: [1, 2] }
  }));

  scenarios.push(routeScenario({
    key: "cascade-limit-terminal",
    label: "达到级联上限后合法终止",
    excluded: [7, 9],
    placements: pathPlacements(9, [[4], [1], [2]]),
    queues: [[7], [7], [7], [], []],
    maxCascades: 1,
    tags: ["cascade-limit"],
    expect: { winSteps: 2, multipliers: [1, 2] }
  }));

  scenarios.push(routeScenario({
    key: "route-top-single",
    label: "顶部三轴单 Ways",
    excluded: [19],
    placements: pathPlacements(19, [[1], [0], [0]]),
    tags: ["single-way", "top"],
    expect: { winSteps: 1, multipliers: [1] }
  }));

  scenarios.push(routeScenario({
    key: "route-bottom-single",
    label: "底部三轴单 Ways",
    excluded: [17],
    placements: pathPlacements(17, [[4], [4], [4]]),
    tags: ["single-way", "bottom"],
    expect: { winSteps: 1, multipliers: [1] }
  }));

  scenarios.push(routeScenario({
    key: "route-four-axes",
    label: "四轴连续单 Ways",
    excluded: [15],
    placements: pathPlacements(15, [[2], [1], [4], [0]]),
    tags: ["four-reel", "single-way"],
    expect: { winSteps: 1, multipliers: [1] }
  }));

  scenarios.push(routeScenario({
    key: "route-four-axes-multi-ways",
    label: "四轴 8 Ways",
    excluded: [17],
    placements: pathPlacements(17, [[1, 4], [2], [0, 3], [1, 4]]),
    tags: ["four-reel", "multi-way"],
    expect: { winSteps: 1, multipliers: [1] }
  }));

  scenarios.push(routeScenario({
    key: "route-five-axes-multi-ways",
    label: "五轴 4 Ways",
    excluded: [19],
    placements: pathPlacements(19, [[2], [0, 4], [1], [2, 3], [4]]),
    tags: ["five-reel", "multi-way"],
    expect: { winSteps: 1, multipliers: [1] }
  }));

  scenarios.push(routeScenario({
    key: "route-three-icons",
    label: "同一步三个图标中奖",
    excluded: [15, 17, 19],
    placements: [
      ...pathPlacements(15, [[1], [0], [2]]),
      ...pathPlacements(17, [[2], [1], [3]]),
      ...pathPlacements(19, [[3], [2], [4]])
    ],
    tags: ["multi-icon", "three-lines"],
    expect: { winSteps: 1, multipliers: [1] }
  }));

  scenarios.push(routeScenario({
    key: "cascade-one-win-step",
    label: "一次中奖消除后终止",
    excluded: [11],
    placements: pathPlacements(11, [[1], [3], [2]]),
    tags: ["cascade", "one-drop"],
    expect: { winSteps: 1, multipliers: [1] }
  }));

  scenarios.push(routeScenario({
    key: "cascade-three-win-steps",
    label: "三步中奖级联 x1/x2/x3",
    excluded: [15, 17, 19],
    placements: pathPlacements(19, [[4], [2], [0]]),
    queues: [[17, 15], [17, 15], [17, 15], [], []],
    tags: ["cascade", "x2", "x3"],
    expect: { winSteps: 3, multipliers: [1, 2, 3] }
  }));

  scenarios.push(routeScenario({
    key: "cascade-multi-way-refill",
    label: "多格消除后补出 4 Ways",
    excluded: [17, 19],
    placements: pathPlacements(19, [[1, 4], [0, 3], [2]]),
    queues: [[17, 17], [17, 17], [17], [], []],
    tags: ["cascade", "refill", "multi-way"],
    expect: { winSteps: 2, multipliers: [1, 2] }
  }));

  scenarios.push(routeScenario({
    key: "cascade-multi-icon-refill",
    label: "双线路消除后补出双线路",
    excluded: [13, 15, 17, 19],
    placements: [
      ...pathPlacements(17, [[1], [0], [3]]),
      ...pathPlacements(19, [[4], [2], [1]])
    ],
    queues: [[15, 13], [15, 13], [15, 13], [], []],
    tags: ["cascade", "refill", "multi-icon"],
    expect: { winSteps: 2, multipliers: [1, 2] }
  }));

  scenarios.push(routeScenario({
    key: "cascade-scatter-gravity",
    label: "胡牌不消除并随重力移动",
    excluded: [19],
    placements: [
      ...pathPlacements(19, [[4], [4], [4]]),
      { reel: 1, row: 2, symbol: 1 },
      { reel: 2, row: 1, symbol: 1 }
    ],
    tags: ["cascade", "scatter", "gravity"],
    expect: { winSteps: 1, multipliers: [1], scatter: true }
  }));

  scenarios.push(routeScenario({
    key: "cascade-gold-wild-hold",
    label: "金牌转 Wild 后保留到终止盘",
    excluded: [17],
    placements: [
      { reel: 0, row: 1, symbol: 17 },
      { reel: 1, row: 2, symbol: 18 },
      { reel: 2, row: 3, symbol: 17 }
    ],
    tags: ["gold", "wild", "hold"],
    expect: { winSteps: 1, multipliers: [1], minPeakWild: 1, goldToWild: true }
  }));

  scenarios.push(routeScenario({
    key: "cascade-double-gold-to-wild",
    label: "双金牌转双 Wild 后参与消除",
    excluded: [17],
    placements: [
      { reel: 0, row: 1, symbol: 17 },
      { reel: 1, row: 2, symbol: 18 },
      { reel: 2, row: 3, symbol: 18 }
    ],
    tags: ["gold", "wild", "multi-wild", "eliminate"],
    expect: { winSteps: 2, multipliers: [1, 2], minPeakWild: 2, goldToWild: true }
  }));

  scenarios.push(routeScenario({
    key: "route-multiple-wild-same-line",
    label: "同一路线两个 Wild",
    excluded: [13],
    placements: [
      { reel: 0, row: 1, symbol: 13 },
      { reel: 0, row: 2, symbol: 1 },
      { reel: 0, row: 3, symbol: 1 },
      { reel: 0, row: 4, symbol: 1 },
      { reel: 1, row: 2, symbol: 2 },
      { reel: 2, row: 3, symbol: 2 },
      { reel: 3, row: 1, symbol: 13 }
    ],
    tags: ["wild", "multi-wild", "four-reel"],
    expect: { winSteps: 1, multipliers: [1], minPeakWild: 2, scatter: true }
  }));

  scenarios.push(routeScenario({
    key: "cascade-gold-wild-multi-icon",
    label: "金牌转 Wild 后同时连接两个图标",
    excluded: [15, 17, 19],
    placements: [
      { reel: 0, row: 4, symbol: 19 },
      { reel: 1, row: 2, symbol: 20 },
      { reel: 2, row: 0, symbol: 19 },
      { reel: 0, row: 1, symbol: 15 },
      { reel: 2, row: 3, symbol: 15 }
    ],
    queues: [[17], [], [17], [], []],
    tags: ["gold", "wild", "multi-icon", "cascade"],
    expect: { winSteps: 2, multipliers: [1, 2], minPeakWild: 1, goldToWild: true }
  }));

  scenarios.push(routeScenario({
    key: "route-mixed-base-gold-wild",
    label: "基础牌、金牌和 Wild 混合四轴路线",
    excluded: [13],
    placements: [
      { reel: 0, row: 1, symbol: 13 },
      { reel: 0, row: 2, symbol: 1 },
      { reel: 0, row: 3, symbol: 1 },
      { reel: 0, row: 4, symbol: 1 },
      { reel: 1, row: 2, symbol: 14 },
      { reel: 2, row: 3, symbol: 2 },
      { reel: 3, row: 1, symbol: 13 }
    ],
    tags: ["gold", "wild", "mixed", "four-reel"],
    expect: { winSteps: 1, multipliers: [1], minPeakWild: 1, goldToWild: true, scatter: true }
  }));

  return scenarios;
}
