#!/usr/bin/env bash
# O bootstrap tem que RELATAR o que falhou, e nao derrubar o boot por padrao.
#
# Motivo do teste existir: a correcao obvia para "patcher falha em silencio" e
# fail-closed. Mas hoje ha patcher vermelho conhecido em producao, entao
# fail-closed por padrao trocaria "degradado calado" por "fora do ar" no proximo
# boot. O comportamento correto e tolerante-com-relatorio por padrao, estrito
# apenas sob IRIS_BOOTSTRAP_STRICT=1. Este teste trava esse contrato.
#
#   bash tests/test_bootstrap_relatorio.sh
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOTSTRAP="$RAIZ/scripts/volume/iris_pre_server_bootstrap.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

falhas=0
checa(){ if [ "$2" = "$3" ]; then printf 'OK   %s\n' "$1"; else
  printf 'FAIL %s\n       esperado: %s\n       obtido:   %s\n' "$1" "$3" "$2"; falhas=$((falhas+1)); fi; }

prepara(){
  local home="$1" modo="$2"   # modo: ok | falha
  mkdir -p "$home/scripts" "$home/logs" "$home/runtime"
  for n in ensure_allocator_bootstrap ensure_tini_bootstrap ensure_persistent_mcp_binaries \
           ensure_codex_only ensure_codex_oauth_gateway_autostart apply_iris_ops_runtime_patches \
           apply_iris_model_routing_patch apply_iris_cron_whatsapp_context_patch \
           apply_iris_whatsapp_owner_groups_patch ensure_whatsapp_group_routes \
           apply_iris_journal_group_capture_patch apply_iris_tasks_router_gateway_patch; do
    printf 'import sys\nsys.exit(0)\n' > "$home/scripts/$n.py"
  done
  if [ "$modo" = "falha" ]; then
    printf 'import sys\nprint("estourei")\nsys.exit(1)\n' \
      > "$home/scripts/apply_iris_cron_whatsapp_context_patch.py"
  fi
}

# O bootstrap invoca `python`, que existe no container mas nao no macOS (so
# `python3`). Sem este shim TODO patcher falharia e o teste daria vermelho por
# motivo errado -- exatamente o falso vermelho que o harness aprendeu a evitar.
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nexec python3 "$@"\n' > "$TMP/bin/python"
chmod +x "$TMP/bin/python"

roda(){  # $1=home  $2=strict
  ( cd "$1" && PATH="$TMP/bin:$PATH" HERMES_HOME="$1" FOXY_HERMES_HOME="$1/foxy" \
      IRIS_BOOTSTRAP_STRICT="$2" IRIS_WATCHDOGS_STARTED=1 \
      bash "$BOOTSTRAP" >/dev/null 2>&1 )
  echo $?
}

# 1 — tudo ok: relatorio com zero falhas, exit 0
A="$TMP/ok"; prepara "$A" ok
rc=$(roda "$A" 0)
checa "tudo ok: exit 0" "$rc" "0"
checa "tudo ok: zero falhas no relatorio" \
  "$(python3 -c "import json;print(json.load(open('$A/runtime/bootstrap-patchers.json'))['falhas'])" 2>/dev/null)" "0"

# 2 — um patcher falha, modo tolerante: boot SEGUE e o relatorio acusa
B="$TMP/tolerante"; prepara "$B" falha
rc=$(roda "$B" 0)
checa "patcher falho, tolerante: boot segue (exit 0)" "$rc" "0"
checa "patcher falho, tolerante: relatorio conta 1 falha" \
  "$(python3 -c "import json;print(json.load(open('$B/runtime/bootstrap-patchers.json'))['falhas'])" 2>/dev/null)" "1"
checa "patcher falho, tolerante: nomeia quem falhou" \
  "$(python3 -c "import json;print(json.load(open('$B/runtime/bootstrap-patchers.json'))['apply_iris_cron_whatsapp_context_patch'])" 2>/dev/null)" "falhou"

# 3 — mesmo patcher falho, modo estrito: boot ABORTA
C="$TMP/estrito"; prepara "$C" falha
rc=$(roda "$C" 1)
checa "patcher falho, estrito: boot aborta (exit 1)" "$rc" "1"
checa "patcher falho, estrito: relatorio diz onde abortou" \
  "$(python3 -c "import json;print(json.load(open('$C/runtime/bootstrap-patchers.json'))['aborted_on'])" 2>/dev/null)" \
  "apply_iris_cron_whatsapp_context_patch"

# 4 — o default NAO pode ser estrito. Se alguem inverter isso, a Iris nao sobe.
D="$TMP/default"; prepara "$D" falha
rc=$( ( cd "$D" && PATH="$TMP/bin:$PATH" HERMES_HOME="$D" FOXY_HERMES_HOME="$D/foxy" \
        IRIS_WATCHDOGS_STARTED=1 bash "$BOOTSTRAP" >/dev/null 2>&1 ); echo $? )
checa "default e tolerante (sem a var definida)" "$rc" "0"

echo
if [ "$falhas" -eq 0 ]; then echo "6/6 OK"; exit 0; fi
echo "$falhas falha(s)"; exit 1
