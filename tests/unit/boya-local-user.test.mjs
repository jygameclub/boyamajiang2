import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOCAL_USER_BALANCE,
  DEFAULT_LOCAL_USER_TOKEN,
  normalizeGatewayUserToken,
  normalizeLocalUserToken
} from "../../tools/local/server/local-user.mjs";

const gameEntry = await import("../../tools/local/server/game-entry.mjs").catch(() => ({}));

test("local user tokens preserve supported names and reject unsafe values", () => {
  assert.equal(DEFAULT_LOCAL_USER_BALANCE, 100_000_000);
  assert.equal(DEFAULT_LOCAL_USER_TOKEN, "local-default");
  assert.equal(normalizeLocalUserToken("user1"), "user1");
  assert.equal(normalizeLocalUserToken("user2"), "user2");
  assert.equal(normalizeLocalUserToken("usergame1"), "usergame1");
  assert.equal(normalizeLocalUserToken(), "local-default");
  assert.equal(normalizeGatewayUserToken("user1?BAFJMAZ3AQZ4"), "user1");
  assert.throws(() => normalizeLocalUserToken("../user1"), /LOCAL_USER_TOKEN_INVALID/);
  assert.throws(() => normalizeLocalUserToken("user one"), /LOCAL_USER_TOKEN_INVALID/);
});

test("local live entry keeps the user token in the visible shortcut page", () => {
  assert.equal(typeof gameEntry.renderLocalGameEntry, "function");
  const html = gameEntry.renderLocalGameEntry({
    clientUrl: "http://127.0.0.1:18082/v2/?token=compat&g=local",
    userToken: "user1"
  });

  assert.match(html, /id="local-game-frame"/);
  assert.match(html, /data-user-token="user1"/);
  assert.match(html, /src="http:\/\/127\.0\.0\.1:18082\/v2\/\?token=compat&amp;g=local"/);
});
