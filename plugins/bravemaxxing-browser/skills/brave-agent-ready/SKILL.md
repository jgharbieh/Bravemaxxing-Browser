---
name: brave-agent-ready
description: Check or start the pieces agent-browser needs for the user's own Brave: Brave's CDP port and the quiet relay. Use before any agent-browser work in Brave, or when agent-browser reports it cannot connect.
allowed-tools: Bash(brave-agent-ready:*)
---

# brave-agent-ready

One command, no prompts:

```bash
brave-agent-ready
```

It checks two ports (defaults; change them in `~/.bravemaxxing/config.json`):

| Port | What | If down |
|---|---|---|
| 9222 | Brave's own CDP port | Stops. Does **not** relaunch (see below). |
| 9333 | The cdp-quiet relay | Starts it in the background. |

Output on success: `Brave ready (CDP 9222, quiet relay 9333).`

## When Brave's CDP port is down

Do not restart Brave yourself. A restart closes every Brave window, rewrites each profile's exit state, and raises
the new window, which takes the user's focus. Tell the user to run this themselves:

```bash
BRAVE_RELAUNCH_OK=1 brave-agent-ready      # Windows: relaunches Brave with CDP on and tabs restored
```

Without it, the user can also start Brave once by hand with `--remote-debugging-port=9222`. This plugin supports Windows only.

## Other failures

- `The relay needs the 'ws' package`: run the `npm ci --omit=dev --prefix <plugin dir>` command it prints (needed when
  the plugin is loaded from a local folder; a normal marketplace install does it for you).
- `Node.js not found`: install Node 18 or newer.
- `relay failed to start`: run the `node .../relay/cdp-quiet.js` command it prints to see the error. An invalid
  `~/.bravemaxxing/config.json` stops the relay on purpose, so a typo can never silently drop the wall.
- Port clash on 9333: set `"ports": {"relay": <free port>}` in the config.
