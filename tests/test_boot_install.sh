#!/usr/bin/env bash
# test_boot_install.sh — testes da instalacao do Tailscale no hermes-boot.sh.
#
# Exercita ts_ensure/ts_install atraves do hook TS_INSTALL_ONLY=1: nao sobe daemon,
# nao toca no serve, nao encadeia o start.sh. Servidor HTTP local + tarballs
# forjados; nada sai para a rede nem para producao.
#
# Uso: bash tests/test_boot_install.sh
#
# Nota de portabilidade: a troca do ponteiro usa `mv -T` (GNU) com fallback `mv -h`
# (BSD). Rodando no macOS este teste exercita o ramo BSD; producao (Debian) usa o
# GNU. Os dois ramos estao cobertos entre teste local e runtime real.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
BOOT="$HERE/../hermes-boot.sh"
WORK="$(mktemp -d)"
SRV="$WORK/pkgs"
BINROOT="$WORK/bin/ts"
SUMS="$WORK/checksums.txt"
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64)        ARCH=amd64;;
  aarch64|arm64) ARCH=arm64;;
  *)             echo "arch $ARCH_RAW nao suportada pelo teste"; exit 2;;
esac

PASSED=0; FAILED=0
pass(){ PASSED=$((PASSED + 1)); printf '  ok    %s\n' "$1"; }
fail(){ FAILED=$((FAILED + 1)); printf '  FAIL  %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; return 0; }
assert_eq(){ if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "esperado='$3' obtido='$2'"; fi; }
assert_contains(){ case "$2" in *"$3"*) pass "$1";; *) fail "$1" "nao contem '$3'";; esac; }

