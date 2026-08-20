import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

export class InstanceLock {
  constructor(filePath) {
    this.filePath = filePath;
    this.held = false;
  }

  async acquire() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.filePath, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`);
        await handle.close();
        this.held = true;
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const pid = Number((await readFile(this.filePath, "utf8").catch(() => "0")).trim());
        if (pid > 0 && processExists(pid)) {
          throw new Error(`Codex 飞书助手已经在运行（PID ${pid}）`);
        }
        await unlink(this.filePath).catch((unlinkError) => {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        });
      }
    }
    throw new Error("无法获取服务单实例锁");
  }

  async release() {
    if (!this.held) return;
    this.held = false;
    await unlink(this.filePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
