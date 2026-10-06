// Purpose: cc-switch rewrites Codex's config.toml every time it starts or switches a provider, putting its own
// base_url (127.0.0.1:15721) back into [model_providers.custom]. That takes Codex past the attachment manager's
// engine. This small daemon watches config.toml and puts the engine's address (127.0.0.1:17891) back.
//
// It only touches base_url lines that point at one of the configured cc-switch sources, and it only acts while the
// attachment manager's managed block is present, so the panel's "disable plugin" still wins. Everything else in
// config.toml is left byte for byte alone.
//
// Run: node corrector.mjs [--config PATH] [--provider custom] [--target-url URL] [--top-target-url URL]
//                         [--source HOST:PORT]... [--interval MS] [--once] [--force] [--quiet]

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MANAGED_BEGIN = "# >>> codex-attachment-manager: managed proxy setting, remove it with the tool >>>";
export const ENGINE_URL = "http://localhost:17891/v1";
export const ENGINE_TOP_URL = "http://localhost:17891/backend-api/codex";
export const CC_SWITCH_SOURCES = ["127.0.0.1:15721", "localhost:15721"];

export function codexHome() {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

export function dataDir() {
  if (process.env.CAM_DATA_DIR?.trim()) return process.env.CAM_DATA_DIR.trim();
  const home = homedir();
  if (process.platform === "win32") return join(home, ".codex-attachment-manager");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "codex-attachment-manager");
  return join(process.env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "codex-attachment-manager");
}

// "127.0.0.1:15721", "http://127.0.0.1:15721/v1" and the same with localhost all name the same source.
export function sourceKey(value) {
  const raw = String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.hostname.replace(/^\[|\]$/g, "").toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}

function eolOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

// A line-based, dependency-free rewrite. Only `openai_base_url` at the top level and `base_url` inside the named
// provider table are candidates; a candidate is replaced only when its current value names a cc-switch source.
export function rewriteConfig(text, options = {}) {
  const provider = options.provider ?? "custom";
  const targetUrl = options.targetUrl ?? ENGINE_URL;
  const topTargetUrl = options.topTargetUrl ?? ENGINE_TOP_URL;
  const sources = new Set((options.sources ?? CC_SWITCH_SOURCES).map(sourceKey).filter(Boolean));
  const requireManaged = options.requireManaged !== false;
  if (requireManaged && !text.includes(MANAGED_BEGIN)) return { text, changed: false, changes: [] };

  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const changes = [];
  let section = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const key = /^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)(["'])(.*?)\4(\s*(?:#.*)?)$/.exec(line);
    if (!key) continue;
    const [, indent, name, equals, , value, tail] = key;
    const isTop = section === null && name === "openai_base_url";
    const isProvider = section === `model_providers.${provider}` && name === "base_url";
    if (!isTop && !isProvider) continue;
    if (!sources.has(sourceKey(value))) continue;
    const next = isTop ? topTargetUrl : targetUrl;
    if (value === next) continue;
    lines[index] = `${indent}${name}${equals}"${next}"${tail}`;
    changes.push({ section: section ?? "(top level)", key: name, from: value, to: next });
  }
  const nextText = lines.join(eol);
  return { text: nextText, changed: nextText !== text, changes };
}

export function configPathOf(options = {}) {
  return options.configPath ?? process.env.CAM_CONFIG_PATH?.trim() ?? join(codexHome(), "config.toml");
}

// Windows refuses rename over an open file; writing in place is the fallback the plugin itself uses.
function replaceFile(file, text) {
  const temporary = `${file}.cam-corrector-tmp`;
  writeFileSync(temporary, text, "utf8");
  try {
    renameSync(temporary, file);
  } catch {
    writeFileSync(file, text, "utf8");
    rmSync(temporary, { force: true });
  }
}

export function logLine(entry) {
  try {
    const root = dataDir();
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, "cc-switch-corrector.log"), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
  } catch {
    // Logging must never take the corrector down.
  }
}

export function correctOnce(options = {}) {
  const file = configPathOf(options);
  if (!existsSync(file)) return { changed: false, reason: "no config.toml", changes: [] };
  const current = readFileSync(file, "utf8");
  const result = rewriteConfig(current, options);
  if (!result.changed) return { ...result, reason: result.changes.length ? "already correct" : "nothing to rewrite" };
  replaceFile(file, result.text);
  return { ...result, reason: "rewritten" };
}

export function runCorrector(options = {}) {
  const file = configPathOf(options);
  const quiet = options.quiet === true;
  const apply = () => {
    try {
      const result = correctOnce(options);
      if (result.changed) {
        logLine({ event: "rewritten", file, changes: result.changes });
        if (!quiet) console.log(JSON.stringify({ event: "rewritten", file, changes: result.changes }));
      }
    } catch (error) {
      logLine({ event: "error", file, error: String(error) });
      if (!quiet) console.error(JSON.stringify({ event: "error", file, error: String(error) }));
    }
  };

  apply();
  if (options.once === true) return () => {};
  let pending = null;
  const schedule = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      apply();
    }, 150);
  };
  // config.toml is usually replaced by rename, so the directory is watched and a polling interval backs it up.
  let watcher = null;
  try {
    watcher = watch(dirname(file), (_event, name) => {
      if (!name || name === "config.toml") schedule();
    });
  } catch {
    // A missing directory is reported by the polling pass.
  }
  const timer = setInterval(schedule, options.intervalMs ?? 1500);
  return () => {
    if (pending) clearTimeout(pending);
    clearInterval(timer);
    watcher?.close();
  };
}

function parseArgs(argv) {
  const options = { sources: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--config") options.configPath = next();
    else if (arg === "--provider") options.provider = next();
    else if (arg === "--target-url") options.targetUrl = next();
    else if (arg === "--top-target-url") options.topTargetUrl = next();
    else if (arg === "--source") options.sources.push(next());
    else if (arg === "--interval") options.intervalMs = Number(next());
    else if (arg === "--once") options.once = true;
    else if (arg === "--force") options.requireManaged = false;
    else if (arg === "--quiet") options.quiet = true;
  }
  if (!options.sources.length) delete options.sources;
  return options;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const options = parseArgs(process.argv.slice(2));
  runCorrector(options);
}
