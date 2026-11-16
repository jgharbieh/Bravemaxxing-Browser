"""agent-tab: open a URL in your Brave inside an agent-only container, print the new tab's CDP id.

A container is a Brave container (own cookies and logins, same profile). Default name per agent comes
from config "containers" (claude -> agent-claude, hermes -> agent-hermes); any other agent gets
agent-<name>. Sign in to sites inside that container yourself, once; the agent reuses the session.
Taking over one of YOUR tabs is not done here: use `tab-status claim` (see the agent-browser-brave skill).

Mechanism: Brave's own --container=<name> switch hands the URL to the running Brave (no restart). The new
tab is found by diffing CDP targets through the cdp-quiet relay, registered with the relay (status emoji +
wall), then bound with `agent-browser tab <targetId>`.

OPEN ONCE: the brave launch may take window focus ONE time, when this agent has no live tab in the
container. After that, while the agent has a live registered tab in the container, every new tab comes
from it: the relay sends a trusted Ctrl+Enter to a temporary link inside it = Brave's own "open in
background tab", which keeps the container, takes no focus and switches no tab. On Windows the launcher
also restores your previous foreground window after the one launch.

FAIL CLOSED: a launch takes focus, so it happens ONLY when the registry is readable AND the relay
accepts writes AND this agent has no live tab at all. Unsure means refuse (exit 2 or 5), never launch blind.

Output: {"tab","space","agent","via":"launch"|"window.open","launched":bool,"same_partition":bool}
  same_partition = container check without focus: a marker cookie set in the parent container tab is
  visible in the new tab (same cookie jar = same container). A default-context tab gives false.

Usage:
  agent-tab <url>                                 # container for the default agent
  agent-tab <url> --agent hermes                  # container agent-hermes, tab owned by hermes
  agent-tab <url> --container my-container        # explicit container name
  agent-tab <url> --no-bind                       # open + print id only (another session binds its own)
Exit codes: 0 ok, 1 no tab appeared, 2 relay down/unreadable (never launches), 3 walled URL,
  5 the agent has live tabs but none registered to this container (never launches), 6 Brave not found.
Env: BRAVE_PATH (browser binary), BRAVEMAXXING_CONFIG (config file).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import kitconfig  # noqa: E402

CFG = kitconfig.load()
RELAY = kitconfig.relay_url(CFG)
FORBIDDEN = kitconfig.wall_regex(CFG)  # same rule as the relay's wall: this path launches Brave directly, so the relay can't refuse it


def registry():
    """The relay's tab registry, or None if it can't be read. None must never be treated as 'no tabs'."""
    try:
        with urllib.request.urlopen(RELAY + "/_agent/registry", timeout=3) as r:
            tabs = json.load(r).get("tabs")
        return tabs if isinstance(tabs, dict) else None
    except (OSError, ValueError):
        return None


def status(body: dict) -> dict:
    try:
        req = urllib.request.Request(RELAY + "/_agent/status", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=3) as r:
            return json.load(r)
    except OSError as e:
        return {"ok": False, "error": str(e)}


def same_partition(a_id: str, b_id: str):
    """Container check without focus: the relay compares the two tabs' storage (cdp-quiet `partition` cmd)."""
    return status({"cmd": "partition", "agent": "probe", "tab": a_id, "other": b_id}).get("same")


