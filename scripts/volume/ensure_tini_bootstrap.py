#!/usr/bin/env python3
"""Ensure the Railway boot chain starts under tini before spawning services."""

from __future__ import annotations

import os
import re
import stat
import tempfile
from pathlib import Path

TARGET = Path(os.environ.get("IRIS_HERMES_BOOT_PATH", "/app/hermes-boot.sh"))
OLD = "if [ -x /app/start.sh ]; then exec /app/start.sh; else exec python /app/server.py; fi"
MARKER = "# BEGIN IRIS TINI INIT SUPERVISOR"
PREBOOT_MARKER = "# BEGIN IRIS PERSISTENT PRE-SERVER BOOTSTRAP"
PREBOOT_END_MARKER = "# END IRIS PERSISTENT PRE-SERVER BOOTSTRAP"
PREBOOT = """# BEGIN IRIS PERSISTENT PRE-SERVER BOOTSTRAP
# Reapply volume-backed runtime patches once per boot process tree.
if [ "${IRIS_PREBOOT_DONE:-0}" != "1" ] && [ -x /data/.hermes/scripts/iris_pre_server_bootstrap.sh ]; then
  if HERMES_HOME="${HERMES_HOME:-/data/.hermes}" /data/.hermes/scripts/iris_pre_server_bootstrap.sh >> /data/.hermes/logs/iris-pre-server-bootstrap.log 2>&1; then
    export IRIS_PREBOOT_DONE=1
    export IRIS_WATCHDOGS_STARTED=1
  else
    log "WARN: persistent pre-server bootstrap failed"
  fi
fi
# END IRIS PERSISTENT PRE-SERVER BOOTSTRAP

"""
NEW = """# BEGIN IRIS TINI INIT SUPERVISOR
# Keep a real init as PID 1 so orphaned MCP/watchdog descendants are reaped.
# The fallback preserves availability if a future image unexpectedly omits tini.
if [ -x /usr/bin/tini ]; then
  if [ -x /app/start.sh ]; then
    exec /usr/bin/tini -s -- /app/start.sh
  else
    exec /usr/bin/tini -s -- python /app/server.py
  fi
else
  log "WARN: /usr/bin/tini unavailable; starting without init supervisor"
  if [ -x /app/start.sh ]; then exec /app/start.sh; else exec python /app/server.py; fi
fi
# END IRIS TINI INIT SUPERVISOR"""


def atomic_replace(path: Path, text: str, mode: int) -> None:
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        handle.write(text)
        tmp = Path(handle.name)
    try:
        os.chmod(tmp, stat.S_IMODE(mode))
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def main() -> int:
    if not TARGET.is_file():
        raise SystemExit(f"missing boot script: {TARGET}")
    original = TARGET.read_text(encoding="utf-8")
    updated = original
    changes: list[str] = []
    if MARKER not in updated:
        if OLD not in updated:
            raise SystemExit(f"unsupported boot script shape: {TARGET}")
        updated = updated.replace(OLD, NEW, 1)
        changes.append("tini")
    if PREBOOT_MARKER not in updated:
        if MARKER not in updated:
            raise SystemExit(f"tini marker missing after patch: {TARGET}")
        updated = updated.replace(MARKER, PREBOOT + MARKER, 1)
        changes.append("persistent-preboot")
    else:
        pattern = re.compile(
            re.escape(PREBOOT_MARKER)
            + r".*?"
            + re.escape(PREBOOT_END_MARKER)
            + r"\n*",
            re.DOTALL,
        )
        refreshed, count = pattern.subn(PREBOOT, updated, count=1)
        if count != 1:
            raise SystemExit(f"malformed persistent preboot block: {TARGET}")
        if refreshed != updated:
            updated = refreshed
            changes.append("persistent-preboot-refresh")
    if not changes:
        print(f"tini/preboot bootstrap unchanged: {TARGET}")
        return 0
    atomic_replace(TARGET, updated, TARGET.stat().st_mode)
    print(f"tini/preboot bootstrap patched ({','.join(changes)}): {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
