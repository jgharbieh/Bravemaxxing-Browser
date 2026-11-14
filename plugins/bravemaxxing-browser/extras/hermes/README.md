# Hermes Agent extra

**For Hermes Agent users only.** Claude Code users do not need this folder:
the Claude Code plugin already registers its own hooks.

`bravemaxxing-hooks` is the Hermes counterpart of the Claude Code hook. It gives Hermes the same behaviour:

- 🤖 / ✅ / ⏸️ status emoji on the tabs Hermes owns (via `scripts/tab-status.py` and the relay)
- the wall, layer 1: blocks browser commands that name a walled extension id or keyword, and any raw-CDP-port use

## Install

1. Install and run the rest of bravemaxxing-browser first (relay, `agent-browser` pointed at the relay).
2. Copy `bravemaxxing-hooks/` into your Hermes plugins folder.
3. Set `BRAVEMAXXING_HOME` for the Hermes process to the **plugin folder** of this kit, the one that contains
   `lib/` and `scripts/` (for a marketplace install that is under `~/.claude/plugins/cache/...`; for a git clone it is
   `plugins/bravemaxxing-browser`). A marketplace cache path changes with each plugin version, so a clone is easier to point at.
4. Optional: `BRAVEMAXXING_AGENT` (default `hermes`) is the owner name in the tab registry.

It reads the same config as the Claude Code plugin (`~/.bravemaxxing/config.json` or `$BRAVEMAXXING_CONFIG`).
Use `agent-tab <url> --agent hermes` so Hermes gets its own container (default name `agent-hermes`).

If `BRAVEMAXXING_HOME` is unset or wrong, the plugin stays inert (no status, no tripwires) and never breaks a turn.
This is a generalised copy of a plugin that ran inside Hermes. The generalised version was only import- and
logic-tested outside Hermes (see the repo's test notes), not run inside a live Hermes. It uses Hermes' `pre_tool_call`,
`post_tool_call` and `post_llm_call` hooks; if your Hermes version names them differently, adjust `register()`.
