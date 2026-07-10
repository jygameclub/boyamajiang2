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
    if (score !== definition.amount) {
      throw new Error(`${definition.key} produces ${score}, expected ${definition.amount}`);
    }
    return {
      ...definition,
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
  tags = []
}) {
  const { board, fillers } = routeBoard(excluded, placements);
  return {
    key,
    label,
    tags,
    initialBoard: board,
    initialBuffers: { topResult: [...fillers], buttomResult: [...fillers] },
    maxCascades,
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
    tags: ["miss", "near-miss"]
  }));

  scenarios.push(routeScenario({
    key: "route-zigzag-single",
    label: "三轴单 Ways 折线",
    excluded: [19],
    placements: pathPlacements(19, [[4], [0], [3]]),
    tags: ["single-way", "zigzag"]
  }));

  scenarios.push(routeScenario({
    key: "route-multi-ways",
    label: "三轴 6 Ways",
    excluded: [17],
    placements: pathPlacements(17, [[2], [0, 4], [1, 2, 3]]),
    tags: ["multi-way"]
  }));

  scenarios.push(routeScenario({
    key: "route-five-axes",
    label: "五轴连续路线",
    excluded: [15],
    placements: pathPlacements(15, [[1], [4], [0], [3], [2]]),
    tags: ["five-reel"]
  }));

  scenarios.push(routeScenario({
    key: "route-multi-icon",
    label: "同一步双图标中奖",
    excluded: [17, 19],
    placements: [
      ...pathPlacements(17, [[1], [0], [3]]),
      ...pathPlacements(19, [[4], [2], [1]])
    ],
    tags: ["multi-icon"]
  }));

  scenarios.push(routeScenario({
    key: "cascade-two-win-steps",
    label: "两步中奖级联 x1 到 x2",
    excluded: [17, 19],
    placements: pathPlacements(19, [[4], [1], [3]]),
    queues: [[17], [17], [17], [], []],
    tags: ["cascade", "x2"]
  }));

  scenarios.push(routeScenario({
    key: "cascade-four-win-steps",
    label: "四步中奖级联 x1/x2/x3/x5",
    excluded: [13, 15, 17, 19],
    placements: pathPlacements(19, [[1], [3], [0]]),
    queues: [[17, 15, 13], [17, 15, 13], [17, 15, 13], [], []],
    tags: ["cascade", "x2", "x3", "x5"]
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
    tags: ["gold", "wild"]
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
    tags: ["gold", "wild", "eliminate"]
  }));

  scenarios.push(routeScenario({
    key: "route-wild-reuse",
    label: "一个 Wild 跨多个图标复用",
    excluded: [13, 19],
    placements: [
      { reel: 0, row: 1, symbol: 13 },
      { reel: 0, row: 2, symbol: 19 },
      { reel: 0, row: 3, symbol: 2 },
      { reel: 1, row: 0, symbol: 13 },
      { reel: 1, row: 1, symbol: 19 },
      { reel: 1, row: 2, symbol: 2 },
      { reel: 2, row: 0, symbol: 13 },
      { reel: 2, row: 1, symbol: 19 },
      { reel: 2, row: 2, symbol: 2 }
    ],
    tags: ["wild", "multi-icon"]
  }));

  scenarios.push(routeScenario({
    key: "cascade-refill-win",
    label: "补牌后形成新路线",
    excluded: [3, 11],
    placements: pathPlacements(11, [[2], [4], [0]]),
    queues: [[3], [3], [3], [], []],
    tags: ["cascade", "refill"]
  }));

  scenarios.push(routeScenario({
    key: "cascade-limit-terminal",
    label: "达到级联上限后合法终止",
    excluded: [7, 9],
    placements: pathPlacements(9, [[4], [1], [2]]),
    queues: [[7], [7], [7], [], []],
    maxCascades: 1,
    tags: ["cascade-limit"]
  }));

  return scenarios;
}
