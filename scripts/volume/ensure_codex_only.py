#!/usr/bin/env python3
"""Enforce the Iris Codex-only GPT-5.6 routing policy idempotently."""

from __future__ import annotations

import os
from pathlib import Path

import yaml

MAIN_MODEL = "gpt-5.6-terra"
COMPLEX_MODEL = "gpt-5.6-sol"
PROVIDER = "openai-codex"

AUXILIARY_TASKS = (
    "vision",
    "web_extract",
    "compression",
    "title_generation",
    "approval",
    "skills_hub",
    "mcp",
    "triage_specifier",
    "kanban_decomposer",
    "profile_describer",
    "curator",
    "tts_audio_tags",
    "monitor",
)


def _load(path: Path) -> dict:
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return data if isinstance(data, dict) else {}


def _apply_policy(cfg: dict) -> dict:
    model = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    model["default"] = MAIN_MODEL
    model["provider"] = PROVIDER
    # Keep Codex OAuth on its native endpoint and protocol resolution.
    model["base_url"] = "https://chatgpt.com/backend-api/codex"
    model.pop("api_mode", None)
    cfg["model"] = model

    # If Terra is temporarily unavailable, fail over inside the same Codex pool.
    cfg["fallback_providers"] = [
        {"provider": PROVIDER, "model": COMPLEX_MODEL}
    ]

    agent = cfg.get("agent") if isinstance(cfg.get("agent"), dict) else {}
    agent.setdefault("max_iterations", 50)
    agent["reasoning_effort"] = "low"
    # Avoid paid Priority Processing by default; Terra supplies the fast lane.
    agent["service_tier"] = "normal"
    cfg["agent"] = agent

    delegation = cfg.get("delegation") if isinstance(cfg.get("delegation"), dict) else {}
    delegation.update(
        {
            "provider": PROVIDER,
            "model": COMPLEX_MODEL,
            "reasoning_effort": "max",
            "max_iterations": 50,
            "max_concurrent_children": 3,
            "max_spawn_depth": 1,
            "orchestrator_enabled": True,
            "child_timeout_seconds": 0,
            "subagent_auto_approve": False,
        }
    )
    delegation.pop("base_url", None)
    delegation.pop("api_key", None)
    delegation.pop("api_mode", None)
    # Removed in config schema v33. max_concurrent_children now caps
    # background delegations as well.
    delegation.pop("max_async_children", None)
    cfg["delegation"] = delegation

    auxiliary = cfg.get("auxiliary") if isinstance(cfg.get("auxiliary"), dict) else {}
    for task in AUXILIARY_TASKS:
        slot = auxiliary.get(task) if isinstance(auxiliary.get(task), dict) else {}
        slot.update({"provider": PROVIDER, "model": MAIN_MODEL})
        slot.pop("base_url", None)
        slot.pop("api_key", None)
        auxiliary[task] = slot
    cfg["auxiliary"] = auxiliary

    # Short names for explicit session switches. Reasoning is controlled with
    # /reasoning; complex work normally reaches Sol through delegate_task.
    aliases = cfg.get("model_aliases") if isinstance(cfg.get("model_aliases"), dict) else {}
    aliases.update(
        {
            "terra": {"provider": PROVIDER, "model": MAIN_MODEL},
            "sol": {"provider": PROVIDER, "model": COMPLEX_MODEL},
        }
    )
    cfg["model_aliases"] = aliases

    # Keep optional /moa parallel work Codex-only as well.
    refs = [
        {"provider": PROVIDER, "model": MAIN_MODEL},
        {"provider": PROVIDER, "model": COMPLEX_MODEL},
    ]
    aggregator = {"provider": PROVIDER, "model": COMPLEX_MODEL}
    moa = cfg.get("moa") if isinstance(cfg.get("moa"), dict) else {}
    moa["reference_models"] = refs
    moa["aggregator"] = aggregator
    presets = moa.get("presets") if isinstance(moa.get("presets"), dict) else {}
    default_preset = presets.get("default") if isinstance(presets.get("default"), dict) else {}
    default_preset["reference_models"] = refs
    default_preset["aggregator"] = aggregator
    presets["default"] = default_preset
    moa["presets"] = presets
    cfg["moa"] = moa

    return cfg


def _write_if_changed(path: Path) -> bool:
    before = path.read_text(encoding="utf-8") if path.exists() else ""
    cfg = _apply_policy(_load(path))
    after = yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True)
    if after == before:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(after, encoding="utf-8")
    return True


def main() -> int:
    hermes_home = Path(os.environ.get("HERMES_HOME", "/data/.hermes"))
    targets = [hermes_home / "config.yaml"]
    deploy_config = Path("/app/deploy-config.yaml")
    if deploy_config.exists():
        targets.append(deploy_config)

    for path in targets:
        state = "updated" if _write_if_changed(path) else "already compliant"
        print(f"{path}: {state}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
