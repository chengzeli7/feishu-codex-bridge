import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/logger.mjs";

test("redacts tokens and secrets from structured logs", () => {
  const result = redact({ authorization: "Bearer abc.def", detail: "access_token: hidden-value", nested: { app_secret: "secret" } });
  assert.equal(result.authorization, "[REDACTED]");
  assert.doesNotMatch(result.detail, /hidden-value/);
  assert.equal(result.nested.app_secret, "[REDACTED]");
});