cleanup(){ [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$SRV" "$WORK/bin"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

# make_tgz <versao-no-nome> <arch> [versao-reportada-pelo-binario]
# A terceira permite forjar um tarball cujo conteudo mente sobre a versao,
# que e o que o self-test tem que pegar.
make_tgz(){
  local ver="$1" arch="$2" rep="${3:-$1}" d="$WORK/build" b
  rm -rf "$d"; mkdir -p "$d/tailscale_${ver}_${arch}"
  for b in tailscaled tailscale; do
    printf '#!/bin/sh\necho "%s"\n' "$rep" > "$d/tailscale_${ver}_${arch}/$b"
    chmod 0755 "$d/tailscale_${ver}_${arch}/$b"
  done
  COPYFILE_DISABLE=1 tar -czf "$SRV/tailscale_${ver}_${arch}.tgz" -C "$d" "tailscale_${ver}_${arch}"
  rm -rf "$d"
}

sum_of(){ sha256sum "$1" 2>/dev/null | awk '{print $1}'; }

# run_install <versao-desejada> [VAR=VAL ...]
run_install(){
  local ver="$1"; shift
  env TS_INSTALL_ONLY=1 \
      TS_BIN_ROOT="$BINROOT" \
      TS_PKGS_BASE="http://127.0.0.1:$PORT" \
      TS_CHECKSUMS_FILE="$SUMS" \
      TS_VERSION="$ver" \
      TS_STATE_DIR="$WORK/tsstate" \
      "$@" \
      bash "$BOOT" 2>&1
}

active(){ readlink "$BINROOT/current" 2>/dev/null; }
binver(){ "$BINROOT/current/$1" --version 2>/dev/null | head -1; }

# ---------------------------------------------------------------------------
# servidor HTTP local
# ---------------------------------------------------------------------------
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
( cd "$SRV" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) &
SRV_PID=$!
disown "$SRV_PID" 2>/dev/null || true   # sem isso o bash imprime "Terminated: 15" no fim
for _ in $(seq 1 40); do
  curl -sf -m 1 -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 0.1
done

echo "== instalacao do tailscale (arch=$ARCH, porta=$PORT) =="

# ---------------------------------------------------------------------------
# T1 — happy path
# ---------------------------------------------------------------------------
make_tgz 1.98.9 "$ARCH"
{
  echo "# tabela de teste"
  echo "1.98.9  $ARCH  $(sum_of "$SRV/tailscale_1.98.9_$ARCH.tgz")"
} > "$SUMS"

OUT="$(run_install 1.98.9)"
assert_contains "T1 loga instalacao ativa"      "$OUT" "1.98.9 ativo"
assert_eq       "T1 ponteiro aponta pra versao" "$(active)" "1.98.9"
assert_eq       "T1 tailscaled responde"        "$(binver tailscaled)" "1.98.9"
assert_eq       "T1 tailscale responde"         "$(binver tailscale)"  "1.98.9"
if [ -L "$BINROOT/current" ]; then pass "T1 current e symlink"; else fail "T1 current e symlink"; fi

# ---------------------------------------------------------------------------
# T2 — idempotencia: segunda execucao nao reinstala
# ---------------------------------------------------------------------------
OUT="$(run_install 1.98.9)"
assert_contains "T2 detecta que ja esta ativo" "$OUT" "ja ativo"

# ---------------------------------------------------------------------------
# T3 — checksum divergente: nao instala, mantem o anterior
# ---------------------------------------------------------------------------
make_tgz 1.99.0 "$ARCH"
{
  echo "1.98.9  $ARCH  $(sum_of "$SRV/tailscale_1.98.9_$ARCH.tgz")"
  echo "1.99.0  $ARCH  0000000000000000000000000000000000000000000000000000000000000000"
} > "$SUMS"

OUT="$(run_install 1.99.0)"
assert_contains "T3 detecta checksum divergente" "$OUT" "CHECKSUM MISMATCH"
assert_contains "T3 anuncia o fail-safe"         "$OUT" "SEGUE com o binario anterior"
assert_eq       "T3 ponteiro NAO mudou"          "$(active)" "1.98.9"
assert_eq       "T3 binario anterior intacto"    "$(binver tailscaled)" "1.98.9"

# ---------------------------------------------------------------------------
# T4 — versao ausente da tabela do repo: nao instala
# ---------------------------------------------------------------------------
make_tgz 2.0.0 "$ARCH"
OUT="$(run_install 2.0.0)"
assert_contains "T4 recusa versao fora da tabela" "$OUT" "sem checksum no repo"
assert_eq       "T4 ponteiro NAO mudou"           "$(active)" "1.98.9"

# ---------------------------------------------------------------------------
# T5 — tarball corrompido com checksum "correto": tar falha, mantem anterior
# ---------------------------------------------------------------------------
printf 'isto nao e um tarball' > "$SRV/tailscale_1.99.1_$ARCH.tgz"
{
  echo "1.98.9  $ARCH  $(sum_of "$SRV/tailscale_1.98.9_$ARCH.tgz")"
  echo "1.99.1  $ARCH  $(sum_of "$SRV/tailscale_1.99.1_$ARCH.tgz")"
} > "$SUMS"

OUT="$(run_install 1.99.1)"
assert_contains "T5 tar falha"                "$OUT" "tar falhou"
assert_eq       "T5 ponteiro NAO mudou"       "$(active)" "1.98.9"

# ---------------------------------------------------------------------------
# T6 — self-test reprova: tarball diz 1.99.2, binario dentro reporta 0.0.1
# ---------------------------------------------------------------------------
make_tgz 1.99.2 "$ARCH" 0.0.1
{
  echo "1.98.9  $ARCH  $(sum_of "$SRV/tailscale_1.98.9_$ARCH.tgz")"
  echo "1.99.2  $ARCH  $(sum_of "$SRV/tailscale_1.99.2_$ARCH.tgz")"
} > "$SUMS"

OUT="$(run_install 1.99.2)"
assert_contains "T6 self-test reprova"        "$OUT" "self-test reprovou"
assert_eq       "T6 nao promove"              "$(active)" "1.98.9"
assert_eq       "T6 binario anterior intacto" "$(binver tailscaled)" "1.98.9"

# ---------------------------------------------------------------------------
# T7 — arch desconhecida: mantem o anterior, NUNCA cai em amd64
# ---------------------------------------------------------------------------
mkdir -p "$WORK/stub"
printf '#!/bin/sh\necho "risc-v-imaginario"\n' > "$WORK/stub/uname"
chmod 0755 "$WORK/stub/uname"
OUT="$(PATH="$WORK/stub:$PATH" run_install 1.98.9)"
assert_contains "T7 recusa arch desconhecida" "$OUT" "nao suportada"
case "$OUT" in
  *amd64*) fail "T7 nao menciona fallback amd64" "output cita amd64";;
  *)       pass "T7 nao menciona fallback amd64";;
esac
assert_eq "T7 ponteiro NAO mudou" "$(active)" "1.98.9"

