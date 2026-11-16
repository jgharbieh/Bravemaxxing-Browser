// cdp-quiet: a quiet CDP relay for agents that drive your Brave.
// Listens on ports.relay (default 9333), forwards to Brave's real CDP port ports.upstream (default 9222).
//
// 1. Focus: Page.bringToFront / Target.activateTarget are answered {} and NOT forwarded (a frozen tab is
//    woken with Page.setWebLifecycleState instead); Target.createTarget is forced to background:true,
//    never newWindow.
// 2. Wall, layer 2: CDP commands that would navigate / script toward a walled extension id or domain
//    (config: wall.extension_ids, wall.domains) are refused. Default list: a password manager.
//    Test sentinel: wall-test.invalid.
// 3. Wall, layer 3: a watchdog (own upstream connection) closes any AGENT-OWNED tab whose URL becomes a
//    walled one. Your own tabs are never touched.
// 4. Agents only SEE agent-owned tabs: your tabs are filtered out of Target.getTargets replies and target
//    events, and an agent can attach only to tabs it owns (default deny).
//    A connection that names its agent (header X-Agent, or ws://127.0.0.1:<port>/agent/<name>) sees and
//    drives ONLY that agent's tabs.
// 5. Local only: requests need Host 127.0.0.1:<port> or localhost:<port> and no browser Origin header.
// 6. Tab registry + status titles: agent-owned tabs carry a status emoji in their title (working / done /
//    paused), kept across navigations, SPA title changes and reloads by an injected keeper script.
//    Control endpoint: POST /_agent/status {cmd, agent, tab?, space?}   GET /_agent/registry
//    (client: scripts/tab-status.py). Registry persists in <state dir>/registry.json, wall log in wall.log.
//    State dir: $BRAVEMAXXING_STATE, else ~/.bravemaxxing/state.
//
// This is a tripwire for cooperating agents, not a security boundary: Brave's raw CDP port stays open to
// any local process that connects to it directly.
// The CDP-proxy approach was proposed by yangyaofei in vercel-labs/agent-browser#1247
// (https://github.com/vercel-labs/agent-browser/issues/1247). No code was copied; the credit is courtesy.
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const kit = require('../lib/kitconfig');

const CFG = kit.load({ strict: true }); // a typo in your config stops the relay instead of silently dropping the wall
const LISTEN = CFG.ports.relay;
const UPSTREAM = CFG.ports.upstream;
const DEBUG = !!process.env.CDP_QUIET_DEBUG;
const DROP = new Set(['Page.bringToFront', 'Target.activateTarget', 'Browser.setWindowBounds']);
const STATE = kit.stateDir();
try { fs.mkdirSync(STATE, { recursive: true }); } catch {}
const REG_FILE = path.join(STATE, 'registry.json');
const WALL_LOG = path.join(STATE, 'wall.log');
const log = (...a) => { if (DEBUG) console.log(...a); };
// Method trace (proof/debug): set CDP_QUIET_TRACE=<file>. One line per agent->browser command.
const TRACE = process.env.CDP_QUIET_TRACE || '';
let connSeq = 0;
const trace = (conn, msg, target, verdict) => { if (!TRACE) return; try { fs.appendFileSync(TRACE, `${new Date().toISOString()}	c${conn}	${msg.method}	${target || (msg.params && msg.params.targetId) || ''}	${verdict || ''}
`); } catch {} };

// ---------------------------------------------------------------- wall
// Walled extensions and sites come from the config (wall.extension_ids / wall.domains). Everything else is allowed.
const FORBIDDEN = kit.wallRegex(CFG);
const WALLED_METHODS = new Set(['Page.navigate', 'Target.createTarget', 'Runtime.evaluate', 'Runtime.callFunctionOn',
  'Runtime.compileScript', 'Page.addScriptToEvaluateOnNewDocument', 'Page.setDocumentContent']);
function wallLog(entry) {
  try { fs.appendFileSync(WALL_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}

// ---------------------------------------------------------------- registry
// tabs: { [targetId]: { agent, space, status: 'working'|'done'|'paused'|null, touched: bool } }
// agents: { [agent]: { state: 'working'|'done'|'idle' } }
let reg = { tabs: {}, agents: {} };
try { reg = { tabs: {}, agents: {}, ...JSON.parse(fs.readFileSync(REG_FILE, 'utf8')) }; } catch {}
let saveTimer = null;
let rev = 1;                 // bumped on every registry change
const waiters = new Set();   // long-poll callbacks of the tab-group extension (/_ext/state?wait=1)
function save() {
  rev++;
  for (const w of [...waiters]) w();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(REG_FILE, JSON.stringify(reg, null, 1)); } catch {} }, 200);
}
// A new target's first URL is the requested one, or about:blank/'' before it commits.
const sameUrl = (got, want) => (!got || got === 'about:blank') ? (!want || want === 'about:blank') : got.split('#')[0].startsWith(String(want).split('#')[0].slice(0, 200));
const UNOWNED = 'agent'; // relay-created tab whose agent isn't known yet (adopt/claim assigns it)
const EMOJI = { working: '🤖', done: '✅', paused: '⏸️' };
const agentState = (a) => (reg.agents[a] ||= { state: 'idle' }).state;

