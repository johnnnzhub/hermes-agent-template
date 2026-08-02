#!/usr/bin/env python3
"""Install Iris deterministic Terra/Sol routing into the local Hermes runtime.

Idempotent and fail-safe: it makes no partial run.py edit when expected upstream
anchors are absent. The source of truth remains under /data/.hermes/scripts.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

import os
# Raizes parametrizaveis: sem isso este patcher so roda dentro do container, que
# e exatamente onde nao se quer descobrir que ele parou de casar com o upstream.
# Com elas, o harness aponta para copias descartaveis de 0.18.2 e 0.19.1 e mede
# efeito real -- arquivos alterados, idempotencia, sintaxe, pos-condicao.
CORE = Path(os.environ.get("IRIS_CORE_ROOT", "/opt/hermes-agent"))
APP = Path(os.environ.get("IRIS_APP_ROOT", "/app"))

SOURCE = Path(os.environ.get("IRIS_ROUTER_SOURCE", "/data/.hermes/scripts")) / "iris_model_router.py"
TARGET = CORE / "iris_model_router.py"
GATEWAY = CORE / "gateway/run.py"

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

# Variante 0.19.1 do mesmo ponto. O upstream extraiu o bloco do metodo grande
# para `run_sync`, e la dentro os nomes mudaram todos de forma sistematica:
#   self          -> self._runner   (metodos e atributos do runner)
#   message       -> ctx.message
#   session_key   -> ctx.session_key
#   indentacao    -> 8 espacos, nao 12
#
# Cada nome foi conferido no escopo real (run_sync, linhas 4067-5396 da 0.19.1):
# `reasoning_config` e local (atribuido em 4134), `_session_reasoning_overrides`
# e uma legacy_dict_property do runner, e o proprio upstream escreve
# `self._runner._reasoning_config = reasoning_config` na linha 4139. Ou seja, o
# bloco abaixo usa o mesmo idioma do codigo vizinho, nao uma invencao nossa.
#
# As duas variantes convivem de proposito: o patcher precisa funcionar na 0.18.2
# tambem, senao o rollback deixa de ser simetrico.
MAIN_ANCHOR_0191 = """        turn_route = self._runner._resolve_turn_agent_config(ctx.message, model, runtime_kwargs)

        # Check agent cache"""
MAIN_NEW_0191 = """        turn_route = self._runner._resolve_turn_agent_config(ctx.message, model, runtime_kwargs)
        if ctx.session_key not in (getattr(self._runner, \"_session_reasoning_overrides\", {}) or {}):
            reasoning_config = turn_route.get(\"routing_reasoning_config\") or reasoning_config
            self._runner._reasoning_config = reasoning_config

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
    # O ponto principal tem duas formas: a da 0.18.2 e a da 0.19.1, que extraiu
    # o bloco para `run_sync` e renomeou self -> self._runner, message ->
    # ctx.message, session_key -> ctx.session_key. Escolhe a que casar; exigir a
    # das duas quebraria numa versao ou na outra, e o rollback precisa das duas.
    if MAIN_ANCHOR in before:
        main_ancora, main_novo = MAIN_ANCHOR, MAIN_NEW
    elif MAIN_ANCHOR_0191 in before:
        main_ancora, main_novo = MAIN_ANCHOR_0191, MAIN_NEW_0191
    else:
        main_ancora = main_novo = None

    required = [IMPORT, ROUTE_ANCHOR, TIER_ANCHOR, BG_ANCHOR]
    missing = [repr(x[:60]) for x in required if x not in before]
    if main_ancora is None:
        missing.append("ponto principal (nem forma 0.18.2 nem 0.19.1)")
    if missing:
        raise RuntimeError("gateway anchors missing: " + ", ".join(missing))
    after = before.replace(IMPORT, IMPORT_NEW, 1)
    after = after.replace(ROUTE_ANCHOR, ROUTE_NEW, 1)
    after = after.replace(TIER_ANCHOR, TIER_NEW, 1)
    after = after.replace(BG_ANCHOR, BG_NEW, 1)
    after = after.replace(main_ancora, main_novo, 1)
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
