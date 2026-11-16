'use strict';
// Smoke test. Safe by construction: spare ports (never your real Brave port), temp state dir, temp config,
// and a tiny fake CDP upstream (it records what the relay forwards). Run:  node tests/smoke.js
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'bravemaxxing-browser');
const RELAY_PORT = 19333, FAKE_UPSTREAM = 19222;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-smoke-'));
const state = path.join(tmp, 'state');
const EMPTY_CFG = path.join(tmp, 'empty.json');
fs.writeFileSync(EMPTY_CFG, '{}');
const env = { ...process.env, AGENT_BROWSER_CDP_HEADERS: '', BRAVEMAXXING_AGENT: '', CDP_QUIET_PORT: String(RELAY_PORT), CDP_UPSTREAM_PORT: String(FAKE_UPSTREAM),
  BRAVEMAXXING_STATE: state, BRAVEMAXXING_CONFIG: EMPTY_CFG, BRAVE_PATH: path.join(os.tmpdir(), 'no-such-browser') }; // a test must never launch a real Brave
const py = ['python', 'python3'].find((c) => spawnSync(c, ['-c', 'import sys; sys.exit(sys.version_info[0] != 3)']).status === 0);

let passed = 0;
const ok = (name, fn) => Promise.race([Promise.resolve().then(fn), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 8 s')), 8000))]).then(() => { passed++; console.log('  ok  ' + name); },
  (e) => { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; });

// Async spawn: the fake CDP upstream lives in THIS process, so anything that must reach the relay's upstream cannot use spawnSync.
const run = (cmd, args, opts = {}) => new Promise((res) => {
  const c = spawn(cmd, args, { encoding: 'utf8', ...opts }); let stdout = '', stderr = '';
  c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
  c.on('close', (status) => res({ status, stdout, stderr }));
});
const hook = (mode, command, extraEnv = {}) => {
  const r = spawnSync('node', [path.join(PLUGIN, 'hooks', 'browser-agent-hook.js'), mode],
    { input: JSON.stringify({ tool_input: { command } }), env: { ...env, ...extraEnv }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'hook must always exit 0');
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};
const post = (body) => new Promise((res, rej) => {
  const b = JSON.stringify(body);
  const rq = http.request({ host: '127.0.0.1', port: RELAY_PORT, path: '/_agent/status', method: 'POST', headers: { 'content-type': 'application/json' } },
    (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); });
  rq.on('error', rej); rq.end(b);
});
const get = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: RELAY_PORT, path: p }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID = 'A'.repeat(32), ID2 = 'B'.repeat(32);

