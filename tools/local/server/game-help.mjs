import { BOYA_PAYTABLE } from "../engine/constants.mjs";

const SYMBOL_NAMES = Object.freeze({
  3: "高价值符号 A",
  5: "高价值符号 B",
  7: "高价值符号 C",
  9: "高价值符号 D",
  11: "普通符号 A",
  13: "普通符号 B",
  15: "普通符号 C",
  17: "普通符号 D",
  19: "普通符号 E"
});

function payoutRows() {
  return Object.entries(BOYA_PAYTABLE).map(([symbolId, rates]) => `
    <tr>
      <th>${SYMBOL_NAMES[symbolId]} <small>ID ${symbolId}</small></th>
      <td>${rates[0]}</td>
      <td>${rates[1]}</td>
      <td>${rates[2]}</td>
    </tr>`).join("");
}

export function renderBoyaGameHelp() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>Mahjong Ways 2 规则</title>
  <style>
    :root { color-scheme: light; --ink: #182523; --muted: #5f6d69; --line: #d8e0dc; --green: #126b5d; --red: #b43e34; --gold: #b8831f; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #fff; color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; font-size: 16px; line-height: 1.65; }
    main { width: min(100%, 760px); margin: 0 auto; padding: 22px 22px 42px; }
    header { padding: 6px 0 18px; border-bottom: 3px solid var(--green); }
    h1 { margin: 0; font-size: 26px; font-weight: 760; color: var(--green); letter-spacing: 0; }
    header p { margin: 5px 0 0; color: var(--muted); }
    section { padding: 22px 0; border-bottom: 1px solid var(--line); }
    h2 { margin: 0 0 10px; font-size: 20px; color: var(--red); letter-spacing: 0; }
    p { margin: 8px 0; }
    strong { color: var(--green); }
    .steps { margin: 8px 0 0; padding-left: 22px; }
    .steps li { margin: 7px 0; }
    .formula { margin: 12px 0; padding: 10px 12px; border-left: 4px solid var(--gold); background: #f4f7f5; font-weight: 650; }
    .multipliers { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
    .multipliers div { border: 1px solid var(--line); padding: 10px 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-variant-numeric: tabular-nums; }
    th, td { padding: 9px 8px; border: 1px solid var(--line); text-align: center; }
    thead th { background: #eaf2ef; color: var(--green); }
    tbody th { text-align: left; font-weight: 650; }
    small { display: block; color: var(--muted); font-weight: 500; }
    .note { color: var(--muted); font-size: 14px; }
    @media (max-width: 520px) {
      main { padding-inline: 16px; }
      .multipliers { grid-template-columns: 1fr; }
      th, td { padding: 8px 5px; font-size: 14px; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <h1>Mahjong Ways 2</h1>
    <p>2000 Ways 连续中奖与消除规则</p>
  </header>

  <section>
    <h2>中奖方式</h2>
    <ol class="steps">
      <li>相同符号必须从第 1 轴开始，在相邻轴连续出现至少 3 轴。</li>
      <li>每轴命中的同类符号数量相乘得到 Ways 数；最多计算到第 5 轴。</li>
      <li>Wild 可代替普通支付符号；Scatter 不参与普通 Ways 赔付。</li>
    </ol>
    <div class="formula">奖金 = 符号赔率 x Ways 数 x 当前消除倍数 x 投注倍率</div>
  </section>

  <section>
    <h2>符号赔率</h2>
    <p>下表依次为连续 3 轴、4 轴、5 轴时的基础赔率。</p>
    <table>
      <thead><tr><th>符号</th><th>3 轴</th><th>4 轴</th><th>5 轴</th></tr></thead>
      <tbody>${payoutRows()}</tbody>
    </table>
  </section>

  <section>
    <h2>消除与倍数</h2>
    <p>中奖符号消除后，上方符号下落并补入新符号；新盘面仍中奖时继续消除。同一轮中每次消除会提高倍数。</p>
    <div class="multipliers">
      <div><strong>普通游戏</strong><br>x1、x2、x3、x5</div>
      <div><strong>免费游戏</strong><br>x2、x4、x6、x10</div>
    </div>
    <p>金色普通符号参与中奖后，会在下一次掉落中转换为 Wild；显示盘面、中奖路径和结算金额使用同一份服务端结果。</p>
  </section>

  <section>
    <h2>胡牌符号与免费游戏</h2>
    <p>盘面出现至少 3 个胡牌 Scatter 时触发免费游戏：3 个送 10 次、4 个送 12 次、5 个送 14 次、6 个送 15 次。</p>
    <p>“购买免费游戏”的费用为当前总投注的 <strong>80 倍</strong>；购买结果仍由本地服务端生成胡牌数量、免费次数、盘面及每次中奖。</p>
  </section>

  <p class="note">本规则页、游戏素材、局结果、用户余额、历史记录与回放数据均由当前本地环境提供。</p>
</main>
</body>
</html>`;
}

export function renderBoyaLocalHub() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>本地游戏大厅</title>
  <style>
    :root { color-scheme: light; --ink: #172522; --muted: #63716d; --line: #d9e1de; --green: #126b5d; --red: #a63b32; --bg: #f5f7f6; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; font-size: 16px; line-height: 1.5; }
    main { width: min(100%, 720px); min-height: 100vh; margin: 0 auto; background: #fff; }
    header { display: grid; grid-template-columns: 1fr 44px; align-items: center; gap: 12px; padding: 20px 18px 18px 22px; border-bottom: 3px solid var(--green); }
    h1 { margin: 0; color: var(--green); font-size: 26px; letter-spacing: 0; }
    header p { grid-column: 1; margin: 5px 0 0; color: var(--muted); }
    button { grid-column: 2; grid-row: 1 / span 2; width: 44px; height: 44px; border: 0; background: transparent; color: var(--red); font-size: 34px; line-height: 1; cursor: pointer; }
    button:active { background: #edf4f1; }
    nav { display: grid; }
    a { display: grid; grid-template-columns: 42px 1fr 22px; align-items: center; gap: 12px; min-height: 78px; padding: 14px 22px; border-bottom: 1px solid var(--line); color: var(--ink); text-decoration: none; }
    a:active { background: #edf4f1; }
    .icon { display: grid; place-items: center; width: 40px; height: 40px; border: 1px solid var(--line); color: var(--green); font-size: 20px; font-weight: 750; }
    .title { display: block; font-weight: 730; }
    .meta { display: block; color: var(--muted); font-size: 13px; }
    .arrow { color: var(--red); font-size: 24px; }
    footer { padding: 18px 22px 28px; color: var(--muted); font-size: 13px; }
  </style>
</head>
<body>
<main>
  <header>
    <h1>本地游戏大厅</h1>
    <p>Mahjong Ways 2</p>
    <button id="close" type="button" aria-label="关闭" title="关闭">×</button>
  </header>
  <nav aria-label="本地入口">
    <a href="/__game/test" target="_top"><span class="icon">测</span><span><span class="title">测试数据模式</span><span class="meta">固定场景轮播</span></span><span class="arrow">›</span></a>
    <a href="/__game/live?token=user1" target="_top"><span class="icon">玩</span><span><span class="title">本地概率模式</span><span class="meta">用户 user1</span></span><span class="arrow">›</span></a>
    <a href="/__admin" target="_top"><span class="icon">管</span><span><span class="title">本地控制后台</span><span class="meta">概率、用户与历史记录</span></span><span class="arrow">›</span></a>
    <a href="/__admin#history" target="_top"><span class="icon">史</span><span><span class="title">服务端历史记录</span><span class="meta">局结果与 RTP</span></span><span class="arrow">›</span></a>
  </nav>
  <footer>所有入口均连接当前本地服务。</footer>
</main>
<script>
  const sendToGame = (message) => window.parent.postMessage(JSON.stringify(message), "*");
  document.getElementById("close").addEventListener("click", () => {
    sendToGame({ type: "click", tag: "onCloseClick", args: {} });
  });
  sendToGame({
    type: "get",
    tag: "Msg_GetActivityLobbyGameInfoReq",
    args: { language: true }
  });
</script>
</body>
</html>`;
}
