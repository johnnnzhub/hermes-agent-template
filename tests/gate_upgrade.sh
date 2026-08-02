#!/usr/bin/env bash
# Gate do upgrade: um comando, tres provas, saida binaria.
#
#   bash tests/gate_upgrade.sh <arvore-core-atual> <arvore-core-alvo> [dir-saida]
#
# Prova 1  calibracao   -- o harness reproduz os vermelhos que producao ja tem?
#                          Se nao, ele nao mede nada e nenhum verde dele vale.
# Prova 2  controle     -- veredito por patcher contra a versao VIVA.
# Prova 3  alvo         -- veredito por patcher contra a versao ALVO.
#
# Falha se algum patcher REGREDIR (verde na atual, nao-verde na alvo). Vermelho
# que ja existe na atual e PRE-EXISTENTE e nao barra o release -- barrar por ele
# seria confundir divida antiga com risco novo.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ATUAL="${1:?uso: gate_upgrade.sh <core-atual> <core-alvo> [saida]}"
ALVO="${2:?uso: gate_upgrade.sh <core-atual> <core-alvo> [saida]}"
SAIDA="${3:-$(mktemp -d)}"
PY="${GATE_PYTHON:-python3}"

mkdir -p "$SAIDA"

# O wrapper pristino e insumo de teste, nao evidencia: e uma copia byte a byte
# de um commit que o repo ja guarda. Vai para um temporario, senao poluiria o
# diretorio de saida com dezenas de arquivos duplicados (aconteceu na primeira
# execucao e entrou num commit).
PRISTINO="$(mktemp -d)/wrapper-pristino"
trap 'rm -rf "$(dirname "$PRISTINO")"' EXIT

# O wrapper tem que ser o do commit BASE, nao a working tree: patcher rodando
# contra arvore ja patchada nao muda nada, e "nao mudou nada" e indistinguivel
# de "nao aplicou". Foi esse exato falso vermelho que apareceu na primeira
# versao deste gate.
BASE="${GATE_BASE_COMMIT:-b2a14e0}"
rm -rf "$PRISTINO" && mkdir -p "$PRISTINO"
git -C "$RAIZ" archive "$BASE" | tar x -C "$PRISTINO" || {
  echo "FALHOU: nao consegui exportar o wrapper em $BASE"; exit 2; }

echo "=============== 1/3  harness contra a versao ATUAL ==============="
"$PY" "$RAIZ/tests/harness_patchers.py" --core "$ATUAL" --wrapper "$PRISTINO" \
  --json "$SAIDA/harness-atual.json" | tee "$SAIDA/harness-atual.txt" | sed -n '1,20p'

echo
echo "=============== 2/3  calibracao do harness ==============="
if ! "$PY" "$RAIZ/tests/test_harness_reproduz_baseline.py" --resultado "$SAIDA/harness-atual.json"; then
  echo
  echo "GATE ABORTADO: o harness nao reproduz o baseline de producao."
  echo "Nenhum veredito dele vale enquanto isso nao for corrigido."
  exit 1
fi

echo
echo "=============== 3/3  harness contra a versao ALVO ==============="
"$PY" "$RAIZ/tests/harness_patchers.py" --core "$ALVO" --wrapper "$PRISTINO" \
  --json "$SAIDA/harness-alvo.json" | tee "$SAIDA/harness-alvo.txt" | sed -n '1,20p'

echo
echo "=============== veredito ==============="
"$PY" - "$SAIDA/harness-atual.json" "$SAIDA/harness-alvo.json" <<'PY'
import json, pathlib, sys
atual = json.loads(pathlib.Path(sys.argv[1]).read_text())
alvo = json.loads(pathlib.Path(sys.argv[2]).read_text())

# Severidade, do melhor para o pior. Comparar so GREEN contra nao-GREEN deixava
# passar piora entre dois estados ruins -- foi assim que a segunda regressao do
# bump (model_routing indo de NAO-IDEMPOTENTE para RED) quase escapou.
SEVERIDADE = {"GREEN": 0, "RED-NAO-IDEMPOTENTE": 1, "RED-FALSO-VERDE": 2, "RED": 3}

regressoes, preexistentes, incomparaveis = [], [], []
for nome in sorted(atual):
    a, b = atual[nome]["veredito"], alvo.get(nome, {}).get("veredito", "AUSENTE")
    sa, sb = SEVERIDADE.get(a), SEVERIDADE.get(b)
    if sa is None or sb is None:
        # INCONCLUSIVO, ESTATICO, N-A: estado desconhecido, nao da para comparar.
        # Some do veredito de propositio, e listado a parte -- transformar
        # "nao sei" em verde ou vermelho seria inventar evidencia.
        incomparaveis.append((nome, a, b))
    elif sb > sa:
        regressoes.append((nome, a, b, alvo[nome].get("saida", "")[-300:]))
    elif sa > 0:
        preexistentes.append((nome, a))

nomes_regredidos = {n for n, *_ in regressoes}
print(f"{'patcher':<46}{'atual':<22}{'alvo':<22}")
print("-" * 92)
for nome in sorted(atual):
    a = atual[nome]["veredito"]
    b = alvo.get(nome, {}).get("veredito", "AUSENTE")
    marca = "  <== REGRESSAO" if nome in nomes_regredidos else ""
    print(f"{nome:<46}{a:<22}{b:<22}{marca}")

print()
if incomparaveis:
    print("SEM VEREDITO (estado desconhecido, nao conta como verde nem vermelho):")
    for nome, a, b in incomparaveis:
        print(f"  - {nome}: {a} / {b}")
    print()

if preexistentes:
    print("PRE-EXISTENTES (nao barram o release, entram como baseline assinado):")
    for nome, a in preexistentes:
        print(f"  - {nome}: {a}")
    print()

if regressoes:
    print(f"GATE VERMELHO: {len(regressoes)} regressao(oes) causada(s) pelo bump\n")
    for nome, a, b, saida in regressoes:
        print(f"--- {nome}: {a} -> {b}")
        for linha in saida.strip().splitlines()[-4:]:
            print(f"    | {linha}")
        print()
    sys.exit(1)

print("GATE VERDE: nenhum patcher regrediu com o bump.")
print("Limite desta prova: ela mostra que o patch APLICA, nao que o comportamento")
print("em runtime esta correto. Isso continua sendo trabalho do canario.")
PY
rc=$?
echo
echo "evidencias em: $SAIDA"
exit $rc