# ---------------------------------------------------------------------------
# T8 — download falho (na tabela, ausente no servidor)
# ---------------------------------------------------------------------------
{
  echo "1.98.9  $ARCH  $(sum_of "$SRV/tailscale_1.98.9_$ARCH.tgz")"
  echo "1.99.3  $ARCH  1111111111111111111111111111111111111111111111111111111111111111"
} > "$SUMS"
OUT="$(run_install 1.99.3)"
assert_contains "T8 detecta download falho" "$OUT" "download falhou"
assert_eq       "T8 ponteiro NAO mudou"     "$(active)" "1.98.9"

# ---------------------------------------------------------------------------
# T9 — TS_SKIP_UPGRADE=1 congela sem mudanca de codigo
# ---------------------------------------------------------------------------
make_tgz 1.99.4 "$ARCH"
{
  echo "1.98.9  $ARCH  $(sum_of "$SRV/tailscale_1.98.9_$ARCH.tgz")"
  echo "1.99.4  $ARCH  $(sum_of "$SRV/tailscale_1.99.4_$ARCH.tgz")"
} > "$SUMS"
OUT="$(run_install 1.99.4 TS_SKIP_UPGRADE=1)"
assert_contains "T9 respeita TS_SKIP_UPGRADE" "$OUT" "TS_SKIP_UPGRADE=1"
assert_eq       "T9 ponteiro NAO mudou"       "$(active)" "1.98.9"

# ---------------------------------------------------------------------------
# T10 — upgrade real: ponteiro passa a apontar pra nova, anterior fica p/ rollback
# ---------------------------------------------------------------------------
OUT="$(run_install 1.99.4)"
assert_contains "T10 instala a nova"          "$OUT" "1.99.4 ativo"
assert_eq       "T10 ponteiro atualizado"     "$(active)" "1.99.4"
assert_eq       "T10 binario novo responde"   "$(binver tailscaled)" "1.99.4"
if [ -d "$BINROOT/1.98.9" ]; then pass "T10 anterior mantida p/ rollback offline"; else fail "T10 anterior mantida p/ rollback offline"; fi

# ---------------------------------------------------------------------------
# T11 — GC: uma terceira versao poda a mais antiga (mantem ativa + anterior)
# ---------------------------------------------------------------------------
make_tgz 1.99.5 "$ARCH"
{
  echo "1.99.5  $ARCH  $(sum_of "$SRV/tailscale_1.99.5_$ARCH.tgz")"
} > "$SUMS"
OUT="$(run_install 1.99.5)"
assert_eq "T11 ponteiro na mais nova" "$(active)" "1.99.5"
if [ -d "$BINROOT/1.99.4" ]; then pass "T11 mantem a anterior"; else fail "T11 mantem a anterior"; fi
if [ -d "$BINROOT/1.98.9" ]; then fail "T11 poda a mais antiga" "1.98.9 ainda existe"; else pass "T11 poda a mais antiga"; fi

# ---------------------------------------------------------------------------
# T12 — nenhum stage sobra apos os ciclos
# ---------------------------------------------------------------------------
LEFT="$(find "$BINROOT" -maxdepth 1 -name '.stage.*' 2>/dev/null | wc -l | tr -d ' ')"
assert_eq "T12 sem stage orfao" "$LEFT" "0"

# ---------------------------------------------------------------------------
# T13 — ROLLBACK OFFLINE de verdade: servidor de pacotes DESLIGADO.
# Estado: current=1.99.5, cache tem 1.99.4. Pedir 1.99.4 sem rede tem que
# promover do cache. Nao basta o diretorio existir -- o teste executa o rollback.
# ---------------------------------------------------------------------------
kill "$SRV_PID" 2>/dev/null
SRV_PID=""
sleep 0.5

OUT="$(run_install 1.99.4)"
assert_contains "T13 promove do cache sem rede"    "$OUT" "promovido do cache local"
assert_eq       "T13 ponteiro voltou pra anterior" "$(active)" "1.99.4"
assert_eq       "T13 binario anterior responde"    "$(binver tailscaled)" "1.99.4"
case "$OUT" in
  *"download falhou"*) fail "T13 nao tenta a rede" "tentou baixar mesmo com cache valido";;
  *)                   pass "T13 nao tenta a rede";;
esac