function setStatus(id, status) {
  const t = reg.tabs[id];
  if (!t || t.status === status) return;
  t.status = status;
  save();
  keeper.apply(id);
}
// The relay saw an agent act on this tab: it's touched this turn and shows 🤖 (acting right now).
function touch(id) {
  const t = reg.tabs[id];
  if (!t) return;
  if (!t.touched) { t.touched = true; save(); }
  setStatus(id, 'working');
}

function control(body) {
  const { cmd, agent, tab, space } = body;
  if (!agent || !/^[a-z0-9_-]{1,32}$/i.test(agent)) return { ok: false, error: 'agent required' };
  const mine = Object.entries(reg.tabs).filter(([, t]) => t.agent === agent);
  const claimTab = (id, sp) => {
    if (!/^[0-9A-F]{32}$/i.test(id || '')) return { ok: false, error: 'tab must be a 32-hex CDP target id' };
    const t = reg.tabs[id];
    if (t && t.agent !== agent && t.agent !== UNOWNED) return { ok: false, error: `tab owned by ${t.agent}` };
    if (t && t.agent === UNOWNED) t.agent = agent;
    if (t && sp && sp !== 'takeover') t.space = sp;
    reg.tabs[id] = t || { agent, space: sp || 'takeover', status: null, touched: false };
    save();
    keeper.attach(id);
    return null;
  };
  switch (cmd) {
    case 'register': // from agent-tab: a fresh agent tab; it is in use right now
    case 'claim': {
      if (cmd === 'claim' && !tab && body.match) { // hand-over by the words the user used: exactly one tab must match
        const q = String(body.match).toLowerCase().trim();
        if (q.length < 3) return { ok: false, error: 'match needs at least 3 characters' };
        const hits = [...keeper.urls.keys()].filter((id) => !reg.tabs[id] && (String(keeper.titles.get(id) || '').toLowerCase().includes(q) || String(keeper.urls.get(id) || '').toLowerCase().includes(q)));
        if (hits.length !== 1) return { ok: false, error: `${hits.length} tabs match; use other words from its title or URL, or ask the user to drag the tab into your tab group` };
        if (FORBIDDEN.test(keeper.urls.get(hits[0]) || '')) return { ok: false, error: 'that site is on the wall list' };
        const err = claimTab(hits[0], 'takeover');
        return err || { ok: true, tab: hits[0], title: keeper.titles.get(hits[0]) || '', url: keeper.urls.get(hits[0]) || '' };
      }
      const err = claimTab(tab, (cmd === 'register' || /^container:[\w-]{1,40}$/.test(space || '')) ? space : 'takeover');
      if (err) return err;
      if (cmd === 'register') touch(tab);
      return { ok: true };
    }
    case 'working': {
      reg.agents[agent] = { state: 'working' };
      if (tab) { const err = claimTab(tab); if (err) return err; touch(tab); }
      for (const [id, t] of mine) if (t.touched) setStatus(id, 'working');
      save();
      return { ok: true };
    }
    case 'done': {
      reg.agents[agent] = { state: 'done' };
      for (const [id, t] of mine) if (t.touched) setStatus(id, 'done');
      save();
      return { ok: true };
    }
    case 'turn-end': {
      reg.agents[agent] = { state: 'idle' };
      for (const [id, t] of mine) {
        if (t.touched) setStatus(id, 'paused');
        else if (t.status === 'paused') setStatus(id, null); // a full turn with no browser work: clear
        t.touched = false;
      }
      save();
      return { ok: true };
    }
    case 'open': { // {agent, tab: existing container tab, url}: child inherits container, owner, space
      const t = reg.tabs[tab];
      if (!t || t.agent !== agent) return { ok: false, error: 'tab is not yours' };
      if (!/^https?:\/\//i.test(body.url || '') || FORBIDDEN.test(body.url)) return { ok: false, error: 'url not allowed' };
      keeper.openIn(tab, body.url);
      return { ok: true };
    }
    case 'close': { // close one of the agent's tabs, or all of them (agent-browser cannot close its last tab)
      const ids = tab ? [tab] : mine.filter(([, t]) => t.space !== 'takeover').map(([id]) => id); // "all" never includes a tab the user handed over
      for (const id of ids) {
        const t = reg.tabs[id];
        if (!t || (t.agent !== agent && t.agent !== UNOWNED)) return { ok: false, error: 'not your tab' };
      }
      for (const id of ids) keeper.send('Target.closeTarget', { targetId: id });
      return { ok: true, closed: ids.length };
    }
    case 'expect': { // agent-tab is about to launch a container tab: the next new tab with this URL is this agent's
      if (!/^https?:\/\//i.test(body.url || '') || FORBIDDEN.test(body.url)) return { ok: false, error: 'url not allowed' };
      (keeper.expect ||= []).push({ url: body.url, agent, space: space || 'relay', until: Date.now() + 20000 });
      return { ok: true };
    }
    case 'release': { // hand a tab back to you: the agent can no longer see or drive it
      const t = reg.tabs[tab];
      if (!t) return { ok: true };
      if (t.agent !== agent && t.agent !== UNOWNED) return { ok: false, error: `tab owned by ${t.agent}` };
      keeper.release(tab);
      delete reg.tabs[tab];
      save();
      return { ok: true };
    }
    case 'partition': // {tab, other}: same storage partition (= same container)? Read-only, no focus.
      return keeper.partition(tab, body.other);
    case 'adopt': { // give this agent the unowned relay-created tabs from the last 60 s (hooks call it after `tab new`)
      const now = Date.now(); let n = 0;
      for (const t of Object.values(reg.tabs)) if (t.agent === UNOWNED && now - (t.created || 0) < 60000) { t.agent = agent; n++; }
      save();
      return { ok: true, adopted: n };
    }
    default: return { ok: false, error: `unknown cmd ${cmd}` };
  }
}

// ---------------------------------------------------------------- keeper (title + watchdog)
// Own upstream connection to the browser target. Attaches (flatten) to agent-owned tabs, installs a
// per-document title keeper, and watches every target for wall violations and opener inheritance.
const keeperScript = (status, native, bind) => `(() => {
  const B = window[${JSON.stringify(bind || '__agentOpen')}];
  const P = ${JSON.stringify(status ? EMOJI[status] : '')};
  window.__agentNative = ${native ? 'true' : 'false'};
  window.__agentTabStatus = P;
  const strip = (t) => String(t || '').replace(/^(?:\\u{1F916}|\\u2705|\\u23F8\\uFE0F?)\\s*/u, '').trim();
  let busy = false;
  // Never create a <title>: before the page has one, a created element shadows the page's own title
  // (document.title reads the FIRST <title>) and the observer would loop forever.
  const apply = () => {
    if (busy || !document.querySelector('title')) return;
    busy = true;
    try {
      const p = window.__agentTabStatus || ''; const b = strip(document.title);
      const want = (p && b) ? p + ' ' + b : (p || b);
      if (document.title.trim() !== want) document.title = want;
    } finally { busy = false; }
  };
  window.__agentTabApply = apply;
  const HOOK_VER = 4; // bump when the in-page hook changes: live pages swap to the new one
  if (window.__agentOpenHooked !== HOOK_VER && typeof B === 'function') {
    window.__agentOpenHooked = HOOK_VER;
    // Every new tab from an agent tab opens in the BACKGROUND:
    //  - normal agent tab: relay creates it (Target.createTarget background:true)
    //  - container tab: relay sends a TRUSTED Ctrl+Enter (Input.dispatchKeyEvent) on a temporary link =
    //    Brave's own "open in background tab", which keeps the container. (A CDP-created tab lands outside
    //    the container; a synthetic JS ctrl-click opens a FOREGROUND tab and raises the window.)
    const abs = (u) => new URL(String(u || 'about:blank'), location.href).href;
    const viaRelay = (u) => { try { B(JSON.stringify({ u: abs(u) })); } catch (e) {} return null; };
    const bg = viaRelay;
    window.__agentBgOpen = bg;
    window.open = function (u) { return bg(u); };
    const onClick = (e) => {
      if (window.__agentOpenHooked !== HOOK_VER) return; // superseded by a newer hook
      const a = e.target && e.target.closest && e.target.closest('a[href]'); if (!a || a.dataset.agentBg) return;
      const t = (a.getAttribute('target') || '').toLowerCase();
      if ((t && !['_self', '_top', '_parent'].includes(t)) || e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) {
        e.preventDefault(); e.stopImmediatePropagation(); bg(a.href);
      }
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', onClick, true);
  }
  apply();
  if (!window.__agentTabKeeper) {
    window.__agentTabKeeper = true;
    const watch = () => { const h = document.head || document.documentElement; if (!h) return setTimeout(watch, 50);
      new MutationObserver(() => window.__agentTabApply()).observe(h, { subtree: true, childList: true, characterData: true }); };
    watch();
    document.addEventListener('DOMContentLoaded', () => window.__agentTabApply());
    setInterval(() => window.__agentTabApply(), 1500);
  }
})();`;

const keeper = {
  ws: null, nextId: 1, pending: new Map(), sessions: new Map(), scripts: new Map(), urls: new Map(), titles: new Map(),
  send(method, params = {}, sessionId) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.resolve(null);
    const id = this.nextId++;
    const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    return new Promise((res) => {
      this.pending.set(id, res);
      setTimeout(() => { if (this.pending.delete(id)) res(null); }, 5000);
      this.ws.send(JSON.stringify(msg));
    });
  },
  async attach(id) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    const r = await this.send('Target.attachToTarget', { targetId: id, flatten: true });
    const sid = r && r.result && r.result.sessionId;
    if (!sid) return null;
    this.sessions.set(id, sid);
    await this.send('Page.enable', {}, sid); // needed for addScriptToEvaluateOnNewDocument to fire on new documents
    await this.send('Runtime.enable', {}, sid);
    await this.send('Runtime.addBinding', { name: '__agentOpen_' + id }, sid); // per-tab name = caller identity // in-page opens -> background tabs (see keeperScript)
    await this.apply(id);
    return sid;
  },
  async apply(id) {
    const t = reg.tabs[id];
    if (!t) return;
    const sid = this.sessions.get(id) || await this.attach(id);
    if (!sid) return;
    const src = keeperScript(t.status, String(t.space || '').startsWith('container:'), '__agentOpen_' + id);
    const old = this.scripts.get(id);
    if (old) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: old }, sid);
    const r = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: src }, sid);
    if (r && r.result) this.scripts.set(id, r.result.identifier);
    await this.send('Runtime.evaluate', { expression: src }, sid);
  },
  async openFor(parentId, payload) { // parentId comes from the per-tab binding name
    const parent = parentId && reg.tabs[parentId];
    if (TRACE) try { fs.appendFileSync(TRACE, `${new Date().toISOString()}	keeper	openFor	${parentId || 'NO-PARENT'}	${parent ? parent.agent + ' ' + parent.space : '-'}
`); } catch {}
    let url; try { url = JSON.parse(payload).u; } catch { return; }
    if (!parent || !/^(https?:|about:blank)/i.test(url || '')) return;
    if (FORBIDDEN.test(url)) return wallLog({ layer: 2, action: 'refused-popup', agent: parent.agent });
    if (String(parent.space || '').startsWith('container:')) return this.openIn(parentId, url);
    const r = await this.send('Target.createTarget', { url, background: true });
    const id = r && r.result && r.result.targetId;
    if (id && !reg.tabs[id]) { reg.tabs[id] = { agent: parent.agent, space: parent.space, status: 'working', touched: true, created: Date.now() }; save(); this.attach(id); }
  },
  claimExpected(info) { // a background tab the relay opened by ctrl-click (no openerId): match by URL
    if (!info || info.type !== 'page' || reg.tabs[info.targetId] || !this.expect || !this.expect.length) return false;
    const now = Date.now(); this.expect = this.expect.filter((e) => e.until > now);
    const i = this.expect.findIndex((e) => info.url && info.url !== 'about:blank' ? sameUrl(info.url, e.url) : false);
    if (i < 0) return false;
    const e = this.expect.splice(i, 1)[0];
    reg.tabs[info.targetId] = { agent: e.agent, space: e.space, status: 'working', touched: true, created: now };
    save(); this.attach(info.targetId); return true;
  },
  async openIn(id, url) { // background tab in the SAME container as tab `id`, owned by the same agent
    const t = reg.tabs[id]; const sid = this.sessions.get(id) || await this.attach(id);
    if (!t || !sid || FORBIDDEN.test(url)) return;
    (this.expect ||= []).push({ url, agent: t.agent, space: t.space, until: Date.now() + 15000 });
    // Trusted Ctrl+Enter on a focused temporary link = Brave's "open link in background tab": keeps the
    // container, no focus, no tab switch. (Keyboard, not mouse: hidden tabs can drop mouse moves/clicks.)
    await this.send('Page.setWebLifecycleState', { state: 'active' }, sid);
    await this.send('Runtime.evaluate', { expression: `(()=>{const a=document.createElement('a');a.id='__agentBgLink';a.href=${JSON.stringify(url)};a.dataset.agentBg='1';a.textContent='.';a.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;z-index:2147483647';document.documentElement.appendChild(a);a.focus()})()` }, sid);
    for (const type of ['rawKeyDown', 'keyUp'])
      await this.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2 }, sid);
    await this.send('Runtime.evaluate', { expression: "document.getElementById('__agentBgLink')?.remove()" }, sid);
  },
  async evalIn(id, expression) { const sid = this.sessions.get(id) || await this.attach(id); if (sid) await this.send('Runtime.evaluate', { expression, userGesture: true }, sid); },
  async partition(a, b) { // same storage partition (= same container)? marker cookie, removed after
    if (!reg.tabs[a] || !reg.tabs[b]) return { ok: false, error: 'both tabs must be agent tabs' };
    const sa = this.sessions.get(a) || await this.attach(a); const sb = this.sessions.get(b) || await this.attach(b);
    if (!sa || !sb) return { ok: false, error: 'could not attach' };
    const name = 'agent_part_' + Math.random().toString(36).slice(2, 10);
    const ck = { name, url: 'https://agent-partition.invalid/' };
    await this.send('Network.setCookie', { ...ck, value: '1' }, sa);
    const r = await this.send('Network.getAllCookies', {}, sb);
    const same = !!((r && r.result && r.result.cookies) || []).find((c) => c.name === name);
    await this.send('Network.deleteCookies', ck, sa);
    return { ok: true, same };
  },
  async wake(id) { const sid = this.sessions.get(id) || await this.attach(id); if (sid) await this.send('Page.setWebLifecycleState', { state: 'active' }, sid); },
  forget(id) { this.sessions.delete(id); this.scripts.delete(id); },
  async release(id) { // undo what attach/apply did: no emoji, no in-page hooks on the next document, no session
    const sid = this.sessions.get(id);
    if (sid) {
      const old = this.scripts.get(id);
      if (old) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: old }, sid);
      await this.send('Runtime.evaluate', { expression: "window.__agentTabStatus='';window.__agentOpenHooked=0;window.__agentTabApply&&window.__agentTabApply()" }, sid);
      await this.send('Runtime.removeBinding', { name: '__agentOpen_' + id }, sid);
      await this.send('Target.detachFromTarget', { sessionId: sid });
    }
    this.forget(id);
  },
  // agent-browser opens an about:blank tab when it connects and cannot close its last tab, so every ended
  // session would leave one behind. Close agent tabs that are still blank, unused and a minute old.
  sweep() {
    const now = Date.now();
    for (const [id, t] of Object.entries(reg.tabs)) {
      const url = this.urls.get(id) || '';
      if ((url === 'about:blank' || url === '') && now - (t.created || now) > 60000 && !(liveAttach.get(id) || new Set()).size) {
        this.send('Target.closeTarget', { targetId: id });
      }
    }
  },
  onTarget(info, created) {
    if (info.type !== 'page') return;
    const id = info.targetId;
    if (!reg.tabs[id]) this.claimExpected(info); // created or first real URL (ctrl-click tabs start as about:blank)
    // A tab opened BY an agent-owned tab (popup, target=_blank) belongs to the same agent.
    if (created && info.openerId && reg.tabs[info.openerId] && !reg.tabs[id]) {
      const parent = reg.tabs[info.openerId];
      reg.tabs[id] = { agent: parent.agent, space: parent.space, status: 'working', touched: true };
      save();
      this.attach(id);
    }
    this.urls.set(id, info.url); this.titles.set(id, info.title || '');
    const t = reg.tabs[id];
    if (t && FORBIDDEN.test(info.url || '')) {
      wallLog({ layer: 3, action: 'closed', agent: t.agent, tab: id, url: info.url });
      this.send('Target.closeTarget', { targetId: id });
      return;
    }
    // Backstop for the in-page keeper: if an owned tab's title lost (or wrongly kept) its emoji, re-apply.
    if (t) {
      const want = t.status ? EMOJI[t.status] : '';
      const has = /^(?:\u{1F916}|✅|⏸️?)/u.exec(info.title || '');
      const ok = want ? (has && has[0].startsWith(Array.from(want)[0])) : !has;
      if (!ok && info.title) {
        clearTimeout((this.fix ||= new Map()).get(id));
        this.fix.set(id, setTimeout(() => this.apply(id), 300));
      }
    }
  },
  connect() {
    http.get({ host: '127.0.0.1', port: UPSTREAM, path: '/json/version', timeout: 2000 }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => {
        let url; try { url = JSON.parse(b).webSocketDebuggerUrl; } catch {}
        try { this.browserPath = new URL(url).pathname; } catch {}
        if (!url) return this.retry();
        const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
        this.ws = ws;
        ws.on('open', async () => {
          log('keeper connected');
          await this.send('Target.setDiscoverTargets', { discover: true });
          const r = await this.send('Target.getTargets');
          const infos = ((r && r.result && r.result.targetInfos) || []).filter((t) => t.type === 'page');
          for (const t of infos) { this.urls.set(t.targetId, t.url); this.titles.set(t.targetId, t.title || ''); } // needed by the attach wall below
          const live = new Set(infos.map((t) => t.targetId));
          for (const id of Object.keys(reg.tabs)) if (!live.has(id)) delete reg.tabs[id]; // closed while we were down
          save();
          for (const id of Object.keys(reg.tabs)) this.attach(id);
        });
        ws.on('message', (data) => {
          let m; try { m = JSON.parse(data.toString('utf8')); } catch { return; }
          if (m.id && this.pending.has(m.id)) { const f = this.pending.get(m.id); this.pending.delete(m.id); return f(m); }
          if (m.method === 'Runtime.bindingCalled' && m.params.name.startsWith('__agentOpen_')) return this.openFor(m.params.name.slice(12), m.params.payload);
          if (m.method === 'Target.targetCreated') this.onTarget(m.params.targetInfo, true);
          else if (m.method === 'Target.targetInfoChanged') this.onTarget(m.params.targetInfo, false);
          else if (m.method === 'Target.targetDestroyed') {
            const id = m.params.targetId; this.forget(id); this.urls.delete(id); this.titles.delete(id);
            if (reg.tabs[id]) { delete reg.tabs[id]; save(); }
          } else if (m.method === 'Target.detachedFromTarget') {
            for (const [id, sid] of this.sessions) if (sid === m.params.sessionId) this.forget(id);
          }
        });
        const down = () => { if (this.ws === ws) { this.ws = null; this.sessions.clear(); this.scripts.clear(); this.retry(); } };
        ws.on('close', down); ws.on('error', down);
      });
    }).on('error', () => this.retry()).on('timeout', function () { this.destroy(); });
  },
  retry() { clearTimeout(this.rt); this.rt = setTimeout(() => this.connect(), 5000); },
};

