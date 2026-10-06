// Purpose: install, remove and inspect the cc-switch corrector on Windows. Installing copies the corrector into the
// attachment manager's data folder, drops a hidden launcher into the user's Startup folder, starts it now, and sets
// CAM_UPSTREAM_URL for the user so Codex's next start hands the engine the cc-switch address.
//
// Run: node setup.mjs install [--upstream URL] [--config PATH] [--no-start]
//      node setup.mjs uninstall [--keep-env]
//      node setup.mjs status [--config PATH]

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CC_SWITCH_SOURCES, ENGINE_URL, MANAGED_BEGIN, configPathOf, correctOnce, dataDir, rewriteConfig, sourceKey } from "./corrector.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TASK_NAME = "cc-switch-corrector";
const DEFAULT_UPSTREAM = "http://127.0.0.1:15721";

const startupDir = () => join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const installedScript = () => join(dataDir(), `${TASK_NAME}.mjs`);
const launcherFile = () => join(startupDir(), `${TASK_NAME}.vbs`);

function parseArgs(argv) {
  const options = { command: argv[0] ?? "status" };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--upstream") options.upstream = next();
    else if (arg === "--config") options.configPath = next();
    else if (arg === "--no-start") options.start = false;
    else if (arg === "--keep-env") options.keepEnv = true;
  }
  return options;
}

function powershell(script) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
}

export function setUserEnv(name, value) {
  const escaped = String(value).replaceAll("'", "''");
  return powershell(`[Environment]::SetEnvironmentVariable('${name}','${escaped}','User')`);
}

export function getUserEnv(name) {
  const result = powershell(`[Environment]::GetEnvironmentVariable('${name}','User')`);
  return result.stdout?.trim() || null;
}

function writeLauncher(configPath, upstream) {
  const script = installedScript();
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(join(HERE, "corrector.mjs"), script);
  mkdirSync(startupDir(), { recursive: true });
  const command = `"${process.execPath}" "${script}" --config "${configPath}" --quiet`;
  const literal = `"${command.replaceAll('"', '""')}"`;
  const vbs = [
    "' Starts the Codex attachment manager's cc-switch corrector without a console window.",
    "Set sh = CreateObject(\"WScript.Shell\")",
    `sh.Run ${literal}, 0, False`,
    "",
  ].join("\r\n");
  writeFileSync(launcherFile(), vbs, "utf8");
  return { script, launcher: launcherFile(), upstream };
}

function startNow() {
  const result = spawnSync("wscript.exe", [launcherFile()], { windowsHide: true, detached: true, stdio: "ignore" });
  return result.status === 0;
}

function stopRunning() {
  const script = installedScript().replaceAll("'", "''");
  const result = powershell(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${script}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
  return result.status === 0;
}

function install(options) {
  if (process.platform !== "win32") throw new Error("this installer is Windows-only; run corrector.mjs directly on other platforms");
  const configPath = resolve(configPathOf(options));
  const upstream = options.upstream ?? getUserEnv("CAM_UPSTREAM_URL") ?? DEFAULT_UPSTREAM;
  const written = writeLauncher(configPath, upstream);
  setUserEnv("CAM_UPSTREAM_URL", upstream);
  process.env.CAM_UPSTREAM_URL = upstream;
  const first = correctOnce({ ...options, configPath });
  const started = options.start === false ? false : startNow();
  return {
    installed: true,
    corrector: written.script,
    launcher: written.launcher,
    upstream,
    firstPass: first.reason,
    started,
    note: "Restart Codex so its plugin server picks up CAM_UPSTREAM_URL and the engine restarts on the new upstream.",
  };
}

function uninstall(options) {
  const stopped = stopRunning();
  const launcher = launcherFile();
  const existed = existsSync(launcher);
  if (existed) rmSync(launcher, { force: true });
  if (existsSync(installedScript())) rmSync(installedScript(), { force: true });
  let envRemoved = false;
  if (!options.keepEnv) {
    setUserEnv("CAM_UPSTREAM_URL", "");
    envRemoved = true;
  }
  return { installed: false, stopped, launcherRemoved: existed, envRemoved };
}

function status(options) {
  const configPath = resolve(configPathOf(options));
  const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const check = rewriteConfig(text, { ...options, requireManaged: false });
  const current = /\[model_providers\.custom\][^\[]*?base_url\s*=\s*["']([^"']+)["']/s.exec(text)?.[1] ?? null;
  const sources = new Set(CC_SWITCH_SOURCES.map(sourceKey));
  return {
    configPath,
    managedBlock: text.includes(MANAGED_BEGIN),
    currentProviderBaseUrl: current,
    pointsAtEngine: current !== null && current.replace(/\/+$/, "") === ENGINE_URL.replace(/\/+$/, ""),
    pointsAtCcSwitch: current !== null && sources.has(sourceKey(current)),
    launcherInstalled: existsSync(launcherFile()),
    correctorInstalled: existsSync(installedScript()),
    userUpstream: getUserEnv("CAM_UPSTREAM_URL"),
    wouldRewriteNow: check.changes.length > 0,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.command === "install" ? install(options)
    : options.command === "uninstall" ? uninstall(options)
    : options.command === "status" ? status(options)
    : (() => { throw new Error(`unknown command: ${options.command}`); })();
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
