import { access, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { AttachmentManager, eventHasResources } from "../src/attachment-manager.mjs";

test("downloads message images into a bridge-owned directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-attachments-"));
  const manager = new AttachmentManager({ root });
  const lark = {
    async downloadMessageResources(_messageId, outputDirectory) {
      const resourceDirectory = path.join(outputDirectory, "lark-im-resources");
      await mkdir(resourceDirectory, { recursive: true });
      await writeFile(path.join(resourceDirectory, "screen.png"), "image");
      return [{ resources: [{ local_path: "lark-im-resources/screen.png", type: "image", size_bytes: 5 }] }];
    }
  };
  try {
    await manager.init();
    const result = await manager.ingest({
      message_id: "om_image",
      message_type: "image",
      content: "![Image](img_v3_key)"
    }, lark);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].kind, "image");
    assert.ok(result.attachments[0].path.startsWith(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects resource-bearing rich messages", () => {
  assert.equal(eventHasResources({ message_type: "text", content: "hello" }), false);
  assert.equal(eventHasResources({ message_type: "post", content: "![x](img_v3_key)" }), true);
});

test("retains expired attachments while a durable queue still references them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-attachments-"));
  const manager = new AttachmentManager({ root, retentionDays: 1 });
  const directory = path.join(root, "om_protected");
  const file = path.join(directory, "lark-im-resources", "report.pdf");
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "report");
    const old = new Date(Date.now() - 2 * 86_400_000);
    await utimes(directory, old, old);
    await manager.cleanup(Date.now(), [file]);
    await access(file);
    await manager.cleanup(Date.now(), []);
    await assert.rejects(access(file), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
