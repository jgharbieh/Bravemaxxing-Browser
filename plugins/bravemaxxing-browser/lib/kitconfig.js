'use strict';
// Shared config loader for the relay and the hook (the Python twin is kitconfig.py: keep them in step).
//
// Defaults: config/default.json (ships with the plugin).
// Your overrides: $BRAVEMAXXING_CONFIG, else ~/.bravemaxxing/config.json. Top-level keys replace
// the default; object keys (ports, wall, containers) merge one level deep, and a list you set REPLACES
// the default list (so you can drop the default Bitwarden entry).
// Env overrides for ports: CDP_QUIET_PORT (relay), CDP_UPSTREAM_PORT (Brave's real CDP port).
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'config', 'default.json');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

const userConfigPath = () => process.env.BRAVEMAXXING_CONFIG || path.join(os.homedir(), '.bravemaxxing', 'config.json');
const stateDir = () => process.env.BRAVEMAXXING_STATE || path.join(os.homedir(), '.bravemaxxing', 'state');

// strict: throw on an unreadable/invalid user file (the relay does, so a typo can never silently drop your wall).
function load({ strict = false } = {}) {
  const cfg = JSON.parse(fs.readFileSync(DEFAULT_FILE, 'utf8'));
  const file = userConfigPath();
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (process.env.BRAVEMAXXING_CONFIG && strict) throw e; }
  if (raw !== null) {
    try {
      const user = JSON.parse(raw);
      for (const [k, v] of Object.entries(user)) cfg[k] = isObj(cfg[k]) && isObj(v) ? { ...cfg[k], ...v } : v;
    } catch (e) {
      if (strict) throw new Error(`invalid config ${file}: ${e.message}`);
    }
  }
  if (process.env.CDP_QUIET_PORT) cfg.ports.relay = Number(process.env.CDP_QUIET_PORT);
  if (process.env.CDP_UPSTREAM_PORT) cfg.ports.upstream = Number(process.env.CDP_UPSTREAM_PORT);
  return cfg;
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

// Layer 2/3 wall (relay) and the attach wall: extension ids (any page of the extension) + domains (and subdomains).
// wall-test.invalid is a built-in sentinel so you can prove the wall works without touching a real site.
function wallRegex(cfg) {
  const w = cfg.wall || {};
  const parts = list(w.extension_ids).map(esc);
  for (const d of list(w.domains)) parts.push(`(?:^|[^a-z0-9-])(?:[a-z0-9-]+\\.)*${esc(d.toLowerCase())}\\b`);
  parts.push('wall-test\\.invalid');
  return new RegExp(parts.join('|'), 'i');
}

// Layer 1 (hook): the same ids plus plain keywords found in a command's text.
function keywordRegex(cfg) {
  const w = cfg.wall || {};
  const parts = [...list(w.extension_ids), ...list(w.keywords)].map(esc);
  parts.push('wall-test\\.invalid');
  return new RegExp(parts.join('|'), 'i');
}

module.exports = { load, wallRegex, keywordRegex, stateDir, userConfigPath };
