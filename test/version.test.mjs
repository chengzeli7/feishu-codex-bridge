import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/version.mjs";

test("uses package metadata as the single public version source", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, packageJson.version);
});
