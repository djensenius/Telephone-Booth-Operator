import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const soundDir = resolve(root, "src/sounds");
mkdirSync(soundDir, { recursive: true });

const assets = [
  ["dial-click.flac", "0.06"],
  ["dial-tone.flac", "0.30"],
  ["ring.flac", "0.24"],
  ["line-busy.flac", "0.20"],
  ["handset-pickup.flac", "0.12"],
];

function commandExists(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

const hasFfmpeg = commandExists("ffmpeg");
const placeholder = Buffer.from("ZkxhQwAAACIAAAACAAAACAAAABAAABAAABAAAPAAAAAAAQAAAA==", "base64");

for (const [fileName, duration] of assets) {
  const output = resolve(soundDir, fileName);
  if (hasFfmpeg) {
    const result = spawnSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", duration, "-c:a", "flac", "-compression_level", "12", output],
      { stdio: "ignore" },
    );
    if (result.status === 0 && existsSync(output)) {
      continue;
    }
  }
  writeFileSync(output, placeholder);
}
