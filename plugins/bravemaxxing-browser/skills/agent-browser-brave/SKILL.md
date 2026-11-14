---
name: agent-browser-brave
description: Drive the user's own visible Brave browser with the agent-browser CLI through the quiet relay, so automation never steals focus and never touches the user's tabs. Use when asked to browse, click, fill forms, scrape, screenshot or test a web app in the user's real browser, or "watch it happen".
allowed-tools: Bash(agent-browser:*), Bash(brave-agent-ready:*), Bash(agent-tab:*), Bash(tab-status:*), Bash(curl -s http://127.0.0.1:9333/json/list)
---

# agent-browser on your own Brave

`agent-browser` drives a real, visible Brave through the Chrome DevTools Protocol (CDP). This skill sets it up
so that the agent works in **its own tabs**, in the **background**, with a **status emoji** in each tab title,
and with a **wall** around the password manager. The user keeps working in their own tabs and sees nothing jump.

Requirements: Brave, the `agent-browser` CLI, Node.js, Python 3. Run commands from the Bash tool.

## Step 1: make sure Brave and the relay are up

```bash
brave-agent-ready
```

- Brave CDP already on (default port 9222): reuses it, starts the relay if it is not running (about 0.1 s).
- Brave not in CDP mode: it stops and tells you what to ask the user. **Never relaunch Brave yourself.** A relaunch
  closes every Brave window and takes focus. The user opts in by running `BRAVE_RELAUNCH_OK=1 brave-agent-ready` (Windows).
- If it prints a hint about `~/.agent-browser/config.json`, tell the user to add `{"cdp": "9333"}` (the relay port).
  Without it, `agent-browser` starts its own hidden Chromium instead of using Brave.

## Step 2: use plain agent-browser, always through the relay

Never pass `--cdp 9222` (Brave's raw port). The hook denies it: it skips the focus rule and the wall.

What the relay does for you, with nothing to add:
- `Page.bringToFront` / `Target.activateTarget` are dropped; frozen (Memory Saver) tabs are woken without activation.
- New tabs and popups open in the background.
- **Agents only see agent-owned tabs.** `agent-browser tab` lists only yours; a session can never land on the user's tab.
- **Identity (optional hardening).** If `AGENT_BROWSER_CDP_HEADERS='{"X-Agent":"claude"}'` is set (Claude Code's
  `settings.json` `env` block is the easy place), the relay shows that session ONLY the tabs of agent `claude` and refuses
  commands on any other agent's tabs. Without it, the session learns its agent from the first tab it acts on.
- The tab title carries a status emoji: 🤖 acting now, ✅ action done (turn still running), ⏸️ turn over. It is
  cleared after one full turn with no browser use. Do not set titles by hand.

## Step 3: pick your tab lane

| Task | Do this |
|---|---|
| Independent task ("go scrape X", "test this flow") | Open **your own** tab: `agent-tab <url>` (container, keeps logins) or `agent-browser tab new <url>` (plain background tab). |
| "Take over this / look at my screen / fill the form I have open" | Takeover (explicit asks only), see below. |
| Unclear which one | Ask one short question: "Your current tab, or my own?" |

**Own-lane (default).** Work only in tabs you created. If the user opens a tab, never drive it. After any
`agent-browser tab <id>` bind, run `agent-browser get url` and abort if it is not the page you expect: a failed bind
silently leaves the session on whatever tab it held before.

**Takeover (explicit only).**
1. Say one line: "Taking over your tab (<title>)."
2. Find its id: `curl -s http://127.0.0.1:9333/json/list` (page entries, 32-hex `id`).
3. Claim it so the relay lets you see and drive it: `tab-status claim --tab <id>`
4. `agent-browser tab <id>`, then `agent-browser get url` to confirm.
5. When done: "Done, your tab is yours." Do not touch it again unless re-pointed at it.

## Everyday commands

```bash
agent-browser snapshot -i            # interactive elements with @eN refs
agent-browser click @e3
agent-browser fill @e2 "text"
agent-browser screenshot out.png
```

The CLI ships its own up-to-date reference: `agent-browser skills get core` (add `--full` for everything).

## The wall

The user lists walled extensions and sites in `~/.bravemaxxing/config.json` (default: Bitwarden's extension and vault
domains). Three layers enforce it:
1. A hook denies `agent-browser` / `agent-tab` commands (tool name in command position) that name a walled extension id or
   keyword, and any raw-port `--cdp` use.
2. The relay refuses CDP navigate/eval toward walled ids and domains, and refuses attach to a walled tab.
3. The relay closes any agent-owned tab whose URL lands on a walled site (log: `wall.log` in the state dir).

Never open, script, or click the autofill pop-up of a walled extension. The user signs in by hand; you reuse the
session. The wall is a tripwire for cooperating agents, not a security boundary.

## Pitfalls

1. Bind, then verify (`get url`) before acting. agent-browser also auto-follows a newly opened tab: re-bind and check
   `get url` after anything that opens one.
2. Plain `agent-browser open <url>` with no relay config launches a hidden Chromium the user cannot see.
3. `agent-browser close --all` only closes agent-browser's own sessions, not Brave.
4. Native browser dialogs (alert/confirm/prompt, file pickers, permission prompts) are not handled by the relay and
   can block a tab. Tell the user instead of retrying.
5. After Brave restarts, CDP drops: run `brave-agent-ready` again.
6. Bot checks (CAPTCHA, "verify you are human"): stop and tell the user. Never try to solve them.
