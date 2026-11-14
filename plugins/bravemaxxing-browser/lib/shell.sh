# Shared helpers for bin/* (sourced, not executed). Expects ROOT to be the plugin directory.

# Native path for node/python: Git Bash on Windows needs C:\... form; elsewhere the path is already fine.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

# Print a config value, e.g. cfg ports.relay
cfg() { node "$(native "$ROOT/lib/config-get.js")" "$1"; }

# Pick a working Python 3. On Windows prefer `python` (`python3` is often a Store stub that fails).
find_python() {
  local c
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) set -- python python3 py ;;
    *) set -- python3 python ;;
  esac
  for c in "$@"; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(sys.version_info[0] != 3)' >/dev/null 2>&1; then
      printf '%s' "$c"; return 0
    fi
  done
  echo "bravemaxxing-browser: Python 3 not found on PATH" >&2; return 1
}
