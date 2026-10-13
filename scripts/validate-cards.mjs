import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.mjs";
import { cardSamples } from "./card-samples.mjs";

const run = promisify(execFile);
const live = process.argv.includes("--live");
const config = live
  ? await loadConfig()
  : {
      allowedUserIds: ["ou_example_user"],
      workspaces: { "example-project": process.cwd() },
      defaultWorkspace: "example-project",
      larkBin: "lark-cli"
    };
const userId = config.allowedUserIds[0];
const samples = cardSamples(config);

function validateCardStructure(name, card) {
  if (!card || typeof card !== "object") {
    throw new Error(`${name}: card must be an object`);
  }
  if (card.schema !== "2.0") {
    throw new Error(`${name}: expected Card 2.0 schema`);
  }
  if (!card.header || typeof card.header !== "object") {
    throw new Error(`${name}: missing card header`);
  }
  if (!card.body || !Array.isArray(card.body.elements)) {
    throw new Error(`${name}: missing card body elements`);
  }

  const encoded = JSON.stringify(card);
  const decoded = JSON.parse(encoded);
  if (decoded.schema !== card.schema) {
    throw new Error(`${name}: card is not JSON serializable`);
  }
}

for (const [name, sample] of samples) {
  validateCardStructure(name, sample);
  if (live) {
    await run(config.larkBin, [
      ...(config.larkProfile ? ["--profile", config.larkProfile] : []),
      "im", "+messages-send", "--user-id", userId,
      "--msg-type", "interactive", "--content", JSON.stringify(sample),
      "--as", "bot", "--dry-run"
    ], {
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
      },
      maxBuffer: 2 * 1024 * 1024
    });
  }
  console.log(`validated ${name}`);
}

console.log(`validated ${samples.size} Card 2.0 samples (${live ? "lark-cli dry-run" : "offline"})`);
