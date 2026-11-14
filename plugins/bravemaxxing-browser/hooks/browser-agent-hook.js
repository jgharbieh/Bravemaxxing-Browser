'use strict';
// Claude Code hook for agent browser work in your Brave.
//
//   pre  (PreToolUse,  Bash|PowerShell): wall layer 1 + tab status "working"
//   post (PostToolUse, Bash|PowerShell): tab status "done" (and "adopt" after `tab new`)
//   stop (Stop):                         tab status "turn-end"
//   session-start (SessionStart):        names this agent to the relay (see below)
//
// session-start: appends `export AGENT_BROWSER_CDP_HEADERS='{"X-Agent":"<agent>"}'` to $CLAUDE_ENV_FILE, which Claude Code
// runs before every Bash command of the session. agent-browser sends that header to the relay, which then shows the
// session only its own agent's tabs. Skipped when the variable is already set (your own value wins), when the agent name
// is not relay-safe, or when CLAUDE_ENV_FILE is missing (Claude Code does not provide it to hooks run in PowerShell).
// The agent name is BRAVEMAXXING_AGENT, else config default_agent (default "claude"); status posts use the same name.
//
// Layer 1 is a tripwire on the command text: a browser command (agent-browser / agent-tab in command position, or the relay port)
// that names a walled extension id or keyword (config: wall.extension_ids, wall.keywords) is denied, and so
// is any agent-browser command aimed at Brave's raw CDP port (it bypasses the focus rule and the relay's wall).
// Layers 2-3 live in the relay (relay/cdp-quiet.js).
//
// Status goes to the relay's /_agent/status (same as scripts/tab-status.py) with a 0.12 s timeout.
// Never blocks or fails a tool call except for the denies above. A tripwire for cooperating agents, not a
// security boundary: it only reads the command text.
const http = require('http');
const kit = require('../lib/kitconfig');

let AGENT = 'claude'; // set from env/config in main()
const AGENT_RE = /^[a-z0-9_-]{1,32}$/i; // the relay's rule for agent names

function postStatus(port, cmd) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ cmd, agent: AGENT });
    const req = http.request({ host: '127.0.0.1', port, path: '/_agent/status', method: 'POST', timeout: 120,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.on('error', () => resolve());
    req.end(body);
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let b = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { b += c; });
    process.stdin.on('end', () => resolve(b));
    process.stdin.on('error', () => resolve(b));
    if (process.stdin.isTTY) resolve('');
  });
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

function sessionStart() {
  const file = process.env.CLAUDE_ENV_FILE;
  if (!file || process.env.AGENT_BROWSER_CDP_HEADERS || !AGENT_RE.test(AGENT)) return;
  const line = `export AGENT_BROWSER_CDP_HEADERS='${JSON.stringify({ 'X-Agent': AGENT })}'
`;
  try {
    let have = ''; try { have = require('fs').readFileSync(file, 'utf8'); } catch {}
    if (!have.includes(line)) require('fs').appendFileSync(file, line); // append: other hooks write here too
  } catch {}
}

async function main() {
  const mode = process.argv[2] || '';
  let payload = {};
  try { payload = JSON.parse((await readStdin()) || '{}'); } catch {}
  const cfg = kit.load();
  const { relay, upstream } = cfg.ports;
  AGENT = process.env.BRAVEMAXXING_AGENT || cfg.default_agent || 'claude';
  if (mode === 'session-start') return sessionStart();
  if (mode === 'stop') return postStatus(relay, 'turn-end');

  const command = String(((payload || {}).tool_input || {}).command || '');
  // Commands that DRIVE the browser: the tool name in command position (start, or after ; & | ( or a newline),
  // or a call to the relay port. Heredocs and edits that merely mention these names in text do not count.
  const browserCmd = new RegExp(`(?:^|[;&|(\\n]\\s*)(?:agent-browser|agent-tab)\\b|(?:127\\.0\\.0\\.1|localhost):${relay}/(?!_agent/)`, 'i');
  if (!browserCmd.test(command)) return;

  if (mode === 'pre') {
    if (kit.keywordRegex(cfg).test(command)) {
      return deny('Agent wall: this browser command names an extension or site on your bravemaxxing-browser wall list '
        + '(wall.extension_ids / wall.keywords). Agents may not open or use it. A human signs in; agents reuse the session.');
    }
    const rawCdp = new RegExp(`agent-browser[^\\n|;&]*--cdp[ =]+${upstream}\\b`, 'i');
    if (rawCdp.test(command)) {
      return deny(`Agent wall: drive Brave through the relay (agent-browser default / --cdp ${relay}), never raw ${upstream}.`);
    }
    return postStatus(relay, 'working');
  }
  if (mode === 'post') {
    if (/\btab\s+new\b/.test(command)) await postStatus(relay, 'adopt'); // relay registered the new tab as unowned; make it this agent's
    return postStatus(relay, 'done');
  }
}

main().catch(() => {}).finally(() => { process.exitCode = 0; });
