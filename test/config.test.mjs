import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";

test("loads and resolves a valid single-user configuration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
  const file = path.join(directory, "config.json");
  await writeFile(file, JSON.stringify({ allowedUserIds: ["ou_test"], allowedChatIds: ["oc_test"], workspaces: { app: "/tmp/app" }, defaultWorkspace: "app" }));
  try {
    const config = await loadConfig(file);
    assert.equal(config.requireP2P, true);
    assert.equal(config.desktopSyncEnabled, false);
    assert.equal(config.desktopAutoOpenEnabled, false);
    assert.equal(config.codexAppServerSocket, null);
    assert.equal(config.stateFile, path.join(directory, "data/state.json"));
    assert.equal(config.workspaces.app, "/tmp/app");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires an absolute shared app-server socket path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
  const file = path.join(directory, "config.json");
  try {
    await writeFile(file, JSON.stringify({
      allowedUserIds: ["ou_test"],
      workspaces: { app: "/tmp/app" },
      codexAppServerSocket: "relative.sock"
    }));
    await assert.rejects(loadConfig(file), /codexAppServerSocket/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires the Desktop Codex runtime when Desktop sync is enabled", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
  const file = path.join(directory, "config.json");
  try {
    await writeFile(file, JSON.stringify({
      allowedUserIds: ["ou_test"],
      workspaces: { app: "/tmp/app" },
      codexBin: "/tmp/legacy-codex",
      desktopSyncEnabled: true
    }));
    if (process.platform === "darwin") await assert.rejects(loadConfig(file), /Codex Desktop runtime/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a non-boolean Desktop auto-open setting", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
  const file = path.join(directory, "config.json");
  try {
    await writeFile(file, JSON.stringify({
      allowedUserIds: ["ou_test"],
      workspaces: { app: "/tmp/app" },
      desktopAutoOpenEnabled: "yes"
    }));
    await assert.rejects(loadConfig(file), /desktopAutoOpenEnabled/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects missing users and non-absolute workspaces", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
  const file = path.join(directory, "config.json");
  try {
    await writeFile(file, JSON.stringify({ allowedUserIds: [], workspaces: { app: "/tmp/app" } }));
    await assert.rejects(loadConfig(file), /allowedUserIds/);
    await writeFile(file, JSON.stringify({ allowedUserIds: ["ou_one", "ou_two"], workspaces: { app: "/tmp/app" } }));
    await assert.rejects(loadConfig(file), /exactly one/);
    await writeFile(file, JSON.stringify({ allowedUserIds: ["ou_test"], workspaces: {} }));
    await assert.rejects(loadConfig(file), /at least one allowed project/);
    await writeFile(file, JSON.stringify({ allowedUserIds: ["ou_test"], workspaces: { app: "relative" }, defaultWorkspace: "app" }));
    await assert.rejects(loadConfig(file), /absolute path/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
