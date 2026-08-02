#!/usr/bin/env python3
"""Install Iris deterministic Terra/Sol routing into the local Hermes runtime.

Idempotent and fail-safe: it makes no partial run.py edit when expected upstream
anchors are absent. The source of truth remains under /data/.hermes/scripts.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

SOURCE = Path("/data/.hermes/scripts/iris_model_router.py")
TARGET = Path("/opt/hermes-agent/iris_model_router.py")
GATEWAY = Path("/opt/hermes-agent/gateway/run.py")

IMPORT = "        from hermes_cli.models import resolve_fast_mode_overrides\n"
IMPORT_NEW = IMPORT + "        from iris_model_router import route_turn as _iris_route_turn\n"
ROUTE_ANCHOR = """        route = {
            \"model\": model,
            \"runtime\": runtime,
"""
ROUTE_NEW = """        _iris_decision = _iris_route_turn(user_message, model, runtime[\"provider\"])
        if _iris_decision.model != model:
            logger.info(
                \"Iris model routing: %s -> %s category=%s\",
                model,
                _iris_decision.model,
                _iris_decision.category,
            )
        model = _iris_decision.model
        route = {
            \"model\": model,
            \"runtime\": runtime,
"""
TIER_ANCHOR = """        service_tier = getattr(self, \"_service_tier\", None)
"""
TIER_NEW = """        if _iris_decision.reasoning_effort:
            route[\"routing_reasoning_config\"] = {
                \"enabled\": True,
                \"effort\": _iris_decision.reasoning_effort,
            }
        service_tier = getattr(self, \"_service_tier\", None)
"""
BG_ANCHOR = """            turn_route = self._resolve_turn_agent_config(prompt, model, runtime_kwargs)

            # Enrich the prompt"""
BG_NEW = """            turn_route = self._resolve_turn_agent_config(prompt, model, runtime_kwargs)
            _bg_session_key = self._session_key_for_source(source)
            if _bg_session_key not in (getattr(self, \"_session_reasoning_overrides\", {}) or {}):
                reasoning_config = turn_route.get(\"routing_reasoning_config\") or reasoning_config
                self._reasoning_config = reasoning_config

            # Enrich the prompt"""
MAIN_ANCHOR = """            turn_route = self._resolve_turn_agent_config(message, model, runtime_kwargs)

            # Check agent cache"""
MAIN_NEW = """            turn_route = self._resolve_turn_agent_config(message, model, runtime_kwargs)
            if session_key not in (getattr(self, \"_session_reasoning_overrides\", {}) or {}):
                reasoning_config = turn_route.get(\"routing_reasoning_config\") or reasoning_config
                self._reasoning_config = reasoning_config

            # Check agent cache"""


def atomic_write(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".iris-tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def install_module() -> None:
    if not SOURCE.exists():
        raise RuntimeError(f"missing routing source: {SOURCE}")
    content = SOURCE.read_text(encoding="utf-8")
    if not content.startswith('"""Deterministic'):
        raise RuntimeError("routing source integrity check failed")
    atomic_write(TARGET, content)


def patch_gateway() -> bool:
    before = GATEWAY.read_text(encoding="utf-8")
    if "from iris_model_router import route_turn as _iris_route_turn" in before:
        # Upgrade the first router revision so an explicit `/model terra` is
        # never auto-upgraded to Sol by complexity classification.
        after = before
        after = after.replace(
            "    def _resolve_turn_agent_config(self, user_message: str, model: str, runtime_kwargs: dict) -> dict:\n",
            "    def _resolve_turn_agent_config(\n        self,\n        user_message: str,\n        model: str,\n        runtime_kwargs: dict,\n        *,\n        preserve_model: bool = False,\n    ) -> dict:\n",
            1,
        )
        after = after.replace(
            '        _iris_decision = _iris_route_turn(user_message, model, runtime["provider"])\n',
            '        _iris_decision = _iris_route_turn(\n            user_message,\n            model,\n            runtime["provider"],\n            preserve_model=preserve_model,\n        )\n',
            1,
        )
        after = after.replace(
            '            turn_route = self._resolve_turn_agent_config(prompt, model, runtime_kwargs)\n            _bg_session_key = self._session_key_for_source(source)\n',
            '            _bg_session_key = self._session_key_for_source(source)\n            turn_route = self._resolve_turn_agent_config(\n                prompt,\n                model,\n                runtime_kwargs,\n                preserve_model=_bg_session_key in (getattr(self, "_session_model_overrides", {}) or {}),\n            )\n',
            1,
        )
        after = after.replace(
            '            turn_route = self._resolve_turn_agent_config(message, model, runtime_kwargs)\n',
            '            turn_route = self._resolve_turn_agent_config(\n                message,\n                model,\n                runtime_kwargs,\n                preserve_model=session_key in (getattr(self, "_session_model_overrides", {}) or {}),\n            )\n',
            1,
        )
        if after != before:
            atomic_write(GATEWAY, after)
            return True
        return False
    required = [IMPORT, ROUTE_ANCHOR, TIER_ANCHOR, BG_ANCHOR, MAIN_ANCHOR]
    missing = [repr(x[:60]) for x in required if x not in before]
    if missing:
        raise RuntimeError("gateway anchors missing: " + ", ".join(missing))
    after = before.replace(IMPORT, IMPORT_NEW, 1)
    after = after.replace(ROUTE_ANCHOR, ROUTE_NEW, 1)
    after = after.replace(TIER_ANCHOR, TIER_NEW, 1)
    after = after.replace(BG_ANCHOR, BG_NEW, 1)
    after = after.replace(MAIN_ANCHOR, MAIN_NEW, 1)
    atomic_write(GATEWAY, after)
    return True


def main() -> int:
    install_module()
    changed = patch_gateway()
    print("iris deterministic routing: " + ("installed" if changed else "already installed"))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"iris deterministic routing: failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
