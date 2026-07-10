import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { cloneDefaultControlConfig } from "../engine/default-config.mjs";
import {
  DEFAULT_LOCAL_USER_BALANCE,
  normalizeLocalUserToken
} from "./local-user.mjs";

const SCHEMA_VERSION = 3;

function now() {
  return new Date().toISOString();
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  return JSON.parse(value);
}

function plain(row) {
  return row ? { ...row } : null;
}

function configFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    versionNo: row.version_no,
    revision: row.revision,
    name: row.name,
    status: row.status,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at,
    activatedAt: row.activated_at
  };
}

function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    token: row.token,
    balance: row.balance,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function userStatsFromRow(row) {
  if (!row) return null;
  const totalWager = Number(row.totalWager || 0);
  const totalWin = Number(row.totalWin || 0);
  return {
    id: row.id,
    token: row.token,
    balance: Number(row.balance),
    roundCount: Number(row.roundCount || 0),
    totalWager,
    totalWin,
    rtp: totalWager > 0 ? totalWin / totalWager : 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActiveAt: row.lastActiveAt || row.updatedAt
  };
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_no INTEGER NOT NULL UNIQUE,
      revision INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','active','archived')),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      activated_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_config_single_active
      ON config_versions(status) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS symbol_weights (
      config_id INTEGER NOT NULL REFERENCES config_versions(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      phase TEXT NOT NULL,
      reel INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      weight INTEGER NOT NULL,
      PRIMARY KEY(config_id, mode, phase, reel, symbol_id)
    );

    CREATE TABLE IF NOT EXISTS outcome_weights (
      config_id INTEGER NOT NULL REFERENCES config_versions(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      outcome_key TEXT NOT NULL,
      weight INTEGER NOT NULL,
      PRIMARY KEY(config_id, mode, outcome_key)
    );

    CREATE TABLE IF NOT EXISTS engine_settings (
      config_id INTEGER NOT NULL REFERENCES config_versions(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY(config_id, key)
    );

    CREATE TABLE IF NOT EXISTS test_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      suite_key TEXT NOT NULL,
      scenario_key TEXT,
      cursor INTEGER NOT NULL DEFAULT 0,
      cycle INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      balance INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      seed TEXT NOT NULL,
      config_id INTEGER REFERENCES config_versions(id),
      user_id INTEGER REFERENCES local_users(id),
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      close_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS game_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
      round_no INTEGER NOT NULL,
      kind TEXT NOT NULL,
      bet INTEGER NOT NULL DEFAULT 0,
      buy_cost INTEGER NOT NULL DEFAULT 0,
      total_win INTEGER NOT NULL DEFAULT 0,
      bet_multi INTEGER NOT NULL DEFAULT 0,
      balance_before INTEGER NOT NULL DEFAULT 0,
      balance_after INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL,
      source TEXT NOT NULL,
      scenario_key TEXT,
      seed TEXT NOT NULL,
      validation_status TEXT NOT NULL,
      fallback_reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS round_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
      step_no INTEGER NOT NULL,
      cmd INTEGER NOT NULL,
      board_json TEXT NOT NULL,
      buffers_json TEXT NOT NULL,
      lines_json TEXT NOT NULL,
      multiplier INTEGER NOT NULL,
      round_win INTEGER NOT NULL,
      total_win INTEGER NOT NULL,
      free_remain INTEGER NOT NULL DEFAULT 0,
      gold_to_wild_json TEXT NOT NULL,
      UNIQUE(round_id, step_no)
    );

    CREATE TABLE IF NOT EXISTS protocol_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER REFERENCES game_sessions(id) ON DELETE CASCADE,
      round_id INTEGER REFERENCES game_rounds(id) ON DELETE SET NULL,
      direction TEXT NOT NULL,
      cmd INTEGER NOT NULL,
      frame_sha256 TEXT,
      decoded_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rounds_created ON game_rounds(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_steps_round ON round_steps(round_id, step_no);
    CREATE INDEX IF NOT EXISTS idx_events_session ON protocol_events(session_id, id);
  `);
  ensureColumn(db, "game_rounds", "bet_multi", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "game_rounds", "balance_before", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "game_rounds", "balance_after", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "game_sessions", "user_id", "INTEGER REFERENCES local_users(id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON game_sessions(user_id, id)");
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(SCHEMA_VERSION, now());
  db.prepare(`
    INSERT OR IGNORE INTO test_state(id, suite_key, scenario_key, cursor, cycle, updated_at)
    VALUES (1, 'base-small-ladder', NULL, 0, 1, ?)
  `).run(now());
}

function syncConfigChildren(db, configId, payload) {
  db.prepare("DELETE FROM symbol_weights WHERE config_id = ?").run(configId);
  db.prepare("DELETE FROM outcome_weights WHERE config_id = ?").run(configId);
  db.prepare("DELETE FROM engine_settings WHERE config_id = ?").run(configId);
  const symbolInsert = db.prepare(`
    INSERT INTO symbol_weights(config_id, mode, phase, reel, symbol_id, weight)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const outcomeInsert = db.prepare(`
    INSERT INTO outcome_weights(config_id, mode, outcome_key, weight)
    VALUES (?, ?, ?, ?)
  `);
  const settingInsert = db.prepare(`
    INSERT INTO engine_settings(config_id, key, value_json) VALUES (?, ?, ?)
  `);

  for (const [mode, modeConfig] of Object.entries(payload.modes || {})) {
    for (const phase of ["initial", "cascade"]) {
      const phaseConfig = modeConfig[phase];
      for (let reel = 0; reel < (phaseConfig?.symbolWeights?.length || 0); reel += 1) {
        for (const [symbolId, weight] of Object.entries(phaseConfig.symbolWeights[reel])) {
          symbolInsert.run(configId, mode, phase, reel, Number(symbolId), Number(weight));
        }
      }
      if (phaseConfig?.goldRateByReel) {
        settingInsert.run(configId, `${mode}.${phase}.goldRateByReel`, JSON.stringify(phaseConfig.goldRateByReel));
      }
    }
    for (const [key, weight] of Object.entries(modeConfig.outcomeWeights || modeConfig.scatterWeights || {})) {
      outcomeInsert.run(configId, mode, key, Number(weight));
    }
    for (const key of ["cascadeLimit", "scatterCap"]) {
      if (modeConfig[key] !== undefined) {
        settingInsert.run(configId, `${mode}.${key}`, JSON.stringify(modeConfig[key]));
      }
    }
  }
  settingInsert.run(configId, "buyCostMultiplier", JSON.stringify(payload.buyCostMultiplier));
}

function seedDefaultConfig(db) {
  const existing = db.prepare("SELECT id FROM config_versions LIMIT 1").get();
  if (existing) return;
  const payload = cloneDefaultControlConfig();
  const timestamp = now();
  const result = db.prepare(`
    INSERT INTO config_versions(version_no, revision, name, status, payload_json, created_at, activated_at)
    VALUES (1, 1, 'default-local', 'active', ?, ?, ?)
  `).run(JSON.stringify(payload), timestamp, timestamp);
  syncConfigChildren(db, Number(result.lastInsertRowid), payload);
}

export function openLocalStore(dbPath) {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  seedDefaultConfig(db);

  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    path: dbPath,
    getOrCreateUser(token) {
      const normalizedToken = normalizeLocalUserToken(token);
      return transaction(() => {
        const timestamp = now();
        db.prepare(`
          INSERT OR IGNORE INTO local_users(token, balance, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(normalizedToken, DEFAULT_LOCAL_USER_BALANCE, timestamp, timestamp);
        return userFromRow(db.prepare("SELECT * FROM local_users WHERE token = ?").get(normalizedToken));
      });
    },
    getUser(token) {
      const normalizedToken = normalizeLocalUserToken(token);
      return userFromRow(db.prepare("SELECT * FROM local_users WHERE token = ?").get(normalizedToken));
    },
    listUsers() {
      return db.prepare(`
        SELECT u.id, u.token, u.balance, u.created_at AS createdAt, u.updated_at AS updatedAt,
               COUNT(r.id) AS roundCount,
               COALESCE(SUM(CASE
                 WHEN r.kind = 'base' THEN r.bet
                 WHEN r.kind = 'buy' THEN r.buy_cost
                 ELSE 0
               END), 0) AS totalWager,
               COALESCE(SUM(CASE
                 WHEN r.kind IN ('base', 'free-feature') THEN r.total_win
                 ELSE 0
               END), 0) AS totalWin,
               MAX(COALESCE(r.created_at, s.opened_at, u.updated_at)) AS lastActiveAt
        FROM local_users u
        LEFT JOIN game_sessions s ON s.user_id = u.id
        LEFT JOIN game_rounds r ON r.session_id = s.id
        GROUP BY u.id
        ORDER BY u.id DESC
      `).all().map(userStatsFromRow);
    },
    getUserStats(token) {
      const normalizedToken = normalizeLocalUserToken(token);
      return this.listUsers().find((user) => user.token === normalizedToken) || null;
    },
    getActiveConfig() {
      return configFromRow(db.prepare("SELECT * FROM config_versions WHERE status = 'active'").get());
    },
    getConfig(id) {
      return configFromRow(db.prepare("SELECT * FROM config_versions WHERE id = ?").get(Number(id)));
    },
    listConfigs() {
      return db.prepare("SELECT * FROM config_versions ORDER BY version_no DESC").all().map(configFromRow);
    },
    createDraft(name, payload) {
      return transaction(() => {
        const row = db.prepare("SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version FROM config_versions").get();
        const result = db.prepare(`
          INSERT INTO config_versions(version_no, revision, name, status, payload_json, created_at)
          VALUES (?, 1, ?, 'draft', ?, ?)
        `).run(row.next_version, String(name || `draft-${row.next_version}`), JSON.stringify(payload), now());
        const id = Number(result.lastInsertRowid);
        syncConfigChildren(db, id, payload);
        return configFromRow(db.prepare("SELECT * FROM config_versions WHERE id = ?").get(id));
      });
    },
    updateDraft(id, payload, expectedRevision) {
      return transaction(() => {
        const before = configFromRow(db.prepare("SELECT * FROM config_versions WHERE id = ?").get(id));
        if (!before || before.status !== "draft") throw new Error("Draft config not found");
        if (expectedRevision !== undefined && before.revision !== Number(expectedRevision)) {
          const error = new Error("CONFIG_VERSION_CONFLICT");
          error.statusCode = 409;
          throw error;
        }
        db.prepare("UPDATE config_versions SET payload_json = ?, revision = revision + 1 WHERE id = ?")
          .run(JSON.stringify(payload), id);
        syncConfigChildren(db, id, payload);
        db.prepare("INSERT INTO admin_audit(action, before_json, after_json, created_at) VALUES (?, ?, ?, ?)")
          .run("config-update", JSON.stringify(before), JSON.stringify(payload), now());
        return configFromRow(db.prepare("SELECT * FROM config_versions WHERE id = ?").get(id));
      });
    },
    activateConfig(id) {
      return transaction(() => {
        const target = configFromRow(db.prepare("SELECT * FROM config_versions WHERE id = ?").get(id));
        if (!target || target.status !== "draft") throw new Error("Draft config not found");
        const before = this.getActiveConfig();
        db.prepare("UPDATE config_versions SET status = 'archived' WHERE status = 'active'").run();
        db.prepare("UPDATE config_versions SET status = 'active', activated_at = ? WHERE id = ?").run(now(), id);
        const after = configFromRow(db.prepare("SELECT * FROM config_versions WHERE id = ?").get(id));
        db.prepare("INSERT INTO admin_audit(action, before_json, after_json, created_at) VALUES (?, ?, ?, ?)")
          .run("config-activate", JSON.stringify(before), JSON.stringify(after), now());
        return after;
      });
    },
    getTestState() {
      const row = db.prepare("SELECT * FROM test_state WHERE id = 1").get();
      return {
        suiteKey: row.suite_key,
        scenarioKey: row.scenario_key,
        cursor: row.cursor,
        cycle: Boolean(row.cycle),
        updatedAt: row.updated_at
      };
    },
    updateTestState({ suiteKey, scenarioKey = null, cursor = 0, cycle = true }) {
      db.prepare(`
        UPDATE test_state SET suite_key = ?, scenario_key = ?, cursor = ?, cycle = ?, updated_at = ? WHERE id = 1
      `).run(suiteKey, scenarioKey, Number(cursor), cycle ? 1 : 0, now());
      return this.getTestState();
    },
    advanceTestCursor(nextCursor) {
      db.prepare("UPDATE test_state SET cursor = ?, updated_at = ? WHERE id = 1").run(Number(nextCursor), now());
      return this.getTestState();
    },
    createSession({ mode, seed, configId, userId = null }) {
      const result = db.prepare(`
        INSERT INTO game_sessions(mode, seed, config_id, user_id, opened_at) VALUES (?, ?, ?, ?, ?)
      `).run(mode, String(seed), configId, userId, now());
      return plain(db.prepare("SELECT * FROM game_sessions WHERE id = ?").get(Number(result.lastInsertRowid)));
    },
    closeSession(id, reason = "closed") {
      db.prepare("UPDATE game_sessions SET closed_at = ?, close_reason = ? WHERE id = ?").run(now(), reason, id);
    },
    recordRound(round) {
      return transaction(() => {
        const result = db.prepare(`
          INSERT INTO game_rounds(
            session_id, round_no, kind, bet, buy_cost, total_win, bet_multi,
            balance_before, balance_after, outcome, source,
            scenario_key, seed, validation_status, fallback_reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          round.sessionId,
          round.roundNo,
          round.kind,
          round.bet || 0,
          round.buyCost || 0,
          round.totalWin || 0,
          round.betMulti || 0,
          round.balanceBefore || 0,
          round.balanceAfter || 0,
          round.outcome,
          round.source,
          round.scenarioKey || null,
          String(round.seed),
          round.validationStatus,
          round.fallbackReason || null,
          now()
        );
        const roundId = Number(result.lastInsertRowid);
        const stepInsert = db.prepare(`
          INSERT INTO round_steps(
            round_id, step_no, cmd, board_json, buffers_json, lines_json, multiplier,
            round_win, total_win, free_remain, gold_to_wild_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const step of round.steps || []) {
          stepInsert.run(
            roundId,
            step.stepNo,
            step.cmd,
            JSON.stringify(step.board),
            JSON.stringify({ topResult: step.topResult, buttomResult: step.buttomResult }),
            JSON.stringify(step.lines || []),
            step.multiplier || 0,
            step.roundWin || 0,
            step.totalWin || 0,
            step.freeRemain || 0,
            JSON.stringify(step.goldToWild || [])
          );
        }
        if (round.userBalanceAfter !== undefined) {
          db.prepare(`
            UPDATE local_users
            SET balance = ?, updated_at = ?
            WHERE id = (SELECT user_id FROM game_sessions WHERE id = ?)
          `).run(Number(round.userBalanceAfter), now(), round.sessionId);
        }
        return plain(db.prepare("SELECT * FROM game_rounds WHERE id = ?").get(roundId));
      });
    },
    recordProtocolEvent({ sessionId = null, roundId = null, direction, cmd, frameSha256 = null, decoded = null }) {
      const result = db.prepare(`
        INSERT INTO protocol_events(session_id, round_id, direction, cmd, frame_sha256, decoded_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, roundId, direction, cmd, frameSha256, decoded ? JSON.stringify(decoded) : null, now());
      return Number(result.lastInsertRowid);
    },
    listRounds({ limit = 100, mode, outcome, token } = {}) {
      const clauses = [];
      const params = [];
      if (mode) {
        clauses.push("s.mode = ?");
        params.push(mode);
      }
      if (outcome) {
        clauses.push("r.outcome = ?");
        params.push(outcome);
      }
      if (token) {
        clauses.push("u.token = ?");
        params.push(normalizeLocalUserToken(token, { useDefault: false }));
      }
      params.push(Math.max(1, Math.min(1000, Number(limit) || 100)));
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return db.prepare(`
        SELECT r.id, r.session_id AS sessionId, s.mode, r.round_no AS roundNo,
               r.kind, r.bet, r.buy_cost AS buyCost, r.total_win AS totalWin,
               r.bet_multi AS betMulti, r.balance_before AS balanceBefore,
               r.balance_after AS balanceAfter,
               r.outcome, r.source, r.scenario_key AS scenarioKey, r.seed, u.token,
               r.validation_status AS validationStatus, r.fallback_reason AS fallbackReason,
               r.created_at AS createdAt
        FROM game_rounds r
        JOIN game_sessions s ON s.id = r.session_id
        LEFT JOIN local_users u ON u.id = s.user_id
        ${where} ORDER BY r.id DESC LIMIT ?
      `).all(...params).map(plain);
    },
    getRound(id, { token } = {}) {
      const params = [id];
      const tokenClause = token ? "AND u.token = ?" : "";
      if (token) params.push(normalizeLocalUserToken(token, { useDefault: false }));
      const round = plain(db.prepare(`
        SELECT r.id, r.session_id AS sessionId, s.mode, r.round_no AS roundNo,
               r.kind, r.bet, r.buy_cost AS buyCost, r.total_win AS totalWin,
               r.bet_multi AS betMulti, r.balance_before AS balanceBefore,
               r.balance_after AS balanceAfter, r.outcome, r.source,
               r.scenario_key AS scenarioKey, r.seed,
               r.validation_status AS validationStatus, r.fallback_reason AS fallbackReason,
               r.created_at AS createdAt, u.token
        FROM game_rounds r
        JOIN game_sessions s ON s.id = r.session_id
        LEFT JOIN local_users u ON u.id = s.user_id
        WHERE r.id = ? ${tokenClause}
      `).get(...params));
      if (!round) return null;
      round.steps = db.prepare("SELECT * FROM round_steps WHERE round_id = ? ORDER BY step_no").all(id).map((step) => ({
        id: step.id,
        stepNo: step.step_no,
        cmd: step.cmd,
        board: parseJson(step.board_json, []),
        ...parseJson(step.buffers_json, {}),
        lines: parseJson(step.lines_json, []),
        multiplier: step.multiplier,
        roundWin: step.round_win,
        totalWin: step.total_win,
        freeRemain: step.free_remain,
        goldToWild: parseJson(step.gold_to_wild_json, [])
      }));
      return round;
    },
    runtimeStats() {
      return {
        sessions: db.prepare("SELECT COUNT(*) AS count FROM game_sessions").get().count,
        users: db.prepare("SELECT COUNT(*) AS count FROM local_users").get().count,
        rounds: db.prepare("SELECT COUNT(*) AS count FROM game_rounds").get().count,
        steps: db.prepare("SELECT COUNT(*) AS count FROM round_steps").get().count,
        protocolEvents: db.prepare("SELECT COUNT(*) AS count FROM protocol_events").get().count
      };
    },
    close() {
      if (dbPath !== ":memory:") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    }
  };
}
