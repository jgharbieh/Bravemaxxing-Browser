---
name: agent-tab
description: Open a URL in an agent-only Brave container (own cookies and logins) without taking the user's focus, register it with the relay and bind agent-browser to it. Use when an agent needs its own tab that keeps a login between runs.
allowed-tools: Bash(agent-tab:*), Bash(agent-browser:*), Bash(tab-status:*)
---

# agent-tab

```bash
agent-tab <url>                          # container for the default agent (default: agent-claude)
agent-tab <url> --agent hermes           # container agent-hermes, tab owned by "hermes"
agent-tab <url> --container my-box       # explicit container name
agent-tab <url> --no-bind                # open and print the id only
```

Prints JSON such as `{"tab": "<32-hex id>", "space": "container:agent-claude", "via": "window.open", ...}`.
After a new tab, `agent-browser` may auto-follow it: re-bind with `agent-browser tab <id>` and check `agent-browser get url`
before acting.

Needs `brave-agent-ready` to have run first (exit code 2 means the relay is not reachable).

## What a container is

A Brave container is its own cookie jar inside the user's profile. The agent's logins stay separate from the user's.
The user signs in to sites inside the container by hand, once; the agent reuses the session. Container names come from
`containers` in `~/.bravemaxxing/config.json` (defaults: `claude` -> `agent-claude`, `hermes` -> `agent-hermes`;
any other agent name gets `agent-<name>`).

## The "open once" rule

Creating a tab inside a container needs Brave's `--container=<name>` launch switch. That launch can take window
focus **one time**, so it only happens when this agent has no live tab at all. Every later `agent-tab` call opens
from the agent's existing container tab: the relay sends a trusted Ctrl+Enter to a temporary link inside it, which is
Brave's own "open in background tab". It stays in the same container, takes no focus, and is registered to the same
agent. The output shows which path ran: `"via": "launch"` (first tab, `"launched": true`) or `"via": "window.open"`
(`"launched": false`, plus `"same_partition"`). `same_partition` is a no-focus container check: a marker cookie set in the
parent tab is visible in the new tab only if both share one cookie jar. On Windows the first launch also restores the
user's previous foreground window.

Plan for it: open the first container tab early, when the user is not typing, then reuse it.

## Fails closed

Because a launch takes focus, `agent-tab` refuses to launch whenever it is unsure:
- the relay's registry cannot be read, or the relay does not accept writes: exit 2;
- the agent has live tabs but none is registered to this container (for example a container tab opened by hand):
  exit 5. It prints the fix: `tab-status claim --agent <name> --tab <id> --space container:<name>`.

## Limits

- Exit codes: 1 no tab appeared, 2 relay down or unreadable, 3 URL is on the wall list, 5 live tabs but none in this
  container, 6 Brave not found (set `BRAVE_PATH`).
- Native browser dialogs and OS-level pop-ups are not routed.
- The container tab opens links by focusing a temporary link and sending Ctrl+Enter. A page that traps keyboard focus could
  interfere. If a tab does not appear within the timeout, exit code 1 says so.
