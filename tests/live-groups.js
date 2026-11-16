'use strict';
// Live test of the tab-group extension against a real (headless, throwaway) Chromium.   CHROME_BIN=<chrome> node tests/live-groups.js
// Uses spare ports and a temp profile + state dir: it never touches your Brave or a running relay.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'bravemaxxing-browser');
const WebSocket = require(path.join(PLUGIN, 'node_modules', 'ws'));
const CHROME = process.env.CHROME_BIN;
if (!CHROME || !fs.existsSync(CHROME)) { console.log('skipped: set CHROME_BIN to a Chromium / Chrome for Testing binary'); process.exit(0); }
const UP = 19422, RELAY = 19433;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmx-groups-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
const until = async (what, fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(250); } };

function cdp(url, headers) { // minimal CDP client
  const ws = new WebSocket(url, { headers, perMessageDeflate: false });
  let id = 0; const pend = new Map();
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  return new Promise((res, rej) => { ws.on('open', () => res({ send, close: () => ws.close() })); ws.on('error', rej); });
}

(async () => {
  // the extension, with the test relay's port as its default
  const ext = path.join(tmp, 'ext'); fs.cpSync(path.join(PLUGIN, 'extension'), ext, { recursive: true });
  fs.writeFileSync(path.join(ext, 'sw.js'), fs.readFileSync(path.join(ext, 'sw.js'), 'utf8').replace('{ port: 9333 }', `{ port: ${RELAY} }`));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${UP}`, `--user-data-dir=${path.join(tmp, 'profile')}`, `--load-extension=${ext}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const env = { ...process.env, CDP_QUIET_PORT: String(RELAY), CDP_UPSTREAM_PORT: String(UP), BRAVEMAXXING_STATE: path.join(tmp, 'state'), BRAVEMAXXING_CONFIG: path.join(tmp, 'none.json') };
  fs.writeFileSync(path.join(tmp, 'none.json'), '{}');
  let relay; let failed = false;
  try {
    const ver = await until('chromium CDP', () => getJson(UP, '/json/version'));
    relay = spawn('node', [path.join(PLUGIN, 'relay', 'cdp-quiet.js')], { env, stdio: 'ignore' });
    await until('relay', () => getJson(RELAY, '/_agent/registry'));

    // raw browser connection (test harness only) to look at the tab strip through the extension's worker
    const raw = await cdp(ver.webSocketDebuggerUrl);
    const worker = await until('extension service worker', async () => {
      const t = (await raw.send('Target.getTargets')).result.targetInfos.find((x) => x.type === 'service_worker' && x.url.endsWith('/sw.js'));
      return t && (await raw.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).result.sessionId;
    });
    const inExt = async (expr) => { const r = await raw.send('Runtime.evaluate', { expression: `(async()=>(${expr}))()`, awaitPromise: true, returnByValue: true }, worker); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
    const groups = () => inExt('chrome.tabGroups.query({})');
    const tabs = () => inExt('chrome.tabs.query({})');
    const registry = async () => (await getJson(RELAY, '/_agent/registry')).tabs;
    const show = (g) => g.map((x) => `${JSON.stringify(x.title)}/${x.color}`).join(', ');
    const step = (msg) => console.log('  ok  ' + msg);

    // 1. an agent opens a tab through the relay -> it lands in a group named after the agent
    const hermes = await cdp(`ws://127.0.0.1:${RELAY}/agent/hermes`);
    const created = (await hermes.send('Target.createTarget', { url: 'data:text/html,<title>agent page</title>hello' })).result.targetId;
    const g1 = await until('Hermes group', async () => { const g = await groups(); return g.length === 1 && g[0]; });
    assert.match(g1.title, /Hermes​$/); assert.strictEqual(g1.color, 'purple');
    const agentTab = (await tabs()).find((t) => t.groupId === g1.id);
    assert(agentTab, 'the agent tab is in the group'); assert.strictEqual(agentTab.active, false, 'it was not activated');
    step(`agent tab joins its own group (${show([g1])}) without being activated`);

    // 2. the group title follows the agent's state
    const post = (body) => new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port: RELAY, path: '/_agent/status', method: 'POST', headers: { 'content-type': 'application/json' } }, (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => res(JSON.parse(d))); }); r.on('error', rej); r.end(JSON.stringify(body)); });
    await post({ cmd: 'working', agent: 'hermes' });
    await until('working title', async () => (await groups())[0].title.startsWith('🤖'));
    await post({ cmd: 'turn-end', agent: 'hermes' });
    await until('idle title', async () => (await groups())[0].title === 'Hermes​');
    step('group title shows 🤖 while working and clears when the turn ends');

    // 3. you drag one of YOUR tabs into the group -> it is handed to the agent
    const mine = (await tabs()).find((t) => t.groupId === -1);
    assert(mine, 'a user tab exists');
    assert.strictEqual(Object.keys(await registry()).length, 1);
    await inExt(`chrome.tabs.group({ groupId: ${g1.id}, tabIds: [${mine.id}] })`);
    await until('hand-over registered', async () => Object.keys(await registry()).length === 2);
    const reg2 = await registry(); const handed = Object.keys(reg2).find((k) => k !== created);
    assert.strictEqual(reg2[handed].agent, 'hermes'); assert.strictEqual(reg2[handed].space, 'takeover');
    const seen = (await hermes.send('Target.getTargets')).result.targetInfos.filter((t) => t.type === 'page').map((t) => t.targetId);
    assert(seen.includes(handed), 'the agent can now see the tab');
    step('dragging your tab into the group hands it to the agent');

    // 4. you drag it out -> you took it back: the agent cannot see it, attach to it or close it
    await inExt(`chrome.tabs.ungroup(${mine.id})`);
    await until('take-back registered', async () => Object.keys(await registry()).length === 1);
    const seen2 = (await hermes.send('Target.getTargets')).result.targetInfos.filter((t) => t.type === 'page').map((t) => t.targetId);
    assert(!seen2.includes(handed), 'hidden again');
    assert((await hermes.send('Target.attachToTarget', { targetId: handed, flatten: true })).error, 'attach refused');
    assert((await hermes.send('Target.closeTarget', { targetId: handed })).error, 'close refused');
    assert((await tabs()).some((t) => t.id === mine.id), 'your tab is still open');
    await sleep(3500); // past the "fresh drop" grace: it must stay out of the group
    assert.strictEqual((await tabs()).find((t) => t.id === mine.id).groupId, -1);
    step('dragging it out takes it back: hidden, attach and close refused, tab untouched');

    // 5. a second agent gets its own group; one agent cannot touch the other's tab
    const claude = await cdp(`ws://127.0.0.1:${RELAY}/agent/claude`);
    await claude.send('Target.createTarget', { url: 'data:text/html,<title>claude page</title>hi' });
    const g2 = await until('two groups', async () => { const g = await groups(); return g.length === 2 && g; });
    assert.deepStrictEqual(g2.map((x) => x.title.replace(/^\S+ /u, '')).sort(), ['Claude​', 'Hermes​']);
    assert((await claude.send('Target.closeTarget', { targetId: created })).error, "claude cannot close hermes' tab");
    step(`each agent has its own group (${show(g2)}) and cannot touch the other's tabs`);

    // 6. the agent closes its tab -> the group goes away with it
    assert(!(await hermes.send('Target.closeTarget', { targetId: created })).error);
    await until('Hermes group gone', async () => (await groups()).length === 1);
    step('closing the last agent tab removes its group');
    hermes.close(); claude.close(); raw.close();
  } catch (e) { failed = true; console.log('  FAIL ' + (e && e.stack || e)); }
  finally { try { relay && relay.kill(); } catch {} try { chrome.kill(); } catch {} await sleep(300); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  console.log(failed ? '\nFAILED' : '\nall live checks passed');
  process.exit(failed ? 1 : 0);
})();