// ---------------------------------------------------------------- HTTP: control + proxy
// Web-page protection: any site in Brave can open ws:// / fetch to 127.0.0.1. Brave's own port rejects
// foreign Origins, but this relay talks upstream without one, so the relay must enforce it itself:
// exact loopback Host (blocks DNS rebinding) and no Origin header on WebSocket upgrades (CDP clients send none).
const HOST_OK = new Set([`127.0.0.1:${LISTEN}`, `localhost:${LISTEN}`]);
const trusted = (req) => HOST_OK.has(String(req.headers.host || '').toLowerCase());
// The one browser Origin that is let in, and only on /_ext/: the kit's own tab-group extension (config groups.extension_ids).
const GROUPS = CFG.groups || {};
const EXT_ORIGINS = new Set((Array.isArray(GROUPS.extension_ids) ? GROUPS.extension_ids : []).map((id) => `chrome-extension://${id}`));
const liveAttach = new Map(); // targetId -> Set(connection ids) with a live session on it
function extState() {
  const tabs = {};
  for (const [id, t] of Object.entries(reg.tabs)) tabs[id] = { agent: t.agent, space: t.space, status: t.status };
  return { rev, enabled: GROUPS.enabled !== false, tabs, agents: reg.agents, colors: GROUPS.colors || {} };
}
function extEvent(body) { // the user moved a tab into / out of an agent's tab group
  const { type, tab, agent } = body || {};
  if (type === 'joined') {
    if (FORBIDDEN.test(keeper.urls.get(tab) || '')) return { ok: false, error: 'that site is on your wall list' };
    return control({ cmd: 'claim', agent, tab });
  }
  if (type === 'left') return control({ cmd: 'release', agent, tab });
  return { ok: false, error: 'unknown event' };
}
const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const isExt = req.url.startsWith('/_ext/');
  if (!trusted(req) || (origin && !(isExt && EXT_ORIGINS.has(origin)))) { res.writeHead(403); return res.end('forbidden'); }
  log('HTTP', req.method, req.url);
  if (isExt) {
    const cors = origin ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST' } : {};
    const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/_ext/state') {
      if (u.searchParams.get('wait') !== '1' || Number(u.searchParams.get('rev')) !== rev) return reply(200, extState());
      let done = false;
      const finish = () => { if (done) return; done = true; waiters.delete(finish); clearTimeout(timer); reply(200, extState()); };
      const timer = setTimeout(finish, 20000);
      waiters.add(finish);
      req.on('close', () => { if (!done) { done = true; waiters.delete(finish); clearTimeout(timer); } });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/_ext/event') {
      let b = ''; req.on('data', (c) => { b += c; if (b.length > 10000) req.destroy(); });
      req.on('end', () => { let body; try { body = JSON.parse(b); } catch { return reply(400, { ok: false, error: 'bad json' }); } reply(200, extEvent(body)); });
      return;
    }
    return reply(404, { ok: false });
  }
  if (req.url.startsWith('/_agent/')) {
    const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/_agent/registry') return reply(200, reg);
    if (req.method === 'POST' && req.url === '/_agent/status') {
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reply(415, { ok: false, error: 'content-type must be application/json' });
      let b = ''; req.on('data', (c) => { b += c; if (b.length > 10000) req.destroy(); });
      req.on('end', () => { let body; try { body = JSON.parse(b); } catch { return reply(400, { ok: false, error: 'bad json' }); } Promise.resolve(control(body)).then((r) => reply(200, r), (e) => reply(500, { ok: false, error: String(e) })); });
      return;
    }
    return reply(404, { ok: false });
  }
  // Brave's plain-HTTP tab endpoints skip every WebSocket rule below, so they are refused here:
  // /json/activate raises a tab (focus), /json/new opens a FOREGROUND tab, /json/close can close a tab of yours.
  const act = req.url.match(/^\/json\/(activate|close|new)(?:\/([^/?]+))?/i);
  if (act) {
    const kind = act[1].toLowerCase();
    if (kind !== 'close' || !reg.tabs[act[2] || '']) {
      wallLog({ layer: 2, action: 'refused-http', kind, tab: act[2] || '' });
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: kind === 'close' ? 'agent wall: not an agent tab' : `agent wall: /json/${kind} takes focus; use the CDP websocket (Target.createTarget) through this relay` }));
    }
  }
  const listing = /^\/json(?:\/list)?\/?(?:\?.*)?$/i.test(req.url);
  const who = String(req.headers['x-agent'] || '').toLowerCase();
  const up = http.request({ host: '127.0.0.1', port: UPSTREAM, path: req.url, method: req.method, headers: req.headers }, (ur) => {
    const chunks = [];
    ur.on('data', (c) => chunks.push(c));
    ur.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      body = body.split(`127.0.0.1:${UPSTREAM}`).join(`127.0.0.1:${LISTEN}`).split(`localhost:${UPSTREAM}`).join(`127.0.0.1:${LISTEN}`);
      if (listing) { // your tabs (titles, URLs) are not listed to agents: only agent tabs, and to a named caller only its own
        try {
          body = JSON.stringify(JSON.parse(body).filter((t) => { const r = reg.tabs[t.id]; return r && (!who || r.agent === who || r.agent === UNOWNED); }), null, 1);
        } catch { body = '[]'; }
      }
      const headers = { ...ur.headers };
      delete headers['content-length'];
      res.writeHead(ur.statusCode, headers);
      res.end(body);
    });
  });
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
});

