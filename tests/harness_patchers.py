#!/usr/bin/env python3
"""Harness dos patchers do volume: veredito por patcher contra uma arvore de core.

Por que existe
--------------
Os patchers em `scripts/volume/` editam o core do Hermes casando por ancora de
texto. Todo bump do core pode quebra-los, e hoje eles falham ABERTO: o
`iris_pre_server_bootstrap.sh` encadeia tudo com `|| log WARN`, entao um patcher
morto vira uma linha de log e o boot segue. Pior, `apply_iris_tasks_router_
gateway_patch.py` com ancora ausente retorna exit 0 e imprime "skip patch" --
falso verde que nem entra na contagem de WARN.

Logo, o criterio de aceite de um upgrade nao pode ser exit code nem numero de
WARN. Tem que ser EFEITO VERIFICADO. E o que este harness mede.

Como mede
---------
Cada patcher roda contra uma COPIA descartavel da arvore alvo, nunca a viva.
Seis aceitam variavel de ambiente de alvo e sao executados de verdade. Os que
tem caminho fixo em /opt ou /data nao podem ser isolados sem container -- para
esses o veredito e ESTATICO (as ancoras que ele procura ainda existem?), e sai
rotulado como tal. Nao se mistura os dois niveis de evidencia.

Controle obrigatorio
--------------------
Contra a arvore 0.18.2 o resultado tem que reproduzir o baseline conhecido de
producao: `apply_iris_cron_whatsapp_context_patch.py` VERMELHO (bridge quote
extraction: expected one upstream anchor, found 0) e
`ensure_codex_oauth_gateway_autostart.py` VERMELHO contra o server.py vivo
(unsupported is_config_complete shape). Se o harness nao reproduzir esses dois
vermelhos, o errado e o harness -- e nenhum verde dele vale.

Uso
---
    python3 tests/harness_patchers.py --core <dir-do-core> [--wrapper <dir>] [--json <saida>]
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

RAIZ = pathlib.Path(__file__).resolve().parent.parent
PATCHERS = RAIZ / "scripts" / "volume"

# Patchers que aceitam variavel de ambiente apontando para copia descartavel.
# valor: funcao que monta o env dado (core_tmp, wrapper_tmp)
ISOLAVEIS = {
    "ensure_tini_bootstrap.py": lambda c, w: {"IRIS_HERMES_BOOT_PATH": str(w / "hermes-boot.sh")},
    "ensure_codex_oauth_gateway_autostart.py": lambda c, w: {"IRIS_SERVER_AUTOSTART_TARGET": str(w / "server.py")},
    "apply_iris_cron_whatsapp_context_patch.py": lambda c, w: {"HERMES_RUNTIME_ROOT": str(c)},
    "apply_iris_whatsapp_owner_groups_patch.py": lambda c, w: {
        "IRIS_WHATSAPP_BRIDGE_PATH": str(c / "scripts" / "whatsapp-bridge" / "bridge.js"),
        "IRIS_WHATSAPP_ADAPTER_PATH": str(c / "plugins" / "platforms" / "whatsapp" / "adapter.py"),
        "IRIS_WHATSAPP_PATCH_BACKUP_ROOT": str(c / "_backups"),
    },
    "ensure_persistent_mcp_binaries.py": lambda c, w: {
        "IRIS_MCP_CONFIG_PATHS": str(w / "deploy-config.yaml"),
    },
}

# Alvo passado por argumento de linha de comando, nao por env.
ARGUMENTOS = {
    "ensure_allocator_bootstrap.py": lambda c, w: ["--target", str(w / "start.sh")],
}

# Alvo fixo em /opt ou /data: sem container nao da para executar isolado.
SO_ESTATICO = {
    "apply_iris_ops_runtime_patches.py",
    "apply_iris_model_routing_patch.py",
    "ensure_codex_only.py",
}

MIN_ANCORA = 40
IGNORA_PREFIXO = ("http", "/data", "/app", "/opt", "%", "{")


def ancoras(patcher: pathlib.Path) -> list[str]:
    """Literais que tem cara de trecho de codigo procurado no alvo."""
    try:
        arvore = ast.parse(patcher.read_text(errors="replace"))
    except SyntaxError:
        return []
    out = []
    for no in ast.walk(arvore):
        if isinstance(no, ast.Constant) and isinstance(no.value, str):
            v = no.value
            if len(v) < MIN_ANCORA or v.startswith(IGNORA_PREFIXO):
                continue
            if not any(t in v for t in ("(", "=", "def ", "self.", "await ", "import ")):
                continue
            out.append(v)
    return out


def corpus(diretorio: pathlib.Path) -> str:
    partes = []
    for p in diretorio.rglob("*"):
        if p.is_file() and p.suffix in (".py", ".js", ".sh", ".yaml", ".mjs"):
            try:
                partes.append(p.read_text(errors="replace"))
            except OSError:
                pass
    return "\n".join(partes)


def sondar(a: str) -> str:
    """Primeira linha significativa da ancora -- o que da para procurar literalmente."""
    if "\n" in a:
        primeira = a.strip().splitlines()[0].strip()
        if len(primeira) >= MIN_ANCORA:
            return primeira
    return a.strip()


def hashes(diretorio: pathlib.Path) -> dict[str, str]:
    import hashlib

    out = {}
    for p in sorted(diretorio.rglob("*")):
        if p.is_file() and "_backups" not in p.parts:
            out[str(p.relative_to(diretorio))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def valida_sintaxe(diretorio: pathlib.Path) -> list[str]:
    problemas = []
    for p in diretorio.rglob("*.py"):
        try:
            ast.parse(p.read_text(errors="replace"))
        except SyntaxError as e:
            problemas.append(f"{p.relative_to(diretorio)}: {e}")
    node = shutil.which("node")
    if node:
        for p in diretorio.rglob("*.js"):
            r = subprocess.run([node, "--check", str(p)], capture_output=True, text=True)
            if r.returncode != 0:
                problemas.append(f"{p.relative_to(diretorio)}: node --check falhou")
    return problemas


def executa(patcher: pathlib.Path, core: pathlib.Path, wrapper: pathlib.Path) -> dict:
    """Roda o patcher de verdade contra copias descartaveis. Duas vezes (idempotencia)."""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="harness-"))
    try:
        c = tmp / "core"
        w = tmp / "wrapper"
        shutil.copytree(core, c)
        shutil.copytree(wrapper, w)

        env = dict(os.environ)
        env.update({k: str(v) for k, v in ISOLAVEIS.get(patcher.name, lambda *_: {})(c, w).items()})
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        argv = [sys.executable, str(patcher)] + ARGUMENTOS.get(patcher.name, lambda *_: [])(c, w)

        antes = {**hashes(c), **hashes(w)}
        r1 = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=180)
        depois1 = {**hashes(c), **hashes(w)}
        mudou = sorted(k for k in set(antes) | set(depois1) if antes.get(k) != depois1.get(k))

        r2 = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=180)
        depois2 = {**hashes(c), **hashes(w)}
        idempotente = depois1 == depois2

        sintaxe = valida_sintaxe(c) + valida_sintaxe(w)

        saida = (r1.stdout + r1.stderr).strip()
        return {
            "modo": "execucao",
            "exit": r1.returncode,
            "exit_2a_passagem": r2.returncode,
            "arquivos_alterados": mudou,
            "idempotente": idempotente,
            "sintaxe_quebrada": sintaxe,
            "saida": saida[-1500:],
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def estatico(patcher: pathlib.Path, texto_core: str, texto_wrapper: str) -> dict:
    todas = ancoras(patcher)
    tudo = texto_core + "\n" + texto_wrapper
    presentes, ausentes = [], []
    for a in todas:
        (presentes if sondar(a) in tudo else ausentes).append(sondar(a))
    return {
        "modo": "estatico",
        "ancoras": len(todas),
        "presentes": len(presentes),
        "ausentes_amostra": ausentes[:5],
        "ausentes_total": len(ausentes),
    }


def veredito(nome: str, r: dict) -> str:
    if r["modo"] == "estatico":
        if r["ancoras"] == 0:
            return "N-A"      # nao casa texto de codigo (mexe em config)
        if r["presentes"] == 0:
            return "RED"
        return "ESTATICO-PARCIAL"
    # Dependencia ausente ou caminho que so existe no container nao sao falha do
    # patcher. Marcar isso como RED seria acusa-lo por limitacao do harness --
    # e um RED falso vale menos que nada, porque some no meio dos verdadeiros.
    saida = r.get("saida", "")
    if "ModuleNotFoundError" in saida:
        return "INCONCLUSIVO-DEP"
    if "FileNotFoundError" in saida and ("/data/" in saida or "/opt/" in saida):
        return "INCONCLUSIVO-AMBIENTE"
    if r["exit"] != 0:
        return "RED"
    if r["sintaxe_quebrada"]:
        return "RED"
    if not r["arquivos_alterados"]:
        # exit 0 sem efeito e o falso verde que motivou este harness
        return "RED-FALSO-VERDE"
    if not r["idempotente"]:
        return "RED-NAO-IDEMPOTENTE"
    return "GREEN"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True, help="arvore do core a testar")
    ap.add_argument("--wrapper", default=str(RAIZ), help="arvore do wrapper (default: este repo)")
    ap.add_argument("--json", help="grava o resultado bruto")
    args = ap.parse_args()

    core = pathlib.Path(args.core).resolve()
    wrapper = pathlib.Path(args.wrapper).resolve()
    if not core.is_dir():
        print(f"core nao encontrado: {core}", file=sys.stderr)
        return 2

    txt_core = corpus(core)
    txt_wrapper = corpus(wrapper)

    resultados = {}
    print(f"core:    {core}")
    print(f"wrapper: {wrapper}\n")
    print(f"{'patcher':<46} {'modo':<10} veredito")
    print("-" * 84)

    for patcher in sorted(PATCHERS.glob("*.py")):
        nome = patcher.name
        if nome in ISOLAVEIS or nome in ARGUMENTOS:
            try:
                r = executa(patcher, core, wrapper)
            except Exception as e:  # falha do harness nao pode virar verde
                r = {"modo": "execucao", "exit": -1, "arquivos_alterados": [],
                     "idempotente": False, "sintaxe_quebrada": [],
                     "saida": f"harness falhou: {type(e).__name__}: {e}"}
        else:
            r = estatico(patcher, txt_core, txt_wrapper)
            if nome not in SO_ESTATICO:
                r["nota"] = "sem variavel de isolamento mapeada"
        v = veredito(nome, r)
        r["veredito"] = v
        resultados[nome] = r
        print(f"{nome:<46} {r['modo']:<10} {v}")

    print("\n" + "=" * 84)
    print("DETALHE DOS NAO-VERDES\n")
    for nome, r in resultados.items():
        if r["veredito"] == "GREEN":
            continue
        print(f"--- {nome}  [{r['veredito']}]")
        if r["modo"] == "execucao":
            print(f"    exit={r['exit']} alterados={len(r['arquivos_alterados'])} "
                  f"idempotente={r['idempotente']}")
            if r["sintaxe_quebrada"]:
                print(f"    sintaxe: {r['sintaxe_quebrada'][:3]}")
            if r["saida"]:
                for linha in r["saida"].splitlines()[-6:]:
                    print(f"    | {linha}")
        else:
            print(f"    ancoras={r['ancoras']} presentes={r['presentes']} ausentes={r['ausentes_total']}")
            for a in r["ausentes_amostra"][:3]:
                print(f"    | {a[:110]}")
        print()

    if args.json:
        pathlib.Path(args.json).write_text(
            json.dumps(resultados, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        )
        print(f"resultado bruto: {args.json}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
