# Bravemaxxing-Browser

A Claude Code plugin that lets AI agents drive **your own Brave browser** without taking it over.

**Windows 10/11 only.** macOS and Linux are not supported yet. PRs welcome.

You keep working. The agent works in its own tabs, in the background, and you can see what it is doing.

## What you get

- **No focus stealing.** A small relay sits between the agent and Brave. It drops "bring to front" and "activate tab"
  commands, opens every new tab and popup in the background, and wakes frozen (Memory Saver) tabs without switching to them.
- **Agents only see agent tabs.** Your tabs are hidden from the agent. It cannot list, attach to, or act on them unless you
  hand one over on purpose (`tab-status claim`). A session that names its agent (see below) sees only that agent's tabs.
- **Status emoji in tab titles.** 🤖 the agent is acting now, ✅ the action finished (turn still running),
  ⏸️ the turn is over. The emoji clears after a full turn with no browser use, and survives navigation and reloads.
- **A wall around your password manager.** A list of extension ids and domains (default: Bitwarden) the agent may never
  open, script, or autofill from. Three layers: a command hook, the relay, and a watchdog that closes any agent tab that lands there.
- **Agent containers.** `agent-tab` opens a tab in a Brave container with its own cookies, so the agent's logins stay
  separate from yours. A launch can take focus once; after that, new tabs open from the existing container tab in the background
  ("open once"). `agent-tab` refuses to launch whenever it is unsure (it fails closed).

## Requirements

