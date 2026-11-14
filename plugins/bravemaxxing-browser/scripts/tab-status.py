"""tab-status: report an agent's browser activity to the cdp-quiet relay (default 127.0.0.1:9333).

The relay owns the registry and keeps a status emoji in agent-owned tab titles:
  🤖 working  - a browser action is running now (also set automatically on any CDP traffic to the tab)
  ✅ done     - the last browser action finished; the turn is still going
  ⏸️ paused   - the turn ended
  (cleared)   - one full turn with no browser actions on that tab

Usage (hooks call it; it always exits 0 and never blocks, ~0.3 s max even if the relay is down;
hook-style commands stay silent, claim/register/adopt print an error if the relay refuses):
  tab-status working  [--agent NAME] [--tab <32hex>]
  tab-status done     [--agent NAME]
  tab-status turn-end [--agent NAME]
  tab-status claim    [--agent NAME] --tab <32hex>                (take over one of YOUR tabs for the agent)
  tab-status register [--agent NAME] --tab <32hex> --space <name> (agent-tab does this)
  tab-status adopt    [--agent NAME]                              (claim relay-created tabs from the last 60 s)
  tab-status show                                                 (print the registry)
Add -v to print the relay's reply. NAME defaults to config default_agent ("claude").
Port: config ports.relay (default 9333), env CDP_QUIET_PORT.
"""
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import kitconfig  # noqa: E402


def main() -> None:
    cfg = kitconfig.load()
    url = kitconfig.relay_url(cfg) + "/_agent/"
    args = sys.argv[1:]
    verbose = "-v" in args
    args = [a for a in args if a != "-v"]
    if not args:
        print(__doc__)
        return
    cmd, opts, i = args[0], {}, 1
    while i < len(args) - 1:
        if args[i].startswith("--"):
            opts[args[i][2:]] = args[i + 1]
            i += 2
        else:
            i += 1
    opts.setdefault("agent", cfg["default_agent"])
    quiet = cmd in ("working", "done", "turn-end")  # hook calls stay silent and fast; everything else is loud on failure
    try:
        if cmd == "show":
            with urllib.request.urlopen(url + "registry", timeout=0.5) as r:
                print(json.dumps(json.load(r), indent=1, ensure_ascii=False))
            return
        body = json.dumps({"cmd": cmd, **opts}).encode()
        req = urllib.request.Request(url + "status", data=body, headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=0.12 if quiet else 3) as r:
            reply = r.read().decode()
        failed = '"ok":false' in reply.replace(" ", "")
        if verbose or (failed and not quiet):
            print(reply, file=sys.stderr if failed else sys.stdout)
    except Exception as e:  # relay down / slow: hooks must never fail or block
        if verbose or not quiet:
            detail = getattr(e, "code", "") or e.__class__.__name__
            print(f"tab-status: {cmd} FAILED - relay unreachable or refused ({detail})", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    finally:
        sys.exit(0)
