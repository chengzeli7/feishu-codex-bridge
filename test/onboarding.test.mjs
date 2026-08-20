import test from "node:test";
import assert from "node:assert/strict";
import { extractVerificationUrl, hasAvailableBot } from "../src/onboarding.mjs";

test("extracts an opaque Feishu verification URL from JSON output", () => {
  const url = "https://open.feishu.cn/setup?code=abc&state=opaque";
  assert.equal(extractVerificationUrl(`{"verification_url":"https://open.feishu.cn/setup?code=abc\\u0026state=opaque"}`), url);
});

test("extracts a plain verification URL and ignores invalid status", () => {
  assert.equal(extractVerificationUrl("Open https://open.feishu.cn/setup/abc now"), "https://open.feishu.cn/setup/abc");
  assert.equal(extractVerificationUrl("no link"), null);
  assert.equal(hasAvailableBot("invalid"), false);
});

test("recognizes a verified bot profile", () => {
  assert.equal(hasAvailableBot(JSON.stringify({ identities: { bot: { available: true } } })), true);
  assert.equal(hasAvailableBot(JSON.stringify({ identities: { bot: { available: false } } })), false);
});
