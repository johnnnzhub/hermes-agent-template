#!/usr/bin/env python3
"""Idempotently add conservative glibc allocator settings to a boot script."""

from __future__ import annotations

import argparse
from pathlib import Path

BEGIN = "# BEGIN IRIS RAILWAY ALLOCATOR TUNING"
END = "# END IRIS RAILWAY ALLOCATOR TUNING"
BLOCK = f'''{BEGIN}
# Reduce per-thread glibc arena fragmentation in the multithreaded Hermes
# dashboard/gateways. This changes allocation strategy, not service limits.
export MALLOC_ARENA_MAX="${{MALLOC_ARENA_MAX:-2}}"
export MALLOC_TRIM_THRESHOLD_="${{MALLOC_TRIM_THRESHOLD_:-131072}}"
{END}
'''


def patch_target(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if BEGIN in text:
        return False

    lines = text.splitlines(keepends=True)
    insert_at = 1 if lines and lines[0].startswith("#!") else 0
    while insert_at < len(lines):
        stripped = lines[insert_at].strip()
        if stripped.startswith("set ") or not stripped:
            insert_at += 1
            continue
        break
    lines.insert(insert_at, "\n" + BLOCK)
    path.write_text("".join(lines), encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default="/app/start.sh")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    path = Path(args.target)
    if not path.is_file():
        print(f"allocator-bootstrap: target missing: {path}")
        return 1
    text = path.read_text(encoding="utf-8")
    if args.check:
        ok = BEGIN in text and "MALLOC_ARENA_MAX" in text and "MALLOC_TRIM_THRESHOLD_" in text
        print(f"allocator-bootstrap: {'ok' if ok else 'missing'} target={path}")
        return 0 if ok else 1
    changed = patch_target(path)
    print(f"allocator-bootstrap: {'patched' if changed else 'already-present'} target={path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
