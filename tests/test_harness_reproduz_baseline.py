#!/usr/bin/env python3
"""O harness de patchers so vale se reproduzir o vermelho que producao ja tem.

Um harness que da verde em tudo nao prova nada -- prova que ele nao mede. Este
teste e o oraculo do oraculo: exige que, contra a arvore 0.18.2 (a versao VIVA),
o harness reproduza exatamente os dois patchers que o
/data/.hermes/logs/iris-pre-server-bootstrap.log mostra falhando em 2026-08-01,
com a MESMA mensagem de erro.

Se este teste ficar vermelho, nenhum verde do harness vale.

    python3 tests/test_harness_reproduz_baseline.py --resultado <harness-0.18.2.json>
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

# Baseline de producao, lido do log do boot de 2026-08-01T14:18:59Z.
# Sao PRE-EXISTENTES: nao sao regressao de nada que estejamos fazendo.
BASELINE_VERMELHO = {
    "apply_iris_cron_whatsapp_context_patch.py":
        "bridge quote extraction: expected one upstream anchor, found 0",
    "ensure_codex_oauth_gateway_autostart.py":
        "unsupported is_config_complete shape",
}

# Estes tem que estar verdes contra a 0.18.2: sao o que sustenta funcao viva hoje.
# Se um deles vier vermelho no controle, ou o harness esta errado ou producao
# esta pior do que o log conta.
BASELINE_VERDE = {
    "apply_iris_whatsapp_owner_groups_patch.py",
    "ensure_allocator_bootstrap.py",
    "ensure_tini_bootstrap.py",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--resultado", required=True, help="json do harness contra core 0.18.2")
    args = ap.parse_args()

    dados = json.loads(pathlib.Path(args.resultado).read_text())
    falhas = 0

    print("=== os dois vermelhos de producao tem que ser reproduzidos ===")
    for nome, trecho in BASELINE_VERMELHO.items():
        r = dados.get(nome)
        if r is None:
            print(f"FAIL {nome}: ausente do resultado")
            falhas += 1
            continue
        vermelho = r["veredito"].startswith("RED")
        casa = trecho in r.get("saida", "")
        if vermelho and casa:
            print(f"OK   {nome}: RED com a mensagem de producao")
        else:
            print(f"FAIL {nome}: veredito={r['veredito']} mensagem_casa={casa}")
            print(f"       esperado conter: {trecho}")
            falhas += 1

    print("\n=== os que sustentam funcao viva tem que estar verdes na 0.18.2 ===")
    for nome in sorted(BASELINE_VERDE):
        r = dados.get(nome)
        if r is None:
            print(f"FAIL {nome}: ausente do resultado")
            falhas += 1
        elif r["veredito"] == "GREEN":
            print(f"OK   {nome}: GREEN")
        else:
            print(f"FAIL {nome}: veredito={r['veredito']}")
            falhas += 1

    print()
    if falhas:
        print(f"{falhas} falha(s) — o harness NAO esta calibrado, nenhum verde dele vale")
        return 1
    print("harness calibrado: reproduz o baseline de producao nos dois sentidos")
    return 0


if __name__ == "__main__":
    sys.exit(main())