- **Windows 10 or 11**
- [Brave](https://brave.com) with remote debugging available (this plugin starts from "Brave on a CDP port")
- the [`agent-browser`](https://github.com/vercel-labs/agent-browser) CLI
- Node.js 18 or newer
- Python 3
- Claude Code
- Git Bash (Git for Windows): the plugin's `bin/` commands and the agent-name hook run in bash

**Tested with:** Windows 11, Brave 157.x, Claude Code 2.1.x, agent-browser 0.42. Nothing else was tested.
**macOS and Linux are not supported yet. PRs welcome.** The Brave relaunch script and the "restore your previous window" step in
`agent-tab` are Windows-specific. Containers need a Brave build that supports the `--container=<name>` switch. Chrome, Edge,
and other Chromium browsers were not tested and are not supported.

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
ships a `package-lock.json` for that). I could only test a local-folder install, which does not do it. If `brave-agent-ready`
says `ws` is missing, run `npm ci --omit=dev --prefix <plugin folder>` once, as it tells you.

**Claude Code only.** claude.ai and Cowork do not install a plugin that has a top-level `bin/` folder.

**After a plugin update, stop the old relay.** The relay is a plain background Node process started from the plugin's versioned
install folder. `brave-agent-ready` sees the port already answering and will not replace it, so end the old `node .../cdp-quiet.js`
process after an update and run `brave-agent-ready` again.

Then:

1. **Point agent-browser at the relay.** Create `~/.agent-browser/config.json` with `{"cdp": "9333"}`. Without it,
   `agent-browser` starts its own hidden Chromium and never touches Brave.
2. **Get Brave into CDP mode** once: start it with `--remote-debugging-port=9222`. On Windows,
   `BRAVE_RELAUNCH_OK=1 brave-agent-ready` does that for you (see the warning below).
3. **Start a Claude Code session and ask for browser work.** The `agent-browser-brave` skill runs `brave-agent-ready`
   (checks Brave, starts the relay) and tells the agent the rules.

**Agent label (automatic).** At session start a hook writes `AGENT_BROWSER_CDP_HEADERS={"X-Agent":"claude"}` into
`CLAUDE_ENV_FILE`, so every Bash command of the session sends that label to the relay. The relay then shows the session only
its own agent's tabs and refuses commands on anyone else's. The name is `BRAVEMAXXING_AGENT`, else `default_agent` from the
config (default `claude`). Your own value wins: if `AGENT_BROWSER_CDP_HEADERS` is already set (for example in your Claude Code
`settings.json` `env` block), the hook leaves it alone.
This needs Git Bash. Claude Code does not give `CLAUDE_ENV_FILE` to hooks that run in PowerShell, and it only applies the file
to Bash tool commands plus PowerShell tool commands whose lines are plain assignments, so the label may be missing there. The label
is optional hardening: an unnamed session still works, because the relay learns its agent from the first tab it acts on.
Manual fallback: set `AGENT_BROWSER_CDP_HEADERS` to `{"X-Agent":"claude"}` yourself, or connect to
`ws://127.0.0.1:9333/agent/<name>`.

**Check the hook is wired (harmless):** in a Claude Code session, ask the agent to run `agent-browser --version wall-test.invalid`.
The hook should deny it ("Agent wall ...") because `wall-test.invalid` is the built-in test sentinel. If it just prints a version,
the plugin hook is not active.

Commands the plugin puts on `PATH` for Claude's Bash tool: `brave-agent-ready`, `agent-tab`, `tab-status`.
Skills: `/bravemaxxing-browser:agent-browser-brave`, `/bravemaxxing-browser:brave-agent-ready`, `/bravemaxxing-browser:agent-tab`.

> **Warning: the relaunch.** `BRAVE_RELAUNCH_OK=1 brave-agent-ready` force-closes **every** Brave window, edits the
> `exit_type` field in each profile's `Preferences` file so Brave does not show a crash popup, and relaunches with your tabs
> restored. The new window takes focus. Without the variable, `brave-agent-ready` never restarts anything. Agents should never set it.

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
  "brave_path": null
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

The relay refuses to start if your config file is invalid JSON, so a typo can never silently drop the wall.

Environment variables (names only):

| Variable | Used by | Purpose |
|---|---|---|
| `BRAVE_PATH` | `agent-tab`, `brave-debug.ps1` | Brave binary |
| `BRAVE_RELAUNCH_OK` | `brave-agent-ready` | Set to `1` to allow the Windows relaunch |
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
                    │
                    ├─ drops bringToFront / activateTarget, forces background tabs
                    ├─ hides non-agent tabs, attach only to tabs in the registry
                    ├─ refuses navigate/eval toward walled ids and domains
                    ├─ keeps 🤖 / ✅ / ⏸️ in agent tab titles (injected keeper script)
                    └─ closes agent tabs that land on a walled site (watchdog)

Claude Code hooks (SessionStart / PreToolUse / PostToolUse / Stop)
   session-start  write the agent label (X-Agent) into CLAUDE_ENV_FILE
   pre   deny wall keywords and raw-port use, then status "working"
   post  status "done" (and "adopt" after `agent-browser tab new`)
   stop  status "turn-end"
```

- **Local only.** The relay answers only requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>` and which carry no
  browser `Origin` header, so a web page in your browser cannot talk to it. Status writes must be `application/json`.
- **Registry.** The relay owns a registry of agent tabs (`registry.json` in the state folder). A tab joins it when the agent
  creates it through the relay, when `agent-tab` registers it, or when you run `tab-status claim --tab <id>`.
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
  `same_partition` in `agent-tab`'s output reports whether the new tab really shares the cookie jar. This is the newest and
  least exercised part of the relay: I only ran it on the one Brave build above. If new tabs land outside the container,
  look here first.
- **No separate-profile mode.** Opening a tab in another Brave profile means a new window, which takes focus, so it is left out.
- **`bin/` commands are bash scripts.** They work from Claude's Bash tool (Git Bash), not from PowerShell.
- **Takeover needs the tab id.** `curl -s http://127.0.0.1:9333/json/list` lists tab ids; the list is not filtered.
- A closed tab leaves the registry. When the relay restarts, entries for tabs that no longer exist are dropped and the rest are re-attached.
- Tested with agent-browser 0.42; newer releases were not tested.

## Test

```bash
node tests/smoke.js
```

Runs on spare ports (19333, 19222) with a temp state folder and a fake CDP upstream. It never touches your Brave or a running relay.

## Hermes Agent

`plugins/bravemaxxing-browser/extras/hermes/` holds a Hermes Agent plugin with the same status emoji and wall tripwires. It is for
Hermes Agent users only. See its README.

## Uninstall

```bash
claude plugin uninstall bravemaxxing-browser@bravemaxxing-browser
claude plugin marketplace remove bravemaxxing-browser
```

Then stop the relay (it is a plain `node .../relay/cdp-quiet.js` process; end it in your task manager or with `kill`) and delete
`~/.bravemaxxing/` if you want the state and config gone. Remove `~/.agent-browser/config.json`'s `cdp` line if you added it.
Brave itself is never modified, except by the optional relaunch script's Preferences edit described above.

## Credits

The CDP-proxy approach was proposed by yangyaofei in
[vercel-labs/agent-browser#1247](https://github.com/vercel-labs/agent-browser/issues/1247). No code was copied; the credit is courtesy.

## License

MIT. See `LICENSE`. Copyright (c) 2026 Joseph Gharbieh ([jgharbieh](https://github.com/jgharbieh)).