def wait_new(before: dict, agent: str, space: str, timeout: float):
    """The relay registers the new tab itself (it was told what to expect); wait for it to show up in the registry."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.4)
        reg = registry() or {}
        fresh = [i for i, t in reg.items() if i not in before and t.get("agent") == agent and t.get("space") == space]
        if fresh:
            return fresh[0]
    return None


# Foreground-window restore is Windows-only (other platforms: nothing to restore, the launch is still one-time).
def foreground() -> int:
    if sys.platform != "win32":
        return 0
    import ctypes
    return ctypes.windll.user32.GetForegroundWindow()


def restore_focus(hwnd: int) -> bool:
    if sys.platform != "win32":
        return True
    import ctypes
    user32 = ctypes.windll.user32
    if not hwnd or user32.GetForegroundWindow() == hwnd:
        return True
    # Windows only lets a process change the foreground window in limited cases; the Alt-key trick is the
    # known workaround for a background helper.
    user32.keybd_event(0x12, 0, 0, 0)
    user32.SetForegroundWindow(hwnd)
    user32.keybd_event(0x12, 0, 2, 0)
    time.sleep(0.2)
    return user32.GetForegroundWindow() == hwnd


def main() -> int:
    ap = argparse.ArgumentParser(prog="agent-tab")
    ap.add_argument("url")
    ap.add_argument("--container", help="Brave container name (default: from config 'containers' for the agent)")
    ap.add_argument("--no-bind", action="store_true")
    ap.add_argument("--agent", help="owner in the tab registry (default: the agent mapped to --container, else config default_agent)")
    ap.add_argument("--timeout", type=float, default=15)
    a = ap.parse_args()

    containers = CFG.get("containers") or {}
    if a.agent:
        agent = a.agent
    elif a.container:
        agent = next((k for k, v in containers.items() if v == a.container), CFG["default_agent"])
    else:
        agent = CFG["default_agent"]
    container = a.container or containers.get(agent) or f"agent-{agent}"

    if FORBIDDEN.search(a.url):
        print("agent-tab: blocked by agent wall: that site is on your wall list", file=sys.stderr)
        return 3

    try:
        urllib.request.urlopen(RELAY + "/json/version", timeout=5).close()
    except OSError:
        print("agent-tab: Brave CDP relay not reachable; run brave-agent-ready first", file=sys.stderr)
        return 2

    space = f"container:{container}"
    reg = registry()
    if reg is None:
        print("agent-tab: REFUSED - relay registry unreadable; not launching (a launch takes focus)", file=sys.stderr)
        return 2
    before = dict(reg)  # the registry only holds live tabs: the relay drops a tab the moment it closes
    probe = status({"cmd": "turn-end", "agent": "agenttab-probe"})
    if not probe.get("ok"):
        print(f"agent-tab: REFUSED - relay not accepting writes ({probe.get('error')}); not launching", file=sys.stderr)
        return 2
    mine = [i for i, t in reg.items() if t.get("agent") == agent and t.get("space") == space and i in before]
    # A live tab of this agent registered under another space (e.g. 'takeover') may share the container's
    # cookie jar: if the agent has any live tab, never launch blindly.
    if not mine:
        others = [i for i, t in reg.items() if t.get("agent") == agent and i in before]
        if others:
            print(f"agent-tab: REFUSED - {agent} has live tabs ({', '.join(o[:8] for o in others)}) but none registered "
                  f"as {space}. Re-register the container tab: tab-status claim --agent {agent} --tab <id> "
                  f"--space {space}. Not launching while unsure.", file=sys.stderr)
            return 5
    if mine:
        r = status({"cmd": "open", "agent": agent, "tab": mine[0], "url": a.url})
        if not r.get("ok"):
            print(f"agent-tab: open in container failed: {r.get('error')}", file=sys.stderr)
            return 1
        new_id = wait_new(before, agent, space, a.timeout)
        if not new_id:
            print(f"agent-tab: no new tab appeared within {a.timeout}s (from {mine[0]})", file=sys.stderr)
            return 1
        print(json.dumps({"tab": new_id, "space": space, "agent": agent, "via": "window.open", "from": mine[0],
                          "same_partition": same_partition(mine[0], new_id), "launched": False}))
        return 0

    brave = kitconfig.brave_binary(CFG)
    if not brave:
        print("agent-tab: Brave not found. Set BRAVE_PATH to the browser binary.", file=sys.stderr)
        return 6
    fg = foreground()
    r = status({"cmd": "expect", "agent": agent, "space": space, "url": a.url})  # the relay claims the tab when it appears
    if not r.get("ok"):
        print(f"agent-tab: REFUSED - relay would not expect the tab ({r.get('error')}); not launching", file=sys.stderr)
        return 2
    flags = 0x00000008 | 0x08000000 if sys.platform == "win32" else 0  # detached, no console window
    subprocess.Popen([brave, f"--container={container}", a.url], creationflags=flags, close_fds=True)

    new_id = wait_new(before, agent, space, a.timeout)
    focus_ok = restore_focus(fg)

    if not new_id:
        print(f"agent-tab: no new tab appeared within {a.timeout}s ({space})", file=sys.stderr)
        return 1

    ab = shutil.which("agent-browser")  # full path: on Windows it's a .cmd shim CreateProcess can't find bare
    if not a.no_bind and ab:
        # X-Agent names this agent to the relay, so the bound session sees only its own agent's tabs.
        env = {**os.environ, "AGENT_BROWSER_CDP_HEADERS": json.dumps({"X-Agent": agent})}
        subprocess.run([ab, "tab", new_id], capture_output=True, env=env)

    print(json.dumps({"tab": new_id, "space": space, "agent": agent, "via": "launch", "launched": True,
                      "focus_restored": focus_ok}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
