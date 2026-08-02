#!/usr/bin/env bash
# Prova que o bloco de semente do config no start.sh nao sobrescreve config
# existente -- e que a semente ainda funciona quando o volume esta vazio.
#
# Nao roda o start.sh inteiro (ele faz exec do server.py). Extrai so o bloco
# de semente e executa contra um HOME descartavel.
#
#   bash tests/test_config_seed_nao_sobrescreve.sh
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

falhas=0
checa() {
  if [ "$2" = "$3" ]; then
    printf 'OK   %s\n' "$1"
  else
    printf 'FAIL %s\n       esperado: %s\n       obtido:   %s\n' "$1" "$3" "$2"
    falhas=$((falhas + 1))
  fi
}

# Extrai o bloco de semente do start.sh real (nao uma copia mantida a mao:
# se o start.sh mudar, este teste passa a exercitar a versao nova).
sed -n '/^# Config: SEMENTE, não sobrescrita\./,/^fi$/p' "$RAIZ/start.sh" > "$TMP/bloco.sh"
if ! grep -q 'IRIS_FORCE_CONFIG_SEED' "$TMP/bloco.sh"; then
  echo "FAIL: nao consegui extrair o bloco de semente do start.sh"
  exit 1
fi

roda() {
  # $1 = raiz falsa; reescreve os caminhos absolutos para dentro dela
  local raiz="$1"; shift
  sed -e "s#/data/.hermes#${raiz}/data/.hermes#g" \
      -e "s#/app/deploy-config.yaml#${raiz}/app/deploy-config.yaml#g" \
      -e "s#/opt/hermes-agent#${raiz}/opt/hermes-agent#g" \
      "$TMP/bloco.sh" > "$raiz/run.sh"
  ( cd "$raiz" && env "$@" bash "$raiz/run.sh" 2>/dev/null )
}

prepara() {
  local raiz="$1"
  mkdir -p "$raiz/data/.hermes" "$raiz/app" "$raiz/opt/hermes-agent"
  echo "SEMENTE-DA-IMAGEM" > "$raiz/app/deploy-config.yaml"
  echo "EXEMPLO-DO-CORE"   > "$raiz/opt/hermes-agent/cli-config.yaml.example"
}

# Caso 1 — volume vazio: tem que semear a partir da imagem.
A="$TMP/vazio"; mkdir -p "$A"; prepara "$A"
roda "$A" IRIS_FORCE_CONFIG_SEED=0
checa "volume vazio semeia da imagem" "$(cat "$A/data/.hermes/config.yaml" 2>/dev/null)" "SEMENTE-DA-IMAGEM"

# Caso 2 — config existente: NAO pode ser tocado. E o caso dos grupos do John.
B="$TMP/existente"; mkdir -p "$B"; prepara "$B"
printf 'CONFIG-VIVO-COM-ALLOWLIST-DOS-GRUPOS\n' > "$B/data/.hermes/config.yaml"
roda "$B" IRIS_FORCE_CONFIG_SEED=0
checa "config existente preservado" "$(cat "$B/data/.hermes/config.yaml")" "CONFIG-VIVO-COM-ALLOWLIST-DOS-GRUPOS"

# Caso 3 — escape hatch explicito: reimpoe o config da imagem.
C="$TMP/forcado"; mkdir -p "$C"; prepara "$C"
printf 'CONFIG-VIVO-COM-ALLOWLIST-DOS-GRUPOS\n' > "$C/data/.hermes/config.yaml"
roda "$C" IRIS_FORCE_CONFIG_SEED=1
checa "IRIS_FORCE_CONFIG_SEED=1 reimpoe" "$(cat "$C/data/.hermes/config.yaml")" "SEMENTE-DA-IMAGEM"

# Caso 4 — volume vazio e sem deploy-config: cai no exemplo do core.
D="$TMP/sem-seed"; mkdir -p "$D"; prepara "$D"; rm -f "$D/app/deploy-config.yaml"
roda "$D" IRIS_FORCE_CONFIG_SEED=0
checa "fallback para o exemplo do core" "$(cat "$D/data/.hermes/config.yaml" 2>/dev/null)" "EXEMPLO-DO-CORE"

# Caso 5 — prova de VERMELHO: o comportamento ANTIGO falharia o caso 2.
E="$TMP/antigo"; mkdir -p "$E"; prepara "$E"
printf 'CONFIG-VIVO-COM-ALLOWLIST-DOS-GRUPOS\n' > "$E/data/.hermes/config.yaml"
cp "$E/app/deploy-config.yaml" "$E/data/.hermes/config.yaml"   # o cp incondicional de antes
if [ "$(cat "$E/data/.hermes/config.yaml")" = "SEMENTE-DA-IMAGEM" ]; then
  printf 'OK   comportamento antigo comprovadamente destruia o config (prova de vermelho)\n'
else
  printf 'FAIL prova de vermelho nao reproduziu\n'; falhas=$((falhas + 1))
fi

echo
if [ "$falhas" -eq 0 ]; then
  echo "5/5 OK"
  exit 0
fi
echo "$falhas falha(s)"
exit 1
