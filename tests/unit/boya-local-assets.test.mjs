import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const assetRoot = new URL("../../local-har-client/boya-mahjong2/v2/assets/dy_mjlltwo_en/", import.meta.url);
const sharedAssetRoot = new URL("../../local-har-client/boya-mahjong2/v2/assets/resources/", import.meta.url);

test("locally restored normal-win symbol audio includes metadata and native MP3", async () => {
  const metadata = await stat(new URL(
    "import/52/525a9d05-9c3e-4144-b7b5-d3a6e77bd18e.698ef.json",
    assetRoot
  ));
  const audio = await stat(new URL(
    "native/52/525a9d05-9c3e-4144-b7b5-d3a6e77bd18e.aa65c.mp3",
    assetRoot
  ));

  assert.ok(metadata.size > 0);
  assert.ok(audio.size > 1000);
});

test("locally restored auto-spin dialog includes its lazy-loaded prefab package", async () => {
  const files = await Promise.all([
    "import/0b/0b45ea3c9.cdb02.json",
    "import/b9/b9140739-1ed5-49b7-a6bd-d211fc3e7653.9cd52.json",
    "import/a3/a3e01927-1762-4fb4-ad78-bcf4d129bc35.38be2.json"
  ].map((relativePath) => stat(new URL(relativePath, sharedAssetRoot))));

  assert.ok(files.every((file) => file.size > 100));
});

test("locally restored replay completion dialog includes its lazy-loaded prefab package", async () => {
  const replayPrefab = await stat(new URL("import/0a/0a4b4a236.2d13e.json", sharedAssetRoot));
  assert.ok(replayPrefab.size > 1000);
});

test("locally restored language selector includes its lazy-loaded item package", async () => {
  const languageItems = await stat(new URL(
    "import/99/991d1741-2dd3-4b0d-90f8-f8dfc2706b73.4632e.json",
    sharedAssetRoot
  ));
  assert.ok(languageItems.size > 100);
});

test("language selector label assets and its native flag texture are all local", async () => {
  const labels = await Promise.all([
    "import/a8/a8683e93-f191-4f42-bf2b-fe4b7ac0cebb.591ad.json",
    "import/6a/6ab3a770-03f9-4104-b007-bed00a476cec.73edb.json",
    "import/d5/d57c4d88-1e21-4617-a551-49f4cce85153.328cc.json",
    "import/a4/a46d6795-d8e7-49c0-9dfe-3bdc43a888f9.201a9.json",
    "import/6b/6b648e35-ecb6-45b5-a232-3e2b49a63188.95ea7.json",
    "import/15/1544e03c-da17-4d85-92b6-79e603cc97de.f2777.json",
    "import/7b/7b4320f4-cf49-4af2-9441-1ffee6a8700f.cdbdf.json",
    "import/86/86cb882a-59c2-4ede-b5fe-8c189fc6de9f.879a6.json",
    "import/81/817e31e2-3a8c-4a98-89c9-443076f65d46.00f45.json"
  ].map((relativePath) => stat(new URL(relativePath, assetRoot))));
  const texture = await stat(new URL("native/1c/1c0b3a350.1b891.webp", assetRoot));

  assert.ok(labels.every((file) => file.size > 100));
  assert.ok(texture.size > 100);
});

test("locally restored quit dialog includes its lazy-loaded prefab package", async () => {
  const quitFiles = await Promise.all([
    "import/02/02b7b0d1c.f9004.json",
    "import/79/791d6f4c-58f1-40f3-b49a-ae3291719814.5c121.json"
  ].map((relativePath) => stat(new URL(relativePath, sharedAssetRoot))));
  assert.ok(quitFiles[0].size > 1000);
  assert.ok(quitFiles[1].size > 100);
});

test("restored client gateway fallback is local and contains no production host", async () => {
  const source = await readFile(new URL(
    "../../local-har-client/boya-mahjong2/v2/src/assets/gateConfig.6e55b.js",
    import.meta.url
  ), "utf8");

  assert.match(source, /window\.location\.host/);
  assert.doesNotMatch(source, /gateway(?:2020)?\.666789\.site/);
});

test("local Mahjong Ways 2 help documents the rules used by the controlled engine", async () => {
  const helpModule = await import("../../tools/local/server/game-help.mjs").catch(() => null);
  assert.ok(helpModule, "local game help renderer must exist");
  assert.equal(typeof helpModule.renderBoyaGameHelp, "function");

  const html = helpModule.renderBoyaGameHelp();
  assert.match(html, /2000 Ways/);
  assert.match(html, /80/);
  assert.match(html, /x1.*x2.*x3.*x5/s);
  assert.match(html, /x2.*x4.*x6.*x10/s);
  assert.match(html, /3.*10.*4.*12.*5.*14/s);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("local activity entry renders a self-contained local game hub", async () => {
  const helpModule = await import("../../tools/local/server/game-help.mjs").catch(() => null);
  assert.ok(helpModule, "local activity renderer must exist");
  assert.equal(typeof helpModule.renderBoyaLocalHub, "function");

  const html = helpModule.renderBoyaLocalHub();
  assert.match(html, /本地游戏大厅/);
  assert.match(html, /\/__game\/test/);
  assert.match(html, /\/__game\/live\?token=user1/);
  assert.match(html, /\/__admin/);
  assert.match(html, /Msg_GetActivityLobbyGameInfoReq/);
  assert.match(html, /onCloseClick/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("local admin history exposes the config version used by each round", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("../../local-admin/boya-mahjong2/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../local-admin/boya-mahjong2/admin.mjs", import.meta.url), "utf8")
  ]);

  assert.match(html, /<th>配置<\/th>/);
  assert.match(source, /round\.configId/);
});

test("local admin disables the unused purchase cascade-limit control", async () => {
  const source = await readFile(new URL(
    "../../local-admin/boya-mahjong2/admin.mjs",
    import.meta.url
  ), "utf8");

  assert.match(source, /cascade\.disabled\s*=\s*app\.mode\s*===\s*"buy"/);
});