(async () => {
  const kit = require(path.join(PLUGIN, 'lib', 'kitconfig.js'));
  await ok('config: default wall regex hits id + vault domains, ignores look-alikes', () => {
    const re = kit.wallRegex(kit.load());
    for (const s of ['chrome-extension://nngceckbapebfimnlniiiahkandclblb/popup.html', 'https://vault.bitwarden.com/#/vault', 'https://bitwarden.eu', 'wall-test.invalid']) assert(re.test(s), s);
    for (const s of ['https://notbitwarden.com', 'https://bitwarden.community', 'https://example.com/bitwarden-article']) assert(!re.test(s), s);
  });
  await ok('config: user lists REPLACE defaults; invalid user file throws in strict mode', () => {
    const f = path.join(tmp, 'c.json');
    fs.writeFileSync(f, JSON.stringify({ wall: { extension_ids: [], domains: ['vault.example.org'], keywords: ['acme'] }, ports: { relay: 1234 } }));
    process.env.BRAVEMAXXING_CONFIG = f;
    const c = kit.load();
    assert.deepStrictEqual(c.wall.extension_ids, []); assert.strictEqual(c.ports.upstream, 9222); assert.strictEqual(c.ports.relay, 1234);
    const re = kit.wallRegex(c);
    assert(re.test('https://x.vault.example.org') && !re.test('https://vault.bitwarden.com'));
    fs.writeFileSync(f, '{ not json');
    assert.throws(() => kit.load({ strict: true }), /invalid config/);
    process.env.BRAVEMAXXING_CONFIG = EMPTY_CFG;
  });

  await ok('hook pre: denies a walled browser command', () => {
    const d = hook('pre', 'agent-browser open https://vault.bitwarden.com');
    assert.strictEqual(d.permissionDecision, 'deny');
  });
  await ok('hook pre: the documented acceptance command is denied (wall-test.invalid sentinel)', () => {
    assert.strictEqual(hook('pre', 'agent-browser --version wall-test.invalid').permissionDecision, 'deny');
  });
  await ok('hook pre: denies raw CDP port use', () => {
    const d = hook('pre', `agent-browser --cdp ${FAKE_UPSTREAM} snapshot`);
    assert.strictEqual(d.permissionDecision, 'deny');
  });
  await ok('hook pre: allows normal browser command and non-browser commands', () => {
    assert.strictEqual(hook('pre', 'agent-browser snapshot -i'), null);
    assert.strictEqual(hook('pre', 'echo bitwarden notes'), null);
    assert.strictEqual(hook('pre', 'sed -i s/x/y/ cdp-quiet.js # bitwarden'), null);
    assert.strictEqual(hook('pre', 'cat <<EOF\nnotes: see https://vault.bitwarden.com in agent-browser\nEOF'), null, 'text inside a heredoc is not a browser command');
    assert.strictEqual(hook('pre', 'cd /tmp && agent-browser open https://vault.bitwarden.com').permissionDecision, 'deny', 'command position after &&');
  });
  await ok('hook pre: custom keyword from user config', () => {
    const f = path.join(tmp, 'kw.json'); fs.writeFileSync(f, JSON.stringify({ wall: { keywords: ['acme-vault'] } }));
    assert.strictEqual(hook('pre', 'agent-browser open https://acme-vault.test', { BRAVEMAXXING_CONFIG: f }).permissionDecision, 'deny');
  });
  // SessionStart: the agent label goes into CLAUDE_ENV_FILE, which Claude Code runs (in bash) before each Bash command.
  const sessionStart = (extraEnv = {}) => {
    const envFile = path.join(tmp, `session-env-${Math.random().toString(36).slice(2)}.sh`);
    const e = { ...env, ...extraEnv }; delete e.AGENT_BROWSER_CDP_HEADERS; delete e.BRAVEMAXXING_AGENT;
    Object.assign(e, extraEnv); if (extraEnv.CLAUDE_ENV_FILE !== null) e.CLAUDE_ENV_FILE = envFile; else delete e.CLAUDE_ENV_FILE;
    const r = spawnSync('node', [path.join(PLUGIN, 'hooks', 'browser-agent-hook.js'), 'session-start'], { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }), env: e, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, 'hook must always exit 0'); assert.strictEqual(r.stdout, '', 'SessionStart hook must print nothing');
    return { envFile, text: fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : null };
  };
  const bashValue = (file) => { // what a Bash command sees after Claude Code sources the env file
    const r = spawnSync('bash', ['-c', `source "${file.split(path.sep).join('/')}"; printf %s "$AGENT_BROWSER_CDP_HEADERS"`], { encoding: 'utf8' });
    return r.stdout;
  };
  await ok('hook session-start: writes the agent label; a Bash command sees exact JSON {"X-Agent":"claude"}', () => {
    const { envFile, text } = sessionStart();
    assert.strictEqual(text, `export AGENT_BROWSER_CDP_HEADERS='{"X-Agent":"claude"}'\n`);
    assert.deepStrictEqual(JSON.parse(bashValue(envFile)), { 'X-Agent': 'claude' });
  });
  await ok('hook session-start: appends (keeps other hooks\' lines), never duplicates', () => {
    const f = path.join(tmp, 'shared-env.sh'); fs.writeFileSync(f, "export OTHER=1\n");
    const run = () => spawnSync('node', [path.join(PLUGIN, 'hooks', 'browser-agent-hook.js'), 'session-start'], { input: '{}', env: { ...env, AGENT_BROWSER_CDP_HEADERS: '', CLAUDE_ENV_FILE: f }, encoding: 'utf8' });
    run(); run();
    const t = fs.readFileSync(f, 'utf8');
    assert(t.startsWith('export OTHER=1\n')); assert.strictEqual(t.split('X-Agent').length - 1, 1, t);
  });
  await ok('hook session-start: agent from BRAVEMAXXING_AGENT, else config default_agent', () => {
    assert.match(sessionStart({ BRAVEMAXXING_AGENT: 'hermes' }).text, /"X-Agent":"hermes"/);
    const f = path.join(tmp, 'agent.json'); fs.writeFileSync(f, JSON.stringify({ default_agent: 'research_bot' }));
    assert.match(sessionStart({ BRAVEMAXXING_CONFIG: f }).text, /"X-Agent":"research_bot"/);
  });
  await ok('hook session-start: leaves your own AGENT_BROWSER_CDP_HEADERS alone; skips unsafe names; no CLAUDE_ENV_FILE is fine', () => {
    const mine = sessionStart({ AGENT_BROWSER_CDP_HEADERS: '{"X-Agent":"mine"}' }); assert.strictEqual(mine.text, null);
    assert.strictEqual(sessionStart({ BRAVEMAXXING_AGENT: "x';touch /tmp/pwned;'" }).text, null, 'quote injection must be refused');
    assert.strictEqual(sessionStart({ BRAVEMAXXING_AGENT: 'a'.repeat(33) }).text, null);
    assert.strictEqual(sessionStart({ CLAUDE_ENV_FILE: null }).text, null);
  });
  await ok('hooks.json: SessionStart is wired in shell form, quoted, to the hook script', () => {
    const h = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks;
    assert.deepStrictEqual(Object.keys(h), ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']);
    assert.strictEqual(h.SessionStart[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/browser-agent-hook.js" session-start');
  });
  await ok('hook: exits 0 and prints nothing with the relay down (stop/post)', () => {
    assert.strictEqual(hook('stop', ''), null); assert.strictEqual(hook('post', 'agent-browser tab new https://example.com'), null);
  });

  const WebSocketLib = require(path.join(PLUGIN, 'node_modules', 'ws'));
  const seen = []; // every command the relay forwarded upstream
  const MINE = 'C'.repeat(32); // a "user" tab the agent must never see
  const upHttp = http.createServer((req, res) => res.end(req.url === '/json/version'
    ? JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${FAKE_UPSTREAM}/devtools/browser/fake` }) : (req.url === '/json/list' ? JSON.stringify([{ id: ID, type: 'page', url: 'https://example.com', title: 't' }]) : '[]')));
  const upWss = new WebSocketLib.Server({ server: upHttp });
  upWss.on('connection', (sock) => sock.on('message', (d) => {
    const m = JSON.parse(d.toString()); seen.push(m);
    sock.send(JSON.stringify({ id: m.id, result: m.method === 'Target.getTargets'
      ? { targetInfos: [{ targetId: ID, type: 'page', url: 'https://example.com' }, { targetId: MINE, type: 'page', url: 'https://mine.example' }] } : {} }));
  }));
  await new Promise((r) => upHttp.listen(FAKE_UPSTREAM, '127.0.0.1', r));

  const relay = spawn('node', [path.join(PLUGIN, 'relay', 'cdp-quiet.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let relayOut = ''; relay.stdout.on('data', (d) => (relayOut += d)); relay.stderr.on('data', (d) => (relayOut += d));
  for (let i = 0; i < 50 && !/cdp-quiet/.test(relayOut); i++) await sleep(100);
  try {
    await ok('relay: starts on the configured spare ports', () => assert(relayOut.includes(`cdp-quiet ${RELAY_PORT} -> ${FAKE_UPSTREAM}`), relayOut));
    await ok('relay: status lifecycle claim -> working -> done -> turn-end', async () => {
      assert.strictEqual((await post({ cmd: 'claim', agent: 'claude', tab: ID })).ok, true);
      assert.strictEqual((await post({ cmd: 'working', agent: 'claude', tab: ID })).ok, true);
      assert.strictEqual((await get('/_agent/registry')).tabs[ID].status, 'working');
      await post({ cmd: 'done', agent: 'claude' });
      assert.strictEqual((await get('/_agent/registry')).tabs[ID].status, 'done');
      await post({ cmd: 'turn-end', agent: 'claude' });
      assert.strictEqual((await get('/_agent/registry')).tabs[ID].status, 'paused');
    });
    await ok('relay: another agent cannot claim an owned tab; bad ids and unknown cmds rejected', async () => {
      assert.match((await post({ cmd: 'claim', agent: 'hermes', tab: ID })).error, /owned by claude/);
      assert.match((await post({ cmd: 'claim', agent: 'claude', tab: 'nope' })).error, /32-hex/);
      assert.match((await post({ cmd: 'bogus', agent: 'claude' })).error, /unknown cmd/);
    });
    await ok('relay: wall refuses open-url to a walled site', async () => {
      assert.strictEqual((await post({ cmd: 'open', agent: 'claude', tab: ID, url: 'https://vault.bitwarden.com' })).error, 'url not allowed');
      assert.strictEqual((await post({ cmd: 'open', agent: 'claude', tab: ID, url: 'https://wall-test.invalid' })).error, 'url not allowed');
    });
    await ok('relay: attach wall (default deny) over CDP websocket', async () => {
      const WebSocket = require(path.join(PLUGIN, 'node_modules', 'ws'));
      const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/devtools/browser/x`);
      const reply = await new Promise((res, rej) => {
        ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Target.attachToTarget', params: { targetId: ID2, flatten: true } })));
        ws.on('message', (m) => res(JSON.parse(m.toString()))); ws.on('error', rej);
      });
      ws.close();
      assert.match(reply.error.message, /agent wall: not an agent tab/);
      const ws2 = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/devtools/page/${ID2}`);
      const code = await new Promise((res) => { ws2.on('close', (c) => res(c)); ws2.on('error', () => res('error')); });
      assert.strictEqual(code, 1008);
    });
    await ok('relay: walled navigate / eval refused; focus commands never reach the browser; tabs forced to background', async () => {
      const ws = new WebSocketLib(`ws://127.0.0.1:${RELAY_PORT}/devtools/browser/x`);
      const send = (msg) => new Promise((res) => { const h = (m) => { const j = JSON.parse(m.toString()); if (j.id === msg.id) { ws.off('message', h); res(j); } }; ws.on('message', h); ws.send(JSON.stringify(msg)); });
      await new Promise((r) => ws.on('open', r));
      const before = seen.length;
      assert.match((await send({ id: 1, method: 'Page.navigate', params: { url: 'https://vault.bitwarden.com' } })).error.message, /blocked by agent wall/);
      assert.match((await send({ id: 2, method: 'Runtime.evaluate', params: { expression: "location='chrome-extension://nngceckbapebfimnlniiiahkandclblb/'" } })).error.message, /blocked by agent wall/);
      assert.deepStrictEqual((await send({ id: 3, method: 'Target.activateTarget', params: { targetId: ID } })).result, {});
      await send({ id: 4, method: 'Page.bringToFront', params: {} });
      await send({ id: 5, method: 'Target.createTarget', params: { url: 'https://example.com', newWindow: true } });
      const targets = (await send({ id: 6, method: 'Target.getTargets' })).result.targetInfos.map((t) => t.targetId);
      ws.close();
      const fwd = seen.slice(before);
      for (const m of ['Page.navigate', 'Runtime.evaluate', 'Target.activateTarget', 'Page.bringToFront']) assert(!fwd.some((x) => x.method === m), `${m} must not be forwarded`);
      assert(fwd.some((x) => x.method === 'Page.setWebLifecycleState' && x.params.state === 'active'), 'bringToFront becomes a lifecycle wake');
      const ct = fwd.find((x) => x.method === 'Target.createTarget');
      assert(ct && ct.params.background === true && !('newWindow' in ct.params), 'createTarget forced to background, no new window');
      assert(targets.includes(ID) && !targets.includes(MINE), 'user tabs are hidden from Target.getTargets: ' + targets);
    });
    await ok('relay: browser Origin and foreign Host are refused (http and websocket)', async () => {
      const statusOf = (headers) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: RELAY_PORT, path: '/_agent/registry', headers }, (r) => { r.resume(); res(r.statusCode); }).on('error', rej));
      assert.strictEqual(await statusOf({}), 200);
      assert.strictEqual(await statusOf({ origin: 'https://evil.example' }), 403);
      assert.strictEqual(await statusOf({ host: 'evil.example' }), 403);
      const wsFail = new WebSocketLib(`ws://127.0.0.1:${RELAY_PORT}/devtools/browser/x`, { headers: { origin: 'https://evil.example' } });
      const outcome = await new Promise((res) => { wsFail.on('open', () => res('open')); wsFail.on('error', () => res('refused')); wsFail.on('close', () => res('refused')); });
      assert.strictEqual(outcome, 'refused');
    });
    await ok("relay: a connection that names its agent sees only that agent's tabs", async () => {
      const targetsFor = async (urlPath) => {
        const ws = new WebSocketLib(`ws://127.0.0.1:${RELAY_PORT}${urlPath}`);
        await new Promise((r) => ws.on('open', r));
        const reply = await new Promise((res) => { ws.on('message', (m) => res(JSON.parse(m.toString()))); ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' })); });
        ws.close();
        return reply.result.targetInfos.map((t) => t.targetId);
      };
      assert(!(await targetsFor('/agent/hermes')).includes(ID), "hermes must not see claude's tab");
      assert((await targetsFor('/agent/claude')).includes(ID), 'claude sees its own tab');
    });
    await ok('relay: the X-Agent header (what the session label sends) names the connection like /agent/<name>', async () => {
      const targetsFor = async (headers) => {
        const ws = new WebSocketLib(`ws://127.0.0.1:${RELAY_PORT}/devtools/browser/x`, { headers });
        await new Promise((r) => ws.on('open', r));
        const reply = await new Promise((res) => { ws.on('message', (m) => res(JSON.parse(m.toString()))); ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' })); });
        ws.close(); return reply.result.targetInfos.map((t) => t.targetId);
      };
      assert(!(await targetsFor({ 'X-Agent': 'hermes' })).includes(ID));
      assert((await targetsFor({ 'X-Agent': 'claude' })).includes(ID));
    });
    await ok('tab-status.py: show / working / claim through the python CLI', () => {
      const run = (...a) => spawnSync(py, ['-I', path.join(PLUGIN, 'scripts', 'tab-status.py'), ...a], { env, encoding: 'utf8' });
      const show = run('show'); assert.strictEqual(show.status, 0); assert(JSON.parse(show.stdout).tabs[ID]);
      assert.match(run('claim', '--agent', 'hermes', '--tab', ID2, '-v').stdout, /"ok":true/);
      assert.strictEqual(JSON.parse(run('show').stdout).tabs[ID2].agent, 'hermes');
      const down = spawnSync(py, ['-I', path.join(PLUGIN, 'scripts', 'tab-status.py'), 'working'], { env: { ...env, CDP_QUIET_PORT: '19999' }, encoding: 'utf8' });
      assert.strictEqual(down.status, 0, 'relay down must still exit 0');
    });
    await ok('state: registry + wall.log live in the state dir, never in the plugin dir', async () => {
      await sleep(400);
      assert(fs.existsSync(path.join(state, 'registry.json')));
      assert(fs.existsSync(path.join(state, 'wall.log')));
      for (const f of ['registry.json', 'wall.log']) assert(!fs.existsSync(path.join(PLUGIN, 'relay', f)));
    });
    await ok('agent-tab.py: refuses a walled URL (exit 3) and reports relay down (exit 2)', () => {
      const run = (url, e) => spawnSync(py, ['-I', path.join(PLUGIN, 'scripts', 'agent-tab.py'), url], { env: e, encoding: 'utf8' });
      assert.strictEqual(run('https://vault.bitwarden.com', env).status, 3);
      assert.strictEqual(run('https://example.com', { ...env, CDP_QUIET_PORT: '19999' }).status, 2);
    });
    await ok('agent-tab.py fails closed: live tabs of the agent but none in the container -> exit 5, never launches', async () => {
      const r = await run(py, ['-I', path.join(PLUGIN, 'scripts', 'agent-tab.py'), 'https://example.com', '--agent', 'claude'], { env });
      assert.strictEqual(r.status, 5, r.stderr);
      assert.match(r.stderr, /Not launching while unsure/);
    });
    await ok('relay: raw HTTP tab endpoints cannot raise, open or close your tabs', async () => {
      const status = (p, method = 'GET') => new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port: RELAY_PORT, path: p, method }, (x) => { x.resume(); x.on('end', () => res(x.statusCode)); }); r.on('error', rej); r.end(); });
      assert.strictEqual(await status('/json/activate/' + ID), 403, 'activate takes focus, even on an agent tab');
      assert.strictEqual(await status('/json/activate/' + MINE), 403);
      assert.strictEqual(await status('/json/new?https://example.com', 'PUT'), 403);
      assert.strictEqual(await status('/json/close/' + MINE), 403, "a user's tab must not be closable");
      assert.strictEqual(await status('/json/close/' + ID), 200, 'an agent tab may be closed');
      assert.strictEqual(await status('/json/list'), 200);
    });
    await ok('relay: a command that names a tab which is not an agent tab never reaches the browser', async () => {
      const ask = async (urlPath, msg) => {
        const ws = new WebSocketLib(`ws://127.0.0.1:${RELAY_PORT}${urlPath}`);
        await new Promise((r) => ws.on('open', r));
        const reply = await new Promise((res) => { ws.on('message', (m) => { const j = JSON.parse(m.toString()); if (j.id === msg.id) res(j); }); ws.send(JSON.stringify(msg)); });
        ws.close(); return reply;
      };
      const before = seen.length;
      assert.match((await ask('/agent/claude', { id: 1, method: 'Target.closeTarget', params: { targetId: MINE } })).error.message, /not an agent tab/, "a user's tab");
      assert.match((await ask('/devtools/browser/x', { id: 2, method: 'Target.getTargetInfo', params: { targetId: MINE } })).error.message, /not an agent tab/, 'unnamed connection too');
      assert.match((await ask('/agent/hermes', { id: 3, method: 'Target.closeTarget', params: { targetId: ID } })).error.message, /not an agent tab/, "another agent's tab");
      assert(!seen.slice(before).some((x) => x.method === 'Target.closeTarget' || x.method === 'Target.getTargetInfo'), 'nothing was forwarded');
      assert((await ask('/agent/claude', { id: 4, method: 'Target.getTargetInfo', params: { targetId: ID } })).result, 'its own tab still works');
    });
    await ok('relay: tab-group extension endpoint: its Origin only; drag in = hand over, drag out = take back; long-poll wakes on change', async () => {
      const EXT = 'chrome-extension://' + JSON.parse(fs.readFileSync(path.join(PLUGIN, 'config', 'default.json'), 'utf8')).groups.extension_ids[0];
      const call = (p, { headers = {}, body } = {}) => new Promise((res, rej) => {
        const r = http.request({ host: '127.0.0.1', port: RELAY_PORT, path: p, method: body ? 'POST' : 'GET', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } },
          (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} res({ status: x.statusCode, json: j, cors: x.headers['access-control-allow-origin'] }); }); });
        r.on('error', rej); r.end(body ? JSON.stringify(body) : undefined);
      });
      const ext = { headers: { origin: EXT } };
      const st = await call('/_ext/state', ext);
      assert.strictEqual(st.status, 200); assert.strictEqual(st.cors, EXT); assert(st.json.rev > 0 && st.json.tabs[ID], 'state lists agent tabs');
      assert.strictEqual(st.json.colors.hermes, 'purple');
      assert.strictEqual((await call('/_ext/state', { headers: { origin: 'chrome-extension://' + 'a'.repeat(32) } })).status, 403, 'another extension');
      assert.strictEqual((await call('/_ext/state', { headers: { origin: 'https://evil.example' } })).status, 403);
      assert.strictEqual((await call('/_agent/registry', ext)).status, 403, 'the extension Origin opens /_ext/ only');
      const X = 'D'.repeat(32);
      assert.deepStrictEqual((await call('/_ext/event', { ...ext, body: { type: 'joined', tab: X, agent: 'hermes' } })).json, { ok: true });
      const mid = (await get('/_agent/registry')).tabs[X];
      assert(mid && mid.agent === 'hermes' && mid.space === 'takeover', 'dragged-in tab belongs to the agent');
      assert.strictEqual((await call('/_ext/event', { ...ext, body: { type: 'joined', tab: ID, agent: 'hermes' } })).json.ok, false, "cannot hand over another agent's tab");
      const rev = (await call('/_ext/state', ext)).json.rev;
      const started = Date.now();
      const waiting = call(`/_ext/state?wait=1&rev=${rev}`, ext);
      await sleep(300);
      assert.deepStrictEqual((await call('/_ext/event', { ...ext, body: { type: 'left', tab: X, agent: 'hermes' } })).json, { ok: true });
      const woke = await waiting;
      assert(woke.json.rev > rev && !woke.json.tabs[X] && Date.now() - started < 5000, 'long-poll answered as soon as the registry changed');
      assert(!(await get('/_agent/registry')).tabs[X], 'dragged-out tab is yours again');
      assert.strictEqual(spawnSync(py, ['-I', path.join(PLUGIN, 'scripts', 'tab-status.py'), 'release', '--agent', 'claude', '--tab', X, '-v'], { env, encoding: 'utf8' }).status, 0);
    });
    await ok('agent-tab.py: Brave is found on Linux without BRAVE_PATH (launcher on PATH)', () => {
      if (process.platform !== 'linux') return;
      const bin = path.join(tmp, 'fakebin'); fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'brave-browser'), '#!/bin/sh\n', { mode: 0o755 });
      const code = `import sys; sys.path.insert(0, "${path.join(PLUGIN, 'lib').split(path.sep).join('/')}"); import kitconfig; print(kitconfig.brave_binary(kitconfig.load()))`;
      const e = { ...env, BRAVE_PATH: '', PATH: bin + path.delimiter + process.env.PATH };
      assert.strictEqual(spawnSync(py, ['-I', '-c', code], { env: e, encoding: 'utf8' }).stdout.trim(), path.join(bin, 'brave-browser'));
    });
    await ok('agent-tab.py: an explicit BRAVE_PATH that does not exist is never second-guessed (no autodetect)', () => {
      const code = `import sys; sys.path.insert(0, "${path.join(PLUGIN, 'lib').split(path.sep).join('/')}"); import kitconfig; print(kitconfig.brave_binary(kitconfig.load()))`;
      assert.strictEqual(spawnSync(py, ['-I', '-c', code], { env, encoding: 'utf8' }).stdout.trim(), 'None');
    });
  } finally { relay.kill(); upWss.close(); upHttp.close(); }

  await ok('hermes plugin: wall + raw-port tripwires and inert without BRAVEMAXXING_HOME', () => {
    const code = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("bah", r"${path.join(PLUGIN, 'extras', 'hermes', 'bravemaxxing-hooks', '__init__.py').replace(/\\/g, '\\\\')}")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
pre = m._pre_tool_call
assert pre("terminal", {"command": "agent-browser open https://vault.bitwarden.com"})["action"] == "block"
assert pre("terminal", {"command": "agent-browser --cdp ${FAKE_UPSTREAM} snapshot"})["action"] == "block"
assert pre("terminal", {"command": f"curl -s http://127.0.0.1:${FAKE_UPSTREAM}/json/version"}) is None
assert pre("terminal", {"command": "agent-browser snapshot"}) is None
class Ctx:
    n = []
    def register_hook(self, name, fn): self.n.append(name)
c = Ctx(); m.register(c); assert c.n == ["pre_tool_call", "post_tool_call", "post_llm_call"]
print("ok")`;
    const r = spawnSync(py, ['-c', code], { env: { ...env, BRAVEMAXXING_HOME: PLUGIN }, encoding: 'utf8' });
    assert.strictEqual(r.stdout.trim(), 'ok', r.stderr);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  fs.rmSync(tmp, { recursive: true, force: true });
})();
