// Bravemaxxing Tab Groups: keeps each agent's tabs in ONE tab group per window, named after the agent.
//
//   - A tab an agent opens or is given joins that agent's group. Nothing is activated, no window is raised.
//   - You drag a tab INTO an agent's group  -> the tab is handed to that agent (it can now see and drive it).
//   - You drag a tab OUT of the group       -> you take it back (the agent can no longer see it).
//   - The group title shows what the agent is doing: 🤖 working, ✅ action done, no emoji = idle.
//
// The relay (cdp-quiet.js) owns the truth: which tab belongs to which agent. This worker mirrors it into
// tab groups and reports your drags back. It also does four small things for the relay that only an extension
// can do cleanly: open a tab truly in the background, switch to a tab without raising the window, raise the
// window, and say which tab is in front. It talks to http://127.0.0.1:<relay port> and nothing else.
// The "debugger" permission is used for one read-only call, chrome.debugger.getTargets(), which maps a tab to
// the id the relay knows it by. It never attaches to a tab.
const MARK = '​'; // invisible suffix: marks a group as owned by this extension (never match a group of yours by name)
const EMOJI = { working: '🤖', done: '✅' };
const COLORS = ['blue', 'cyan', 'green', 'pink', 'red', 'yellow', 'grey'];

let state = null; // last state from the relay: { rev, enabled, tabs: {targetId: {agent}}, agents: {name: {state}}, colors }
const moved = new Map(); // tabId -> time of its last group change (a fresh drop is never treated as stale)
let pending = 0;         // group changes seen but not handled yet
let chain = Promise.resolve();
const run = (fn) => (chain = chain.then(fn).catch((e) => console.debug('bravemaxxing:', e && e.message)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = async () => (await chrome.storage.local.get({ port: 9333 })).port;
async function api(path, body) {
  const init = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined;
  const r = await fetch(`http://127.0.0.1:${await port()}${path}`, init);
  if (!r.ok) throw new Error(`relay ${r.status}`);
  return r.json();
}

const label = (agent) => agent.charAt(0).toUpperCase() + agent.slice(1);
const titleFor = (agent, st) => `${EMOJI[st] ? EMOJI[st] + ' ' : ''}${label(agent)}${MARK}`;
const agentOf = (title) => (title && title.endsWith(MARK) ? title.slice(0, -1).replace(/^(?:\u{1F916}|✅)\s*/u, '').toLowerCase() : null);
function colorFor(agent) {
  const set = (state && state.colors) || {};
  if (set[agent]) return set[agent];
  let h = 0; for (const c of agent) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

// tab id <-> the relay's id for it (CDP target id)
async function targets() {
  const list = await chrome.debugger.getTargets();
  const toTab = new Map(), toTarget = new Map();
  for (const t of list) if (t.type === 'page' && t.tabId != null) { toTab.set(t.id.toUpperCase(), t.tabId); toTarget.set(t.tabId, t.id.toUpperCase()); }
  return { toTab, toTarget };
}
const owned = (targetId) => { const t = state && state.tabs && state.tabs[targetId]; return t ? String(t.agent).toLowerCase() : null; };

async function refresh() { try { state = await api('/_ext/state'); } catch { /* relay down: keep the last state */ } }

// Make the tab strip match the relay: every agent tab in its agent's group; nothing else in those groups.
async function sync() {
  if (!state || state.enabled === false) return;
  const { toTab } = await targets();
  const tabs = new Map((await chrome.tabs.query({})).map((t) => [t.id, t]));
  const groups = await chrome.tabGroups.query({});
  const mine = groups.filter((g) => agentOf(g.title));

  const want = new Map(); // "agent|windowId" -> [tab]
  const agentTab = new Set();
  for (const [targetId, info] of Object.entries(state.tabs || {})) {
    const tab = tabs.get(toTab.get(targetId.toUpperCase()));
    if (!tab || tab.pinned) continue; // a pinned tab cannot be in a group
    agentTab.add(tab.id);
    const key = `${String(info.agent).toLowerCase()}|${tab.windowId}`;
    if (!want.has(key)) want.set(key, []);
    want.get(key).push(tab);
  }

  for (const [key, list] of want) {
    const [agent, win] = key.split('|');
    let group = mine.find((g) => agentOf(g.title) === agent && g.windowId === Number(win));
    const add = list.filter((t) => !group || t.groupId !== group.id).map((t) => t.id);
    let gid = group && group.id;
    if (add.length) {
      const front = (await chrome.tabs.query({ active: true, windowId: Number(win) }))[0];
      gid = await chrome.tabs.group(group ? { groupId: group.id, tabIds: add } : { tabIds: add, createProperties: { windowId: Number(win) } });
      const now = (await chrome.tabs.query({ active: true, windowId: Number(win) }))[0];
      if (front && now && now.id !== front.id && add.includes(now.id)) await chrome.tabs.update(front.id, { active: true }); // grouping must not change your view
    }
    const title = titleFor(agent, ((state.agents || {})[agent] || {}).state);
    const color = colorFor(agent);
    if (!group || group.title !== title || group.color !== color) await chrome.tabGroups.update(gid, { title, color });
  }

  // A tab sitting in an agent group without belonging to the agent (left over from a restart, or handed back
  // while this worker slept) leaves the group. Your own drags are handled in onGroupChange before this runs.
  if (pending) return; // a drag of yours is still being handled: decide after it
  const now = Date.now();
  const stale = [...tabs.values()].filter((t) => t.groupId !== -1 && mine.some((g) => g.id === t.groupId) && !agentTab.has(t.id)
    && now - (moved.get(t.id) || 0) > 3000).map((t) => t.id);
  if (stale.length) await chrome.tabs.ungroup(stale);
}

// Requests from the relay (state.todo). Each is done once and answered.
const handled = new Set();
async function work(list) {
  for (const t of list || []) {
    if (handled.has(t.id)) continue;
    handled.add(t.id);
    let result = {};
    try {
      if (t.op === 'create') { // a new agent tab: next to the agent's other tabs, never in a window of its own
        const groups = await chrome.tabGroups.query({});
        const group = groups.find((g) => agentOf(g.title) === String(t.agent).toLowerCase());
        let windowId = group && group.windowId;
        if (windowId == null) { const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null); windowId = w && w.id; }
        const front = async (win) => (await chrome.tabs.query({ active: true, windowId: win }))[0] || null;
        const before = windowId != null ? await front(windowId) : null;
        const tab = await chrome.tabs.create({ url: t.url || 'about:blank', active: !!t.active, ...(windowId != null ? { windowId } : {}) });
        let target = null;
        for (let i = 0; i < 40 && !target; i++) { target = (await targets()).toTarget.get(tab.id) || null; if (!target) await sleep(50); }
        result = { target };
        if (!t.active) keepView(tab, before); // some setups switch to a new tab anyway: put your view back
      } else if (t.op === 'activate') { // show a tab: inside Brave only, unless the window was asked for too
        const tabId = (await targets()).toTab.get(String(t.tab).toUpperCase());
        if (tabId != null) {
          const tab = await chrome.tabs.update(tabId, { active: true });
          if (t.window) await chrome.windows.update(tab.windowId, { focused: true });
          result = { ok: true };
        }
      } else if (t.op === 'where') { // which tab is in front of each window, and is Brave the focused app
        const { toTarget } = await targets();
        const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
        result = { windows: wins.map((w) => ({ focused: w.focused, active: toTarget.get((w.tabs.find((x) => x.active) || {}).id) || null })) };
      }
    } catch (e) { result = { error: String((e && e.message) || e) }; }
    try { await api('/_ext/event', { type: 'did', id: t.id, result }); } catch { /* relay gone: it times the request out */ }
  }
  if (handled.size > 500) handled.clear();
}

// A background tab must not end up in front. If it does within its first second and a half, restore what was there.
async function keepView(tab, before) {
  if (!before || before.id === tab.id) return;
  for (let i = 0; i < 15; i++) {
    const now = (await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []))[0];
    if (now && now.id === tab.id) { await chrome.tabs.update(before.id, { active: true }).catch(() => {}); return; }
    await sleep(100);
  }
}

// A tab changed group. If YOU did it, it is a hand-over or a take-back.
async function onGroupChange(tabId) {
  await refresh(); // decide on the relay's current truth, not a cached one
  if (!state || state.enabled === false) return;
  const { toTarget } = await targets();
  const targetId = toTarget.get(tabId);
  if (!targetId) return;
  let tab; try { tab = await chrome.tabs.get(tabId); } catch { return; } // closed meanwhile
  const groupId = tab.groupId; // where the tab is NOW (an older event may already be out of date)
  let group = null;
  if (groupId !== -1) { try { group = await chrome.tabGroups.get(groupId); } catch { /* group already gone */ } }
  const into = group ? agentOf(group.title) : null; // agent whose group the tab is in now (null: none of ours)
  let owner = owned(targetId);
  if (owner === into) return;                          // our own move, or nothing to do
  if (owner) {                                         // left its agent's group: you took it back
    await api('/_ext/event', { type: 'left', tab: targetId, agent: owner });
    owner = null;
  }
  if (into) {                                          // dropped into an agent's group: hand it over
    const r = await api('/_ext/event', { type: 'joined', tab: targetId, agent: into });
    if (!r.ok) await chrome.tabs.ungroup(tabId);       // on your wall list, or it belongs to another agent
  }
  await refresh();
  await sync();
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!('groupId' in change)) return;
  moved.set(tabId, Date.now()); pending++;
  run(() => onGroupChange(tabId).finally(() => { pending--; }));
});
chrome.tabs.onRemoved.addListener((tabId) => moved.delete(tabId));
chrome.tabs.onCreated.addListener(() => run(async () => { await refresh(); await sync(); }));
chrome.tabs.onAttached.addListener(() => run(async () => { await refresh(); await sync(); }));
chrome.alarms.onAlarm.addListener(() => { /* waking this worker is the point: the loop below restarts */ });
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('wake', { periodInMinutes: 0.5 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('wake', { periodInMinutes: 0.5 }));

// Long-poll the relay: it answers as soon as the registry changes (or after 20 s).
(async function loop() {
  for (;;) {
    try {
      const next = await api(`/_ext/state?from=ext&wait=1&rev=${state ? state.rev : 0}`);
      const changed = !state || next.rev !== state.rev;
      state = next;
      if ((next.todo || []).length) await work(next.todo); // answered at once, ahead of any queued tidy-up
      if (changed) run(sync);
    } catch {
      await sleep(3000); // relay not running: try again quietly
    }
    await chrome.runtime.getPlatformInfo(); // an extension API call keeps this worker from being put to sleep
  }
})();
