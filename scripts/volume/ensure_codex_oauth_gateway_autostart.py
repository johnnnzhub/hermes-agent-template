#!/usr/bin/env python3
"""Make Railway admin autostart recognize Hermes OpenAI Codex OAuth config."""
from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path

TARGET = Path(os.environ.get("IRIS_SERVER_AUTOSTART_TARGET", "/app/server.py"))
MARKER = "# BEGIN IRIS OAUTH PROVIDER AUTOSTART"
ANCHOR = "def is_config_complete(data: dict[str, str] | None = None) -> bool:\n"
OLD = '''def is_config_complete(data: dict[str, str] | None = None) -> bool:
    """Single source of truth for 'ready to run the gateway'.

    Used by: GET / redirect, auto_start on boot, admin API status.
    """
    if data is None:
        data = read_env(ENV_FILE)
    has_model = bool(data.get("LLM_MODEL"))
    has_provider = any(data.get(k) for k in PROVIDER_KEYS) or _has_xai_oauth_tokens()
    return has_model and has_provider
'''
NEW = '''# BEGIN IRIS OAUTH PROVIDER AUTOSTART
# The Railway wrapper historically recognized provider API keys and xAI OAuth only.
# Hermes can be fully configured with OpenAI Codex OAuth in config.yaml/auth.json,
# so include that real credential path in the boot readiness predicate.
def _has_openai_codex_oauth_config() -> tuple[bool, bool]:
    configured_model = False
    try:
        import yaml

        config = yaml.safe_load((Path(HERMES_HOME) / "config.yaml").read_text(encoding="utf-8")) or {}
        model = config.get("model") if isinstance(config, dict) else {}
        model = model if isinstance(model, dict) else {}
        configured_model = bool(model.get("default"))
        if model.get("provider") != "openai-codex":
            return configured_model, False
    except Exception:
        return configured_model, False

    try:
        auth = json.loads((Path(HERMES_HOME) / "auth.json").read_text(encoding="utf-8"))
        entries = ((auth.get("credential_pool") or {}).get("openai-codex") or [])
        if isinstance(entries, dict):
            entries = [entries]
        usable = any(
            isinstance(entry, dict) and (entry.get("access_token") or entry.get("refresh_token"))
            for entry in entries
        )
        return configured_model, bool(usable)
    except Exception:
        return configured_model, False
# END IRIS OAUTH PROVIDER AUTOSTART


def is_config_complete(data: dict[str, str] | None = None) -> bool:
    """Single source of truth for 'ready to run the gateway'.

    Used by: GET / redirect, auto_start on boot, admin API status.
    """
    if data is None:
        data = read_env(ENV_FILE)
    oauth_model, oauth_provider = _has_openai_codex_oauth_config()
    has_model = bool(data.get("LLM_MODEL")) or oauth_model
    has_provider = any(data.get(k) for k in PROVIDER_KEYS) or _has_xai_oauth_tokens() or oauth_provider
    return has_model and has_provider
'''


def atomic_replace(path: Path, text: str) -> None:
    mode = stat.S_IMODE(path.stat().st_mode)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(text)
        tmp = Path(handle.name)
    try:
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def main() -> int:
    if not TARGET.is_file():
        raise SystemExit(f"missing admin server: {TARGET}")
    text = TARGET.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"OAuth gateway autostart unchanged: {TARGET}")
        return 0
    if ANCHOR not in text or OLD not in text:
        raise SystemExit(f"unsupported is_config_complete shape: {TARGET}")
    atomic_replace(TARGET, text.replace(OLD, NEW, 1))
    print(f"OAuth gateway autostart patched: {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
