import assert from "node:assert/strict";
import test from "node:test";

import { repairBrowserImageBytes } from "../../tools/lib/local-image-export.mjs";

test("repairBrowserImageBytes restores Cocos-obfuscated PNG header", () => {
  const data = Buffer.from([
    0x81, 0xda, 0x91, 0x66, 0xe9, 0x49, 0x1c, 0x49,
    0x29, 0x29, 0x29, 0x0d, 0x49, 0x48, 0x44, 0x52
  ]);

  const repaired = repairBrowserImageBytes(data, "image/png", "demo.png");

  assert.deepEqual([...repaired.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual([...repaired.subarray(8, 12)], [0x00, 0x00, 0x00, 0x0d]);
  assert.equal(repaired.subarray(12, 16).toString("ascii"), "IHDR");
});

test("repairBrowserImageBytes restores Cocos-obfuscated JPEG header", () => {
  const data = Buffer.from([
    0xab, 0x4c, 0xab, 0xaf, 0x29, 0xa6, 0xc4, 0x44,
    0x6b, 0x44, 0x29, 0x01, 0x02, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xdb
  ]);

  const repaired = repairBrowserImageBytes(data, "image/jpeg", "demo.jpg");

  assert.deepEqual([...repaired.subarray(0, 11)], [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  assert.equal(repaired[20], 0xff);
  assert.equal(repaired[21], 0xdb);
});

test("repairBrowserImageBytes restores Cocos-obfuscated JPEG ICC profile header", () => {
  const data = Buffer.alloc(128);
  Buffer.from([
    0xab, 0x4c, 0xab, 0x01, 0xbb, 0x7e, 0x6b, 0x4f,
    0x4f, 0x53, 0xda, 0x52, 0x4f, 0x46, 0x49, 0x4c,
    0x45, 0x00, 0x01, 0x01
  ]).copy(data);
  data[100] = 0xff;
  data[101] = 0xdb;

  const repaired = repairBrowserImageBytes(data, "image/jpeg", "demo.jpg");

  assert.deepEqual([...repaired.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe2]);
  assert.equal(repaired.readUInt16BE(4), 96);
  assert.equal(repaired.subarray(6, 18).toString("ascii"), "ICC_PROFILE\0");
});

test("repairBrowserImageBytes restores Cocos-obfuscated WebP RIFF header", () => {
  const data = Buffer.from([
    0xca, 0x6b, 0x44, 0x44, 0xa5, 0x5d, 0xbe, 0x29,
    0x80, 0xf2, 0xad, 0x50, 0x56, 0x50, 0x38, 0x58
  ]);

  const repaired = repairBrowserImageBytes(data, "image/webp", "demo.webp");

  assert.equal(repaired.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(repaired.readUInt32LE(4), data.length - 8);
  assert.equal(repaired.subarray(8, 12).toString("ascii"), "WEBP");
  assert.equal(repaired.subarray(12, 16).toString("ascii"), "VP8X");
});
