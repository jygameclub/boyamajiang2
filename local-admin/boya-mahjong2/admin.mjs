const symbols = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
const symbolNames = { 1: "胡", 3: "H1", 5: "H2", 7: "H3", 9: "H4", 11: "L1", 13: "L2", 15: "L3", 17: "L4", 19: "L5" };
const app = {
  activeConfig: null,
  editConfig: null,
  draftId: null,
  mode: "base",
  phase: "initial",
  scenarios: null,
  testState: null
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function money(value) {
  return (Number(value || 0) / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json", ...(options.headers || {}) } : options.headers
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP_${response.status}`);
  return payload.data;
}

function setMessage(id, message, error = false) {
  const element = document.getElementById(id);
  element.textContent = message;
  element.style.color = error ? "#b42318" : "#126d56";
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((entry) => entry.classList.toggle("active", entry === button));
    document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${button.dataset.tab}`));
    if (button.dataset.tab === "users") loadUsers();
    if (button.dataset.tab === "history") loadHistory();
    history.replaceState(null, "", `#${button.dataset.tab}`);
  }));
  const initial = location.hash.slice(1);
  if (initial) document.querySelector(`.tab[data-tab="${initial}"]`)?.click();
}

function bindSegments() {
  document.querySelectorAll("#mode-control button").forEach((button) => button.addEventListener("click", () => {
    app.mode = button.dataset.mode;
    document.querySelectorAll("#mode-control button").forEach((entry) => entry.classList.toggle("active", entry === button));
    renderConfig();
  }));
  document.querySelectorAll("#phase-control button").forEach((button) => button.addEventListener("click", () => {
    app.phase = button.dataset.phase;
    document.querySelectorAll("#phase-control button").forEach((entry) => entry.classList.toggle("active", entry === button));
    renderConfig();
  }));
}

function normalizedWeight(weights, symbol) {
  const total = Object.values(weights).reduce((sum, weight) => sum + Math.max(0, Number(weight) || 0), 0);
  return total > 0 ? `${((Math.max(0, Number(weights[symbol]) || 0) / total) * 100).toFixed(1)}%` : "0.0%";
}

function renderConfig() {
  if (!app.editConfig) return;
  const mode = app.editConfig.modes[app.mode];
  const phase = mode[app.phase];
  document.getElementById("weight-rows").innerHTML = symbols.map((symbol) => `
    <tr><th>${symbolNames[symbol]} <small>${symbol}</small></th>${phase.symbolWeights.map((weights, reel) => `
      <td><input type="number" min="0" max="100000" data-weight-symbol="${symbol}" data-weight-reel="${reel}" value="${weights[symbol] ?? 0}"><small class="weight-percent">${normalizedWeight(weights, symbol)}</small></td>
    `).join("")}</tr>
  `).join("");
  document.querySelectorAll("[data-weight-symbol]").forEach((input) => input.addEventListener("change", () => {
    phase.symbolWeights[Number(input.dataset.weightReel)][Number(input.dataset.weightSymbol)] = Number(input.value);
    renderConfig();
  }));
  document.querySelectorAll("[data-gold-reel]").forEach((input) => {
    const reel = Number(input.dataset.goldReel);
    input.value = phase.goldRateByReel[reel];
    input.disabled = reel === 0 || reel === 4 || ((app.mode === "free" || app.mode === "buy") && reel === 2);
    input.onchange = () => { phase.goldRateByReel[reel] = Number(input.value); };
  });
  const cascade = document.getElementById("cascade-limit");
  cascade.value = mode.cascadeLimit;
  cascade.onchange = () => { mode.cascadeLimit = Number(cascade.value); };
  renderOutcomeControls();
}

function renderOutcomeControls() {
  const container = document.getElementById("outcome-controls");
  const outcomes = app.editConfig.modes[app.mode].outcomeWeights;
  container.innerHTML = outcomes ? Object.entries(outcomes).map(([key, weight]) => `
    <label>${key}<input type="number" min="0" max="100000" data-outcome="${key}" value="${weight}"></label>
  `).join("") : "<span>购买模式使用下方胡数量权重</span>";
  container.querySelectorAll("[data-outcome]").forEach((input) => input.addEventListener("change", () => {
    app.editConfig.modes[app.mode].outcomeWeights[input.dataset.outcome] = Number(input.value);
  }));
  const scatter = app.editConfig.modes.buy.scatterWeights;
  document.getElementById("scatter-controls").innerHTML = Object.entries(scatter).map(([key, weight]) => `
    <label>${key}<input type="number" min="0" max="100000" data-scatter="${key}" value="${weight}"></label>
  `).join("");
  document.querySelectorAll("[data-scatter]").forEach((input) => input.addEventListener("change", () => {
    scatter[input.dataset.scatter] = Number(input.value);
  }));
}

