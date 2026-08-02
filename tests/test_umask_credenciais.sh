#!/usr/bin/env bash
# Prova que o start.sh fixa umask 0077 e que isso tem EFEITO: arquivo novo
# nasce 0600, diretorio novo nasce 0700.
#
# Motivo do teste: os 3460 arquivos de sessao do WhatsApp em producao estao
# 0644 porque o umask do container e 0022 e o Baileys escreve com fs.writeFile
# puro. Medido 2026-08-02: ctime == mtime em todos, ou seja nunca houve chmod.
# Ver docs/hermes/auditoria-permissoes-sessao-whatsapp-2026-08-02.md.
#
# O teste inclui uma PROVA DE VERMELHO: repete a mesma medicao sob o umask 0022
# de hoje e exige 0644. Teste que nao consegue ficar vermelho nao mede nada --
# foi assim que o skip patch do tasks_router passou meses despercebido.
#
#   bash tests/test_umask_credenciais.sh
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

modo() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }

# 1. A diretiva existe, lida do start.sh real (nao de uma copia mantida a mao).
linha_umask="$(grep -n '^umask ' "$RAIZ/start.sh" | head -1 | cut -d: -f1)"
valor_umask="$(grep -m1 '^umask ' "$RAIZ/start.sh" | awk '{print $2}')"
checa "start.sh define um umask" "${linha_umask:+sim}" "sim"
checa "o valor e 0077" "$valor_umask" "0077"

# 2. Vem ANTES do primeiro mkdir -- senao os diretorios ainda nascem frouxos.
linha_mkdir="$(grep -n '^mkdir ' "$RAIZ/start.sh" | head -1 | cut -d: -f1)"
if [ -n "$linha_umask" ] && [ -n "$linha_mkdir" ]; then
  antes=$([ "$linha_umask" -lt "$linha_mkdir" ] && echo sim || echo nao)
  checa "umask (linha $linha_umask) vem antes do primeiro mkdir (linha $linha_mkdir)" "$antes" "sim"
else
  checa "consegui localizar umask e mkdir no start.sh" "nao" "sim"
fi

# 3. EFEITO com o umask novo: arquivo 0600, diretorio 0700.
(
  umask "$valor_umask"
  mkdir -p "$TMP/novo/sub"
  : > "$TMP/novo/creds.json"
)
checa "sob 0077 um arquivo novo nasce 0600" "$(modo "$TMP/novo/creds.json")" "600"
checa "sob 0077 um diretorio novo nasce 0700" "$(modo "$TMP/novo/sub")" "700"

# 4. PROVA DE VERMELHO: sob o umask 0022 de producao hoje, o mesmo arquivo
#    nasce 0644. Se esta parte falhar, a medicao acima nao distingue nada.
(
  umask 0022
  mkdir -p "$TMP/velho/sub"
  : > "$TMP/velho/creds.json"
)
checa "prova de vermelho: sob 0022 o arquivo nasce 0644" "$(modo "$TMP/velho/creds.json")" "644"
checa "prova de vermelho: sob 0022 o diretorio nasce 0755" "$(modo "$TMP/velho/sub")" "755"

# 5. O start.sh continua sintaticamente valido.
if bash -n "$RAIZ/start.sh" 2>"$TMP/erro"; then
  checa "bash -n no start.sh" "ok" "ok"
else
  checa "bash -n no start.sh" "$(cat "$TMP/erro")" "ok"
fi

echo
if [ "$falhas" -eq 0 ]; then
  echo "8/8 OK"
else
  echo "$falhas falha(s)"
fi
exit "$falhas"