# ---------------------------------------------------------------------------
# T14 — cache corrompido reprova no self-test e NAO e promovido.
# Sem rede para cair de volta, o ponteiro tem que ficar onde estava.
# ---------------------------------------------------------------------------
printf 'lixo truncado' > "$BINROOT/1.99.5/tailscaled"
OUT="$(run_install 1.99.5)"
assert_contains "T14 cache corrompido reprova"  "$OUT" "reprovou no self-test"
assert_eq       "T14 ponteiro NAO mudou"        "$(active)" "1.99.4"
assert_eq       "T14 binario ativo intacto"     "$(binver tailscaled)" "1.99.4"

# ---------------------------------------------------------------------------
# T15 — guarda sobre a tabela REAL do repo: arm64 so volta com validacao
# independente. Sem esse teste, um hash de fonte unica reentra sem revisao.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# T16 — FAIL-SAFE NA PROMOCAO: forca o `mv` do incoming para o dir versionado a
# falhar, reinstalando a MESMA versao para onde `current` aponta. Antes isto
# deixava o ponteiro pendurado (o dir era apagado antes do mv) enquanto o log
# afirmava "segue com o binario anterior".
# ---------------------------------------------------------------------------
( cd "$SRV" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) &
SRV_PID=$!
disown "$SRV_PID" 2>/dev/null || true
for _ in $(seq 1 40); do curl -sf -m 1 -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.1; done

# estado limpo: instala 3.0.0 e deixa `current` nela
BINROOT="$WORK/bin2/ts"
make_tgz 3.0.0 "$ARCH"
echo "3.0.0  $ARCH  $(sum_of "$SRV/tailscale_3.0.0_$ARCH.tgz")" > "$SUMS"
run_install 3.0.0 >/dev/null
assert_eq "T16 preparo: 3.0.0 ativa" "$(active)" "3.0.0"

# corrompe o binario ATIVO -> o gate decide reinstalar a mesma versao
printf 'corrompido' > "$BINROOT/3.0.0/tailscaled"

# stub de mv que falha SO na promocao incoming -> dir versionado
mkdir -p "$WORK/stubmv"
cat > "$WORK/stubmv/mv" <<'STUB'
#!/bin/sh
case "$*" in
  *.stage.*)    exec /bin/mv "$@" ;;   # stage -> incoming: deixa passar
  *.incoming.*) exit 1 ;;              # incoming -> destino: FALHA
esac
exec /bin/mv "$@"
STUB
chmod 0755 "$WORK/stubmv/mv"

OUT="$(PATH="$WORK/stubmv:$PATH" run_install 3.0.0)"
assert_contains "T16 detecta a promocao falha" "$OUT" "promocao falhou"
if [ -d "$BINROOT/3.0.0" ]; then pass "T16 destino anterior preservado"; else fail "T16 destino anterior preservado" "dir apagado"; fi
if [ -d "$BINROOT/current" ]; then pass "T16 ponteiro NAO fica pendurado"; else fail "T16 ponteiro NAO fica pendurado" "current pendurado"; fi

# mesmo cenario, mas sem nenhuma versao cacheada valida: o ponteiro tem que ser
# removido e o log tem que dizer, em vez de mentir sobre o fail-safe
rm -rf "$BINROOT/3.0.0"
OUT="$(PATH="$WORK/stubmv:$PATH" run_install 3.0.0)"
if [ -L "$BINROOT/current" ]; then fail "T16 ponteiro pendurado e removido" "current continua pendurado"; else pass "T16 ponteiro pendurado e removido"; fi
assert_contains "T16 avisa em vez de mentir" "$OUT" "ponteiro pendurado"

BINROOT="$WORK/bin/ts"   # restaura o root dos demais testes

# ---------------------------------------------------------------------------
# T17 — guarda sobre a tabela REAL do repo
# ---------------------------------------------------------------------------
REAL_SUMS="$HERE/../tailscale-checksums.txt"
if grep -qE '^[0-9.]+[[:space:]]+arm64[[:space:]]' "$REAL_SUMS" 2>/dev/null; then
  fail "T17 tabela do repo sem arm64" "arm64 presente sem validacao independente"
else
  pass "T17 tabela do repo sem arm64"
fi
if grep -qE '^1\.98\.9[[:space:]]+amd64[[:space:]]+11be30ad' "$REAL_SUMS" 2>/dev/null; then
  pass "T17 pin amd64 presente na tabela do repo"
else
  fail "T17 pin amd64 presente na tabela do repo"
fi

echo
echo "passou: $PASSED   falhou: $FAILED"
[ "$FAILED" -eq 0 ]