async function loadRuntime() {
  const runtime = await api("/api/admin/runtime");
  document.getElementById("runtime-line").textContent = `用户 ${runtime.stats.users} / 会话 ${runtime.stats.sessions} / 记录 ${runtime.stats.rounds} / mismatch ${runtime.counts.mismatches}`;
  if (!app.activeConfig || app.activeConfig.id !== runtime.activeConfig.id) {
    app.activeConfig = runtime.activeConfig;
    app.editConfig = structuredClone(runtime.activeConfig.payload);
    document.getElementById("config-version").textContent = `Active v${runtime.activeConfig.versionNo} · ${runtime.activeConfig.name}`;
    renderConfig();
  }
}

async function saveDraft() {
  try {
    const draft = await api("/api/admin/config/drafts", {
      method: "POST",
      body: JSON.stringify({ name: `admin-${new Date().toISOString().slice(0, 19)}`, payload: app.editConfig })
    });
    app.draftId = draft.id;
    document.getElementById("validate-draft").disabled = false;
    document.getElementById("activate-draft").disabled = false;
    setMessage("config-message", `草稿 v${draft.versionNo} 已保存`);
  } catch (error) {
    setMessage("config-message", error.message, true);
  }
}

async function validateDraft() {
  try {
    await api(`/api/admin/config/drafts/${app.draftId}/validate`, { method: "POST" });
    setMessage("config-message", "草稿校验通过");
  } catch (error) {
    setMessage("config-message", error.message, true);
  }
}

async function activateDraft() {
  try {
    const active = await api(`/api/admin/config/drafts/${app.draftId}/activate`, { method: "POST" });
    app.activeConfig = active;
    app.draftId = null;
    document.getElementById("validate-draft").disabled = true;
    document.getElementById("activate-draft").disabled = true;
    document.getElementById("config-version").textContent = `Active v${active.versionNo} · ${active.name}`;
    setMessage("config-message", "新配置已激活，新会话立即使用");
  } catch (error) {
    setMessage("config-message", error.message, true);
  }
}

function renderScenarios() {
  const suiteSelect = document.getElementById("suite-select");
  suiteSelect.innerHTML = app.scenarios.suites.map((suite) => `<option value="${suite.key}">${suite.label}</option>`).join("");
  suiteSelect.value = app.testState.suiteKey;
  const suite = app.scenarios.suites.find((entry) => entry.key === suiteSelect.value) || app.scenarios.suites[0];
  const scenarioSelect = document.getElementById("scenario-select");
  scenarioSelect.innerHTML = `<option value="">按顺序</option>${suite.scenarios.map((scenario) => `<option value="${scenario.key}">${scenario.label || scenario.key}</option>`).join("")}`;
  scenarioSelect.value = app.testState.scenarioKey || "";
  document.getElementById("cycle-check").checked = app.testState.cycle;
  document.getElementById("test-cursor").value = app.testState.cursor;
  document.getElementById("scenario-rows").innerHTML = suite.scenarios.map((scenario) => `
    <tr><td>${scenario.label || scenario.key}<small>${scenario.key}</small></td><td>${scenario.amount == null ? "-" : (scenario.amount / 100).toFixed(2)}</td><td>${scenario.iconId ?? "-"}</td><td>${scenario.axleId == null ? "-" : scenario.axleId + 1}</td><td>${scenario.lineNum ?? "-"}</td><td>${scenario.winSteps ?? "-"}</td><td>${(scenario.multipliers || []).join("/") || "-"}</td><td>${(scenario.tags || []).join(", ") || "-"}</td></tr>
  `).join("");
}

async function loadTestControl() {
  [app.scenarios, app.testState] = await Promise.all([
    api("/api/admin/scenarios"),
    api("/api/admin/test-state")
  ]);
  renderScenarios();
}

async function saveTestState() {
  try {
    app.testState = await api("/api/admin/test-state", {
      method: "PUT",
      body: JSON.stringify({
        suiteKey: document.getElementById("suite-select").value,
        scenarioKey: document.getElementById("scenario-select").value || null,
        cursor: Number(document.getElementById("test-cursor").value),
        cycle: document.getElementById("cycle-check").checked
      })
    });
    setMessage("test-message", "测试控制已应用");
  } catch (error) {
    setMessage("test-message", error.message, true);
  }
}

