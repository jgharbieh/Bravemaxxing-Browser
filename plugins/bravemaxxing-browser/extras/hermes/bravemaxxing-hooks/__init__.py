"""Hermes Agent side of the bravemaxxing-browser hooks (for Hermes Agent users only).

Status emoji on agent-owned tabs, kept by the cdp-quiet relay via scripts/tab-status.py:
  pre_tool_call  (browser command)  -> tab-status working   (robot)
  post_tool_call (browser command)  -> tab-status done      (check mark)
  post_llm_call  (every turn end)   -> tab-status turn-end  (pause; clears tabs idle a full turn)

Tripwires (layer 1 of the wall), pre_tool_call blocks:
  - a browser-ish command naming a walled extension id or keyword (config: wall.extension_ids / wall.keywords)
  - anything driving Brave on its raw CDP port (it steals focus and skips the wall)
Read-only `curl .../<raw port>/json/version` probes stay allowed.

Setup: set BRAVEMAXXING_HOME to the bravemaxxing-browser PLUGIN folder (the one that contains lib/ and scripts/).
Config is the same ~/.bravemaxxing/config.json (or $BRAVEMAXXING_CONFIG) the Claude Code plugin reads.
A tripwire for cooperating agents, not a security boundary.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

_HOME = os.environ.get("BRAVEMAXXING_HOME", "")
_SCRIPT = str(Path(_HOME) / "scripts" / "tab-status.py") if _HOME else ""
_AGENT = os.environ.get("BRAVEMAXXING_AGENT", "hermes")
_HEADLESS_CFG = "agent-browser-headless.json"  # a separate hidden Chromium config: never Brave, never reported

_KIT = None
if _HOME and (Path(_HOME) / "lib" / "kitconfig.py").exists():
    sys.path.insert(0, str(Path(_HOME) / "lib"))
    try:
        import kitconfig as _KIT  # type: ignore[no-redef]
    except Exception:  # config problems must never break a Hermes turn
        _KIT = None

if _KIT:
    _CFG = _KIT.load()
    _RAW = str(_CFG["ports"]["upstream"])
    _RELAY = str(_CFG["ports"]["relay"])
    _w = _CFG.get("wall") or {}
    _words = [re.escape(x) for x in (_w.get("extension_ids") or []) + (_w.get("keywords") or []) if isinstance(x, str) and x.strip()]
    _WALL_RE = re.compile("|".join(_words + [r"wall-test\.invalid"]), re.I)
else:  # kit not found: status/tripwires inert, defaults for the regexes below
    _RAW, _RELAY = "9222", "9333"
    _WALL_RE = re.compile(r"wall-test\.invalid", re.I)

_BROWSER_RE = re.compile(r"\bagent-browser\b|\bagent-tab\b|\bbrave-agent-ready\b")
_CDPISH_RE = re.compile(r"agent-browser|agent-tab|cdp|devtools|:%s|:%s|playwright|puppeteer" % (_RELAY, _RAW), re.I)
_RAW_RE = re.compile(
    r"--cdp[ =]+(?:\S*:)?%s\b|wss?://[^\s'\"]*:%s/|cdp_url[^\n]*%s|BROWSER_CDP_URL[^\n]*%s" % ((_RAW,) * 4)
)
_PROBE_RE = re.compile(r"^\s*curl\b[^|;&]*:%s/json/version\b" % _RAW)
_TABNEW_RE = re.compile(r"\bagent-browser\b[^\n|;&]*\btab\s+new\b")


def _command(tool_name, args) -> str:
    if not isinstance(args, dict):
        return ""
    if tool_name == "terminal":
        return str(args.get("command") or "")
    if tool_name in ("execute_code", "browser_exec"):
        return str(args.get("code") or "")
    return ""


def _is_brave_work(tool_name, args) -> bool:
    cmd = _command(tool_name, args)
    return bool(cmd) and bool(_BROWSER_RE.search(cmd)) and _HEADLESS_CFG not in cmd


def _status(cmd: str) -> None:
    """Fire-and-forget; must never block or break a turn."""
    if not _SCRIPT or not os.path.exists(_SCRIPT):
        return
    try:
        kw: dict = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "stdin": subprocess.DEVNULL}
        if os.name == "nt":
            kw["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
        subprocess.Popen([sys.executable, "-I", _SCRIPT, cmd, "--agent", _AGENT], **kw)
    except Exception:
        pass


def _adopt_now() -> None:
    """Synchronous (tab-status caps itself at ~0.12 s): register tabs we just opened before 'done'."""
    if not _SCRIPT or not os.path.exists(_SCRIPT):
        return
    try:
        kw: dict = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "stdin": subprocess.DEVNULL, "timeout": 3}
        if os.name == "nt":
            kw["creationflags"] = subprocess.CREATE_NO_WINDOW
        subprocess.run([sys.executable, "-I", _SCRIPT, "adopt", "--agent", _AGENT], **kw)
    except Exception:
        pass


def _pre_tool_call(tool_name=None, args=None, **kwargs):
    cmd = _command(tool_name, args)
    if cmd:
        if _WALL_RE.search(cmd) and _CDPISH_RE.search(cmd):
            return {"action": "block", "message": "Blocked by bravemaxxing-hooks: this command names an extension or "
                    "site on your bravemaxxing-browser wall list. Agents may not open or use it."}
        if _RAW_RE.search(cmd) and not _PROBE_RE.search(cmd):
            return {"action": "block", "message": "Blocked by bravemaxxing-hooks: never drive Brave on its raw CDP "
                    "port (it steals focus and skips the wall). Use the quiet relay: "
                    "agent-browser --session hermes --cdp %s." % _RELAY}
    if _is_brave_work(tool_name, args):
        _status("working")
    return None


def _post_tool_call(tool_name=None, args=None, **kwargs):
    if _is_brave_work(tool_name, args):
        if _TABNEW_RE.search(_command(tool_name, args)):
            _adopt_now()  # relay registers tabs it creates as owner "agent"; adopt makes them ours
        _status("done")


def _post_llm_call(**kwargs):
    _status("turn-end")


def register(ctx):
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("post_tool_call", _post_tool_call)
    ctx.register_hook("post_llm_call", _post_llm_call)
