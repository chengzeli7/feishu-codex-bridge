import test from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_CODEX_PATHS, isDesktopCodexBin, resolveDesktopCodexBin } from "../src/desktop-runtime.mjs";

test("uses the signed app layout and falls back to the legacy Desktop executable", () => {
  const [current, legacy] = DESKTOP_CODEX_PATHS;
  assert.equal(resolveDesktopCodexBin({ exists: () => true }), current);
  assert.equal(resolveDesktopCodexBin({ exists: (candidate) => candidate === legacy }), legacy);
  assert.equal(resolveDesktopCodexBin({ exists: () => false }), current);
});

test("does not accept arbitrary Codex executables as the Desktop runtime", () => {
  for (const candidate of DESKTOP_CODEX_PATHS) assert.equal(isDesktopCodexBin(candidate), true);
  for (const candidate of [null, "codex", "/tmp/codex", "/tmp/Resources/codex"])
    assert.equal(isDesktopCodexBin(candidate), false);
});