async function runSimulation() {
  const output = document.getElementById("simulation-output");
  output.hidden = false;
  output.textContent = "模拟中";
  try {
    output.textContent = JSON.stringify(await api("/api/admin/simulate", {
      method: "POST",
      body: JSON.stringify({ count: 100, config: app.editConfig, seed: "admin-preview" })
    }), null, 2);
  } catch (error) {
    output.textContent = error.message;
  }
}

async function loadUsers() {
  const users = await api("/api/admin/users");
  document.getElementById("user-rows").innerHTML = users.map((user) => `
    <tr>
      <td>${escapeHtml(user.token)}</td>
      <td>${money(user.balance)}</td>
      <td>${user.roundCount}</td>
      <td>${money(user.totalWager)}</td>
      <td>${money(user.totalWin)}</td>
      <td class="rtp-value">${(Number(user.rtp || 0) * 100).toFixed(2)}%</td>
      <td>${escapeHtml(user.lastActiveAt)}</td>
      <td><button type="button" class="link-button" data-user-history="${escapeHtml(user.token)}">历史</button></td>
    </tr>
  `).join("") || `<tr><td colspan="8">暂无本地用户</td></tr>`;
  document.querySelectorAll("[data-user-history]").forEach((button) => button.addEventListener("click", () => {
    document.getElementById("history-token").value = button.dataset.userHistory;
    document.querySelector('.tab[data-tab="history"]').click();
  }));
}

function openUserClient() {
  const token = document.getElementById("new-user-token").value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(token)) {
    setMessage("user-message", "token 格式无效", true);
    return;
  }
  window.open(`/__game/live?token=${encodeURIComponent(token)}`, "_blank", "noopener");
}

async function loadHistory() {
  const params = new URLSearchParams({ limit: "100" });
  const token = document.getElementById("history-token").value.trim();
  const mode = document.getElementById("history-mode").value;
  const outcome = document.getElementById("history-outcome").value;
  if (token) params.set("token", token);
  if (mode) params.set("mode", mode);
  if (outcome) params.set("outcome", outcome);
  const rounds = await api(`/api/history/rounds?${params}`);
  document.getElementById("history-rows").innerHTML = rounds.map((round) => `
    <tr data-round-id="${round.id}"><td>${round.id}</td><td>${escapeHtml(round.createdAt)}</td><td>${escapeHtml(round.token || "-")}</td><td>${escapeHtml(round.mode)}</td><td>${escapeHtml(round.source)}</td><td>${escapeHtml(round.outcome)}</td><td>${money(round.kind === "buy" ? round.buyCost : round.bet)}</td><td>${money(round.totalWin)}</td><td>${escapeHtml(round.scenarioKey || "")}</td></tr>
  `).join("") || `<tr><td colspan="9">暂无历史</td></tr>`;
  document.querySelectorAll("[data-round-id]").forEach((row) => row.addEventListener("click", async () => {
    document.getElementById("round-detail").textContent = JSON.stringify(await api(`/api/history/rounds/${row.dataset.roundId}`), null, 2);
  }));
}

document.getElementById("save-draft").addEventListener("click", saveDraft);
document.getElementById("validate-draft").addEventListener("click", validateDraft);
document.getElementById("activate-draft").addEventListener("click", activateDraft);
document.getElementById("save-test-state").addEventListener("click", saveTestState);
document.getElementById("run-simulation").addEventListener("click", runSimulation);
document.getElementById("open-user-client").addEventListener("click", openUserClient);
document.getElementById("refresh-users").addEventListener("click", loadUsers);
document.getElementById("refresh-history").addEventListener("click", loadHistory);
document.getElementById("history-token").addEventListener("change", loadHistory);
document.getElementById("history-mode").addEventListener("change", loadHistory);
document.getElementById("history-outcome").addEventListener("change", loadHistory);
document.getElementById("suite-select").addEventListener("change", () => {
  app.testState.suiteKey = document.getElementById("suite-select").value;
  app.testState.scenarioKey = null;
  renderScenarios();
});

bindTabs();
bindSegments();
await Promise.all([loadRuntime(), loadTestControl()]);
setInterval(() => loadRuntime().catch(() => {}), 5000);