// ---------------------------------------------------------------- WebSocket relay
const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (!trusted(req) || req.headers.origin) { wallLog({ action: 'refused-ws', origin: req.headers.origin || '', host: req.headers.host || '' }); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (client) => {
    log('WS', req.url);
    const connId = ++connSeq;
    if (TRACE) try { fs.appendFileSync(TRACE, `${new Date().toISOString()}	c${connId}	CONNECT	${req.url}
`); } catch {}
    const pageConn = (req.url.match(/^\/devtools\/page\/([0-9A-F]{32})/i) || [])[1] || null; // non-flatten page socket
    if (pageConn && (!reg.tabs[pageConn] || FORBIDDEN.test(keeper.urls.get(pageConn) || ''))) { // default deny
      wallLog({ layer: 2, action: 'refused-page-socket', tab: pageConn });
      return client.close(1008, 'blocked by agent wall');
    }
    const sessionTarget = new Map(); // sessionId -> targetId (flatten mode)
    const attachReq = new Map();     // request id -> targetId (Target.attachToTarget awaiting reply)
    const createReq = new Map();     // request id -> {url, at} of Target.createTarget
    // Agent identity: header X-Agent (agent-browser --cdp-headers / AGENT_BROWSER_CDP_HEADERS) or URL
    // ws://127.0.0.1:9333/agent/<name>. A named connection sees and drives ONLY its own agent's tabs.
    const pathAgent = (req.url.match(/^\/agent\/([a-z0-9_-]{1,32})\/?$/i) || [])[1];
    const preset = String(pathAgent || req.headers['x-agent'] || '').toLowerCase();
    const connAgent = { name: /^[a-z0-9_-]{1,32}$/.test(preset) ? preset : null }; // else learned from first owned tab
    connAgent.fixed = !!connAgent.name;
    const upPath = pathAgent ? (keeper.browserPath || '/') : req.url;
    const upstream = new WebSocket(`ws://127.0.0.1:${UPSTREAM}${upPath}`, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    const queue = [];
    upstream.on('open', () => { for (const [m, b] of queue.splice(0)) upstream.send(m, { binary: b }); });
    // Agents only SEE agent-owned tabs: your tabs are filtered out of Target.getTargets replies and
    // target events, so a session can never land on, attach to, or act on them. (agent-browser attaches to
    // every visible tab on connect and drives the first one, which would be your front tab.)
    const getReq = new Set(); // request ids of Target.getTargets
    const visible = (ti) => { if (!ti || ti.type !== 'page') return true; const t = reg.tabs[ti.targetId]; return !!t && (!connAgent.fixed || t.agent === connAgent.name || t.agent === UNOWNED); };
    const adoptNew = (ti) => { // a page this connection just created, or a popup of an agent tab
      if (!ti || ti.type !== 'page' || reg.tabs[ti.targetId]) return;
      const parent = ti.openerId && reg.tabs[ti.openerId];
      if (parent) reg.tabs[ti.targetId] = { agent: parent.agent, space: parent.space, status: 'working', touched: true, created: Date.now() };
      else if (keeper.claimExpected(ti)) return;
      else if ([...createReq.values()].some((c) => Date.now() - c.at < 10000 && sameUrl(ti.url, c.url))) reg.tabs[ti.targetId] = { agent: connAgent.name || UNOWNED, space: 'relay', status: 'working', touched: true, created: Date.now() };
      else return;
      save(); keeper.attach(ti.targetId);
    };
    const TGT = Buffer.from('"Target.');
    upstream.on('message', (data, isBinary) => {
      if (!isBinary && !pageConn && (attachReq.size || createReq.size || getReq.size || data.includes(TGT))) {
        try {
          const m = JSON.parse(data.toString('utf8'));
          if (m.id && attachReq.has(m.id)) {
            if (m.result && m.result.sessionId) {
              const tid = attachReq.get(m.id);
              sessionTarget.set(m.result.sessionId, tid);
              (liveAttach.get(tid) || liveAttach.set(tid, new Set()).get(tid)).add(connId);
            }
            attachReq.delete(m.id);
          } else if (m.id && createReq.has(m.id)) {
            createReq.delete(m.id);
            const id = m.result && m.result.targetId;
            if (id && !reg.tabs[id]) { reg.tabs[id] = { agent: connAgent.name || UNOWNED, space: 'relay', status: 'working', touched: true, created: Date.now() }; save(); keeper.attach(id); }
          } else if (m.id && getReq.has(m.id)) {
            getReq.delete(m.id);
            if (m.result && m.result.targetInfos) { m.result.targetInfos = m.result.targetInfos.filter(visible); data = JSON.stringify(m); isBinary = false; }
          } else if (m.method === 'Target.targetCreated') {
            adoptNew(m.params.targetInfo);
            if (!visible(m.params.targetInfo)) return;
          } else if (m.method === 'Target.targetInfoChanged' || m.method === 'Target.attachedToTarget') {
            if (!visible(m.params.targetInfo)) return;
          } else if (m.method === 'Target.targetDestroyed' || m.method === 'Target.targetCrashed') {
            if (!reg.tabs[m.params.targetId] && !keeper.urls.has(m.params.targetId)) { /* unknown: pass */ }
          }
        } catch {}
      }
      if (client.readyState === 1) client.send(data, { binary: isBinary });
    });
    client.on('message', (data, isBinary) => {
      let out = data;
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString('utf8'));
          trace(connId, msg, msg.sessionId ? sessionTarget.get(msg.sessionId) : pageConn);
          const reply = (obj) => { const r = { id: msg.id, ...obj }; if (msg.sessionId) r.sessionId = msg.sessionId; client.send(JSON.stringify(r)); };
          // Attach wall (default deny): on connect agent-browser attaches to EVERY tab and, with no saved tab,
          // drives the first one = your front tab. Agents may attach only to agent-owned tabs
          // (relay-created, agent-tab, or claimed via tab-status claim), and never to a walled one.
          if (msg.method === 'Target.attachToTarget') {
            const tid = (msg.params || {}).targetId;
            const walled = FORBIDDEN.test(keeper.urls.get(tid) || '');
            const own = reg.tabs[tid] && (!connAgent.fixed || reg.tabs[tid].agent === connAgent.name || reg.tabs[tid].agent === UNOWNED);
            if (!own || walled) {
              if (walled) wallLog({ layer: 2, action: 'refused-attach', agent: connAgent.name });
              return reply({ error: { code: -32000, message: 'agent wall: not an agent tab. Open your own (agent-browser tab new <url>) or claim it first (tab-status claim)' } });
            }
          }
          // Default deny for everything else that names a tab: a command addressed to a tab that is not an
          // agent tab (yours, or one you took back) never reaches the browser. This is what stops a stale or
          // empty tab id from closing or driving one of your tabs.
          if (msg.method !== 'Target.attachToTarget') {
            const named = (msg.params || {}).targetId;
            const viaSession = msg.sessionId ? sessionTarget.get(msg.sessionId) : pageConn;
            for (const tid of [named, viaSession]) {
              if (typeof tid !== 'string' || !/^[0-9A-F]{32}$/i.test(tid)) continue;
              const t = reg.tabs[tid];
              if (!t || (connAgent.fixed && t.agent !== connAgent.name && t.agent !== UNOWNED)) {
                return reply({ error: { code: -32000, message: 'agent wall: not an agent tab (it is yours, or it was handed back). Open your own tab or ask for it' } });
              }
            }
          }
          if (WALLED_METHODS.has(msg.method) && FORBIDDEN.test(JSON.stringify(msg.params || {}))) {
            wallLog({ layer: 2, action: 'refused', method: msg.method, agent: connAgent.name });
            return reply({ error: { code: -32000, message: 'blocked by agent wall: this extension or site is off limits to agents' } });
          }
          // Focus: never activate. agent-browser sends these to wake a frozen (Memory Saver) tab; wake it with
          // Page.setWebLifecycleState instead, which unfreezes without raising or switching anything.
          if (msg.method === 'Page.bringToFront') {
            msg.method = 'Page.setWebLifecycleState'; msg.params = { state: 'active' };
            out = JSON.stringify(msg);
          } else if (DROP.has(msg.method)) {
            const tid = (msg.params || {}).targetId;
            if (tid && reg.tabs[tid]) keeper.wake(tid);
            return reply({ result: {} });
          }
          if (msg.method === 'Target.createTarget') {
            msg.params = { ...(msg.params || {}), background: true };
            delete msg.params.newWindow;
            createReq.set(msg.id, { url: String(msg.params.url || 'about:blank'), at: Date.now() });
            out = JSON.stringify(msg);
          }
          if (msg.method === 'Target.attachToTarget' && msg.params && msg.params.targetId) attachReq.set(msg.id, msg.params.targetId);
          if (msg.method === 'Target.getTargets') getReq.add(msg.id);
          // "touched": this connection acted on an agent-owned tab
          const target = msg.sessionId ? sessionTarget.get(msg.sessionId) : pageConn;
          if (target && reg.tabs[target]) {
            const owner = reg.tabs[target].agent;
            // One agent per connection: once a session acts for an agent, other agents' tabs are off limits
            // (agent-browser auto-follows new tabs and can drift onto another agent's tab).
            if (connAgent.name && owner !== connAgent.name && owner !== UNOWNED && msg.method !== 'Runtime.runIfWaitingForDebugger') {
              return reply({ error: { code: -32000, message: `agent wall: tab belongs to ${owner}; rebind your own tab` } });
            }
            if (owner !== UNOWNED) connAgent.name = owner;
            touch(target);
          }
        } catch { /* not JSON: pass through */ }
      }
      if (upstream.readyState === 1) upstream.send(out, { binary: isBinary }); else queue.push([out, isBinary]);
    });
    const closeBoth = () => { for (const set of liveAttach.values()) set.delete(connId); try { client.close(); } catch {} try { upstream.close(); } catch {} };
    client.on('close', closeBoth); upstream.on('close', closeBoth);
    client.on('error', (e) => { log('client err', e.message); closeBoth(); });
    upstream.on('error', (e) => { log('upstream err', e.message); closeBoth(); });
  });
});

server.listen(LISTEN, '127.0.0.1', () => { console.log(`cdp-quiet ${LISTEN} -> ${UPSTREAM}`); keeper.connect(); setInterval(() => keeper.sweep(), 30000).unref(); });
