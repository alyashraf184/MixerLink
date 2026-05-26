const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appRoot = path.join(__dirname, "..");
const exePath = path.join(appRoot, "release", "win-unpacked", "MixerLink.exe");
const iconPath = path.join(appRoot, "build", "icon.ico");

function findRcedit() {
  const roots = [
    path.join(os.homedir(), "AppData", "Local", "electron-builder", "Cache", "winCodeSign"),
    path.join(process.env.LOCALAPPDATA ?? "", "electron-builder", "Cache", "winCodeSign")
  ].filter(Boolean);

  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }

    const candidates = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, "rcedit-x64.exe"))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((first, second) => fs.statSync(second).mtimeMs - fs.statSync(first).mtimeMs);

    if (candidates[0]) {
      return candidates[0];
    }
  }

  throw new Error("rcedit-x64.exe was not found in the Electron Builder cache.");
}

if (!fs.existsSync(exePath)) {
  throw new Error(`MixerLink executable was not found: ${exePath}`);
}

if (!fs.existsSync(iconPath)) {
  throw new Error(`MixerLink icon was not found: ${iconPath}`);
}

const rceditPath = findRcedit();
execFileSync(rceditPath, [exePath, "--set-icon", iconPath], { stdio: "inherit" });
console.log(`Applied MixerLink icon with ${rceditPath}`);
