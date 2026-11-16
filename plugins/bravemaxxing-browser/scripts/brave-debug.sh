#!/usr/bin/env bash
# brave-debug.sh - put YOUR Brave into CDP mode in one motion (Linux).
#
#   - CDP already up on the port -> reuse, change nothing.
#   - Otherwise: ask Brave to quit (SIGTERM = a normal exit, the session is saved), wait for it to be
#     gone, then start it again with --remote-debugging-port and --restore-last-session.
#
# WARNING: this closes every Brave window (installed web apps included). The relaunched window takes focus.
# brave-agent-ready only calls this when BRAVE_RELAUNCH_OK=1 is set. Agents must never set it.
# Unlike the Windows script it never force-kills and never edits a Preferences file: if Brave does not
# quit on its own within 10 s it aborts and relaunches nothing, so a half-closed session is never touched.
#
# Usage:  brave-debug.sh [port] [--force]     (--force: restart even if CDP is already up)
# Env:    BRAVE_PATH = Brave launcher (else brave-browser / brave-browser-stable / brave on PATH)
set -u
PORT="${1:-9222}"; FORCE="${2:-}"
up() { curl -s -m 0.5 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; }

if [ "$FORCE" != "--force" ] && up; then
  echo "CDP already on $PORT - reusing your Brave, nothing restarted."; exit 0
fi

BRAVE="${BRAVE_PATH:-}"
if [ -z "$BRAVE" ]; then
  for c in brave-browser brave-browser-stable brave; do
    if command -v "$c" >/dev/null 2>&1; then BRAVE="$(command -v "$c")"; break; fi
  done
fi
[ -n "$BRAVE" ] && [ -x "$BRAVE" ] || { echo "Brave not found. Set BRAVE_PATH to the Brave launcher."; exit 1; }

# The browser's main process: no --type= argument (renderers, GPU and utility processes all carry one).
mains() { pgrep -u "$(id -u)" -x brave -a 2>/dev/null | grep -v -- '--type=' | awk '{print $1}'; }

for pid in $(mains); do kill -TERM "$pid" 2>/dev/null; done
for _ in $(seq 1 100); do [ -z "$(mains)" ] && break; sleep 0.1; done
if [ -n "$(mains)" ]; then
  echo "ABORTED: Brave did not quit within 10 s. Nothing relaunched; your session is untouched. Close Brave yourself and rerun."
  exit 1
fi

setsid -f "$BRAVE" "--remote-debugging-port=$PORT" --restore-last-session >/dev/null 2>&1 </dev/null
for _ in $(seq 1 200); do up && break; sleep 0.05; done
if up; then echo "Brave back with CDP on $PORT, tabs restored."; else echo "Brave started but CDP is NOT responding on $PORT."; exit 1; fi
