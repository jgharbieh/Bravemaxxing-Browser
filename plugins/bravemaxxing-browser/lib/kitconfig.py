"""Shared config loader for tab-status.py, agent-tab.py and the Hermes plugin (JS twin: kitconfig.js).

Defaults: config/default.json (ships with the plugin).
Your overrides: $BRAVEMAXXING_CONFIG, else ~/.bravemaxxing/config.json. Object keys (ports, wall,
containers) merge one level deep; a list you set REPLACES the default list.
Env overrides for ports: CDP_QUIET_PORT (relay), CDP_UPSTREAM_PORT (Brave's real CDP port).
"""
import json
import os
import re
from pathlib import Path

DEFAULT_FILE = Path(__file__).resolve().parent.parent / "config" / "default.json"


def user_config_path() -> Path:
    return Path(os.environ.get("BRAVEMAXXING_CONFIG") or Path.home() / ".bravemaxxing" / "config.json")


def load() -> dict:
    cfg = json.loads(DEFAULT_FILE.read_text(encoding="utf-8"))
    try:
        user = json.loads(user_config_path().read_text(encoding="utf-8"))
        for k, v in user.items():
            cfg[k] = {**cfg[k], **v} if isinstance(cfg.get(k), dict) and isinstance(v, dict) else v
    except (OSError, ValueError):
        pass
    if os.environ.get("CDP_QUIET_PORT"):
        cfg["ports"]["relay"] = int(os.environ["CDP_QUIET_PORT"])
    if os.environ.get("CDP_UPSTREAM_PORT"):
        cfg["ports"]["upstream"] = int(os.environ["CDP_UPSTREAM_PORT"])
    return cfg


def _list(v) -> list:
    return [x.strip() for x in v if isinstance(x, str) and x.strip()] if isinstance(v, list) else []


def wall_regex(cfg: dict) -> "re.Pattern":
    """Same rule as the relay's wall (kitconfig.js wallRegex)."""
    w = cfg.get("wall") or {}
    parts = [re.escape(i) for i in _list(w.get("extension_ids"))]
    parts += [r"(?:^|[^a-z0-9-])(?:[a-z0-9-]+\.)*" + re.escape(d.lower()) + r"\b" for d in _list(w.get("domains"))]
    parts.append(r"wall-test\.invalid")
    return re.compile("|".join(parts), re.I)


def relay_url(cfg: dict) -> str:
    return f"http://127.0.0.1:{cfg['ports']['relay']}"


def brave_binary(cfg: dict):
    """BRAVE_PATH env, then config brave_path, then the usual install locations. None if not found.
    An explicit setting is never second-guessed: if it points nowhere, the result is None (no silent fallback)."""
    explicit = os.environ.get("BRAVE_PATH") or cfg.get("brave_path")
    if explicit:
        return str(explicit) if Path(explicit).exists() else None
    for r in filter(None, (os.environ.get(k) for k in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"))):
        p = Path(r) / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe"  # Windows install locations
        if p.exists():
            return str(p)
    if os.name != "nt":  # Linux: the launcher on PATH, then the package's own path
        import shutil
        for name in ("brave-browser", "brave-browser-stable", "brave"):
            found = shutil.which(name)
            if found:
                return found
        p = Path("/opt/brave.com/brave/brave-browser")
        if p.exists():
            return str(p)
    return None
