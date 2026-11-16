# Bravemaxxing-Browser

A Claude Code plugin that lets AI agents drive **your own Brave browser** without taking it over.

**Windows 10/11 and Linux.** macOS is not supported yet. PRs welcome.

You keep working. The agent works in its own tabs, in the background, and you can see what it is doing.

## What you get

- **Your attention moves only by choice.** A small relay sits between the agent and Brave. By default the agent is
  *quiet*: "bring to front" and "activate tab" commands are dropped, every new tab and popup opens in the background, and
  frozen (Memory Saver) tabs are woken without switching to them. When you work on something *together*, the agent says
  so and your view follows the tab it is on. See [Focus](#focus).
- **A tab group per agent.** Each agent's tabs sit in one tab group named after it, in your window. Collapse it and
  they are out of your way. The group title shows what the agent is doing (🤖 working, ✅ action done, no emoji = idle).
- **Hand a tab over by dragging it.** Drag one of your tabs into an agent's group and the agent can see and drive it.
  Drag it out and it is yours again: the agent can no longer see it, attach to it, or close it.
- **Agents only see agent tabs.** Your tabs are hidden from the agent. It cannot list, attach to, act on or close them
  unless you hand one over. A session that names its agent (see below) sees only that agent's tabs.
- **Status emoji in tab titles.** 🤖 the agent is acting now, ✅ the action finished (turn still running),
  ⏸️ the turn is over. The emoji clears after a full turn with no browser use, and survives navigation and reloads.
- **A wall around your password manager.** A list of extension ids and domains (default: Bitwarden) the agent may never
  open, script, or autofill from. Three layers: a command hook, the relay, and a watchdog that closes any agent tab that lands there.
- **Agent containers (optional).** `agent-tab` opens a tab in a Brave container with its own cookies, so the agent's logins
  stay separate from yours. A launch can take focus once; after that, new tabs open from the existing container tab in the
  background ("open once"). `agent-tab` refuses to launch whenever it is unsure (it fails closed).
- **A skill that teaches driving, not a workflow.** The `agent-browser-brave` skill tells the agent how to act on pages
  reliably and how to stay out of your way. Where it works is your call, in plain words: its own tabs, a tab you hand it,
  or a separate hidden browser.

## Requirements

- **Windows 10 or 11, or Linux**
- [Brave](https://brave.com) with remote debugging available (this plugin starts from "Brave on a CDP port")
- the [`agent-browser`](https://github.com/vercel-labs/agent-browser) CLI
- Node.js 18 or newer
- Python 3
- Claude Code
- Windows only: Git Bash (Git for Windows). The plugin's `bin/` commands and the agent-name hook run in bash.

**Tested with:**
- Windows 11, Brave 157.x, Claude Code 2.1.x, agent-browser 0.42 (version 0.1.0 of this plugin).
- Fedora Linux 45 (GNOME, Wayland), Brave 157.x, agent-browser 0.43: relay, status emoji, agent-only tabs, the Linux
  relaunch script.
- Tab groups: `tests/live-groups.js` against Chrome for Testing 145 (headless). Not yet run in Brave on Windows.

Nothing else was tested. Containers need a Brave build that supports the `--container=<name>` switch and were not
re-tested on Linux. Chrome, Edge, and other Chromium browsers are not supported.

## Install

```text
/plugin marketplace add jgharbieh/Bravemaxxing-Browser
/plugin install bravemaxxing-browser@bravemaxxing-browser
```

or from the shell:

```bash
claude plugin marketplace add jgharbieh/Bravemaxxing-Browser
claude plugin install bravemaxxing-browser@bravemaxxing-browser
```

Claude Code is supposed to download the relay's one npm dependency (`ws`) when it installs from a marketplace (the plugin
ships a `package-lock.json` for that). If `brave-agent-ready` says `ws` is missing, run
`npm ci --omit=dev --prefix <plugin folder>` once, as it tells you.

**Claude Code only.** claude.ai and Cowork do not install a plugin that has a top-level `bin/` folder.

**After a plugin update, stop the old relay.** The relay is a plain background Node process started from the plugin's versioned
install folder. `brave-agent-ready` sees the port already answering and will not replace it, so end the old `node .../cdp-quiet.js`
process after an update and run `brave-agent-ready` again.

Then:

1. **Point agent-browser at the relay.** Create `~/.agent-browser/config.json` with `{"cdp": "9333"}`. Without it,
   `agent-browser` starts its own hidden Chromium and never touches Brave.
2. **Get Brave into CDP mode** once: start it with `--remote-debugging-port=9222`.
   `BRAVE_RELAUNCH_OK=1 brave-agent-ready` does that for you on Windows and Linux (see the warning below).
3. **Load the tab-group extension** (optional, but it is what keeps agent tabs tidy). In Brave open `brave://extensions`,
   turn on **Developer mode**, click **Load unpacked** and pick the plugin's `extension/` folder. It needs no setup and
   talks only to the relay on `127.0.0.1`.
4. **Start a Claude Code session and ask for browser work.** The `agent-browser-brave` skill runs `brave-agent-ready`
   (checks Brave, starts the relay) and tells the agent how to drive.

**Agent label (automatic).** At session start a hook writes `AGENT_BROWSER_CDP_HEADERS={"X-Agent":"claude"}` into
`CLAUDE_ENV_FILE`, so every Bash command of the session sends that label to the relay. The relay then shows the session only
its own agent's tabs and refuses commands on anyone else's. The name is `BRAVEMAXXING_AGENT`, else `default_agent` from the
config (default `claude`). Your own value wins: if `AGENT_BROWSER_CDP_HEADERS` is already set (for example in your Claude Code
`settings.json` `env` block), the hook leaves it alone.
On Windows this needs Git Bash: Claude Code does not give `CLAUDE_ENV_FILE` to hooks that run in PowerShell. The label
is optional hardening: an unnamed session still works, because the relay learns its agent from the first tab it acts on.
Manual fallback: set `AGENT_BROWSER_CDP_HEADERS` to `{"X-Agent":"claude"}` yourself, or connect to
`ws://127.0.0.1:9333/agent/<name>`.

**Check the hook is wired (harmless):** in a Claude Code session, ask the agent to run `agent-browser --version wall-test.invalid`.
The hook should deny it ("Agent wall ...") because `wall-test.invalid` is the built-in test sentinel. If it just prints a version,
the plugin hook is not active.

Commands the plugin puts on `PATH` for Claude's Bash tool: `brave-agent-ready`, `agent-tab`, `tab-status`.
Skills: `/bravemaxxing-browser:agent-browser-brave`, `/bravemaxxing-browser:brave-agent-ready`, `/bravemaxxing-browser:agent-tab`.

> **Warning: the relaunch.** `BRAVE_RELAUNCH_OK=1 brave-agent-ready` closes **every** Brave window and relaunches Brave with
> your tabs restored. The new window takes focus. By default `brave-agent-ready` never relaunches a running Brave without
> that variable, and agents should never set it. If you would rather have it happen on its own whenever the port is down,
> set `"relaunch": "allow"` in your config.
> On Windows it force-closes Brave and edits the `exit_type` field in each profile's `Preferences` file so Brave does not show
> a crash popup. On Linux it asks Brave to quit normally, edits nothing, and gives up without relaunching if Brave has not
> quit within 10 seconds.

## Focus

Taking your attention is a decision the agent makes from what you asked for, never a side effect.

| Mode | For | What the agent's browser commands do |
|---|---|---|
| `quiet` (default) | The agent's own work | New tabs open behind yours. Nothing is switched, nothing is raised. |
| `together` | "Walk me through this", work across several tabs with you | The tab the agent works on becomes the visible tab and new tabs open in front. Brave itself is not raised over your other apps. |

- The agent sets it per task: `tab-status focus --mode together`, and `--mode quiet` when the shared part is over.
  `together` also lapses after 30 minutes without a browser command.
- **Two levels, kept apart.** `tab-status surface --tab <id>` switches to one of the agent's tabs inside Brave.
  Adding `--window true` also raises Brave over your other windows. Both are refused in quiet mode.
- **Bot checks are your call.** `tab-status surface --tab <id> --reason captcha` works only if you allowed it:
  for good with `"focus": {"captcha": "allow"}` in the config, or per task when the agent asks and then runs
  `tab-status focus --captcha allow`. `"captcha": "never"` shuts it off. The agent never solves a bot check.
- **The agent can look first.** `tab-status where` tells it whether Brave is the focused app and whether the tab in
  front is one of its own. It is never told anything about a tab of yours.

These need the tab-group extension: only an extension can switch a tab without raising the window. Without it,
`surface` falls back to the browser's own activate call, which may raise the window.

## Tab groups

With the extension loaded, the relay's list of agent tabs is mirrored into tab groups:

- A tab an agent opens joins the group named after the agent (one group per agent per window). It is never activated.
- **You drag a tab into the group:** it is handed to that agent. A tab on your wall list is refused and drops back out.
- **You drag a tab out of the group:** you took it back. The same happens from the command line with
  `tab-status release --tab <id>`.
- **Hand one over by naming it:** `tab-status claim --match "words from its title or URL"` gives the agent that
  one tab, and only if exactly one tab matches. The agent is never shown a list of your tabs.
- When the agent's last tab closes, the group goes with it. After a Brave restart, leftover agent groups are dissolved
  (the tabs stay; they are just no longer agent tabs).

The extension recognises its own groups by an invisible marker in the title, never by name, so a group you name
"Claude" yourself is left alone. It asks for the `debugger` permission for one read-only call that maps a tab to the id
the relay knows it by; it never attaches to a tab. Turn the whole feature off with `"groups": {"enabled": false}`.

## Configure

Defaults ship in `config/default.json`. Override in `~/.bravemaxxing/config.json` (or the file named by
`BRAVEMAXXING_CONFIG`). Object keys merge one level deep. **A list you set replaces the default list**, so you can drop the
default Bitwarden entry.

```json
{
  "ports": { "upstream": 9222, "relay": 9333 },
  "wall": {
    "extension_ids": ["nngceckbapebfimnlniiiahkandclblb"],
    "domains": ["bitwarden.com", "bitwarden.eu"],
    "keywords": ["bitwarden"]
  },
  "default_agent": "claude",
  "containers": { "claude": "agent-claude", "hermes": "agent-hermes" },
  "brave_path": null,
  "groups": {
    "enabled": true,
    "extension_ids": ["djbahbjcpjgdbjbknmhajbdhademgamc"],
    "colors": { "claude": "orange", "hermes": "purple" }
  },
  "focus": { "captcha": "ask" },
  "relaunch": "ask"
}
```

| Key | Meaning |
|---|---|
| `ports.upstream` | Brave's real CDP port. |
| `ports.relay` | The relay's port. Agents connect here. |
| `wall.extension_ids` | Extension ids. Any page of the extension is walled. |
| `wall.domains` | Domains. Subdomains are walled too. |
| `wall.keywords` | Words that make the **command hook** deny a browser command (layer 1 only). |
| `default_agent` | Owner name for tabs when `--agent` is not given. |
| `containers` | Agent name to Brave container name. Any other agent gets `agent-<name>`. |
| `brave_path` | Path to the Brave binary. `BRAVE_PATH` overrides it; otherwise standard install paths are tried. |
| `groups.enabled` | `false` turns tab groups off. |
| `groups.extension_ids` | Extension ids allowed to talk to the relay's `/_ext/` endpoint. The shipped extension has a fixed id. |
| `groups.colors` | Agent name to tab-group colour (`grey`, `blue`, `red`, `yellow`, `green`, `pink`, `purple`, `cyan`, `orange`). Others get one picked from the name. |
| `focus.captcha` | May an agent bring a tab forward when a site shows a bot check? `ask` (default: only after you say yes for that task), `allow`, or `never`. |
| `relaunch` | May `brave-agent-ready` relaunch a running Brave to turn its CDP port on? `ask` (default: only when you run it with `BRAVE_RELAUNCH_OK=1`), `allow`, or `never`. A Brave that is not running is simply started with the port. |

If the relay runs on another port, tell the extension: on its service-worker console run
`chrome.storage.local.set({ port: <relay port> })`.

The relay refuses to start if your config file is invalid JSON, so a typo can never silently drop the wall.

Environment variables (names only):

| Variable | Used by | Purpose |
|---|---|---|
| `BRAVE_PATH` | `agent-tab`, `brave-debug.ps1`, `brave-debug.sh` | Brave binary |
| `BRAVE_RELAUNCH_OK` | `brave-agent-ready` | Set to `1` to allow the relaunch |
| `BRAVEMAXXING_CONFIG` | all | Config file path |
| `BRAVEMAXXING_STATE` | relay | State folder (default `~/.bravemaxxing/state`: `registry.json`, `wall.log`) |
| `BRAVEMAXXING_AGENT` | hook, Hermes extra | Agent name the hook reports as and labels the session with (default: config `default_agent`, i.e. `claude`; Hermes extra: `hermes`) |
| `BRAVEMAXXING_HOME` | Hermes extra | Plugin folder, so the Hermes plugin finds `lib/` and `scripts/` |
| `CDP_QUIET_PORT`, `CDP_UPSTREAM_PORT` | all | Override the two ports (useful for tests) |
| `CDP_QUIET_DEBUG`, `CDP_QUIET_TRACE` | relay | Verbose log / per-command trace file |

To prove the wall works without touching a real site, use the built-in test sentinel `wall-test.invalid`.

## How it works

```text
agent-browser ──► relay :9333 ──► Brave :9222
                    │   ▲
                    │   └── tab-group extension (long-poll /_ext/state, reports your drags)
                    ├─ quiet mode: drops bringToFront / activateTarget, forces background tabs
                    ├─ together mode: the agent's working tab becomes the visible tab (tab level only)
                    ├─ hides non-agent tabs; commands that name a non-agent tab never reach Brave
                    ├─ refuses navigate/eval toward walled ids and domains
                    ├─ keeps 🤖 / ✅ / ⏸️ in agent tab titles (injected keeper script)
                    ├─ closes agent tabs that land on a walled site (watchdog)
                    └─ closes blank tabs a finished session left behind

Claude Code hooks (SessionStart / PreToolUse / PostToolUse / Stop)
   session-start  write the agent label (X-Agent) into CLAUDE_ENV_FILE
   pre   deny wall keywords and raw-port use, then status "working"
   post  status "done" (and "adopt" after `agent-browser tab new`)
   stop  status "turn-end"
```

- **Local only.** The relay answers only requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>`. A request that
  carries a browser `Origin` is refused, so a web page in your browser cannot talk to it. The one exception is the
  tab-group extension's own origin, and only on `/_ext/`. Status writes must be `application/json`.
- **Default deny.** An agent can attach only to tabs in the registry, and any command that names another tab
  (`Target.closeTarget`, a session on a tab that was handed back, and so on) is answered with an error by the relay.
  Brave's plain-HTTP tab endpoints are covered too: `/json/list` shows only agent tabs (a caller that sends `X-Agent`
  sees only its own), `/json/activate` and `/json/new` are always refused (they take focus), `/json/close` only works
  on an agent tab. `tab-status close` closes the tabs an agent opened itself, never one you handed over.
- **Registry.** The relay owns a registry of agent tabs (`registry.json` in the state folder). A tab joins it when the agent
  creates it through the relay, when `agent-tab` registers it, when you drag it into an agent's group, or when you run
  `tab-status claim --tab <id>`. It leaves when it closes, when you drag it out, or with `tab-status release --tab <id>`.
- **Status.** The hook posts status to the relay (`/_agent/status`); `tab-status` is the same call from the command line.
- **Open once.** `agent-tab` finds an existing tab of the same agent in the same container and asks the relay to open the URL
  from it (a trusted Ctrl+Enter on a temporary link = Brave's own "open in background tab": same container, same owner, no
  focus). It only launches Brave with `--container=` when the agent has no live tab at all. If the registry is unreadable, the
  relay refuses writes, or the agent has live tabs registered elsewhere, it refuses instead of launching (exit 2 or 5).

## Limits

- **The wall is a tripwire for cooperating agents, not a security boundary.** Brave's raw CDP port (9222) stays open to any
  local process that connects to it directly, and the command hook only reads command text. Do not rely on it against hostile code.
- **Native browser dialogs** (alert/confirm/prompt, file pickers, permission prompts, OS dialogs) are not handled and can
  block a tab until you dismiss them.
- **Container tabs and popups.** Tabs opened from a container tab use a trusted Ctrl+Enter on a temporary link so Brave keeps them in the container;
  `same_partition` in `agent-tab`'s output reports whether the new tab really shares the cookie jar. This is the least
  exercised part of the relay: it was only run on one Brave build on Windows. If new tabs land outside the container, look here first.
- **Tab groups need the extension**, and a pinned tab cannot be in a group, so a pinned tab you hand over with
  `tab-status claim` stays where it is.
- **Background tabs on Linux need the extension.** Brave on Linux can bring a tab made through CDP to the front even when
  asked for a background tab. With the extension running, the relay has it open agent tabs instead, which stays in the
  background. Seen on one machine: the first tab of a session still came to the front once; later tabs did not.
- **Raising the window is best effort.** Whether `surface --window true` really puts Brave on top is up to your desktop
  (Wayland compositors may show a "window is ready" notice instead).
- **No separate-profile mode.** Opening a tab in another Brave profile means a new window, which takes focus, so it is left out.
- **`bin/` commands are bash scripts.** On Windows they work from Claude's Bash tool (Git Bash), not from PowerShell.
- A closed tab leaves the registry. When the relay restarts, entries for tabs that no longer exist are dropped and the rest are re-attached.
- The relaunch is the only way this plugin turns Brave's CDP port on. After a reboot, or after you start Brave yourself,
  the port is off again until you relaunch.

## Test

```bash
node tests/smoke.js
CHROME_BIN=/path/to/chrome node tests/live-groups.js     # optional: tab groups in a real, throwaway Chromium
```

`smoke.js` runs on spare ports (19333, 19222) with a temp state folder and a fake CDP upstream. `live-groups.js` starts a
headless Chromium with a temp profile and loads the extension into it. Neither touches your Brave or a running relay.

## Hermes Agent

`plugins/bravemaxxing-browser/extras/hermes/` holds a Hermes Agent plugin with the same status emoji and wall tripwires. It is for
Hermes Agent users only. See its README.

## Uninstall

```bash
claude plugin uninstall bravemaxxing-browser@bravemaxxing-browser
claude plugin marketplace remove bravemaxxing-browser
```

Then stop the relay (it is a plain `node .../relay/cdp-quiet.js` process; end it in your task manager or with `kill`), remove
the extension on `brave://extensions`, and delete `~/.bravemaxxing/` if you want the state and config gone. Remove
`~/.agent-browser/config.json`'s `cdp` line if you added it. Brave itself is never modified, except by the Windows relaunch
script's Preferences edit described above.

## Credits

The CDP-proxy approach was proposed by yangyaofei in
[vercel-labs/agent-browser#1247](https://github.com/vercel-labs/agent-browser/issues/1247). No code was copied; the credit is courtesy.

## License

MIT. See `LICENSE`. Copyright (c) 2026 Joseph Gharbieh ([jgharbieh](https://github.com/jgharbieh)).
