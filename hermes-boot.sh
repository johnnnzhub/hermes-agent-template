#!/usr/bin/env bash
# hermes-boot.sh v3 — reintroduz Tailscale (tailnet-only) no container Railway.
# Dashboard segue LOCAL em 127.0.0.1:9119 (server.py o sobe); quem publica na
# tailnet e o `tailscale serve` (https=443). Com IRIS_TERMINAL_ENABLED, o bridge
# Terminal Mode continua LOCAL em 127.0.0.1:3456 e ganha listener tailnet-only
# separado (https=8443). SEM Funnel (nada publico). SEM dashboard
# 0.0.0.0/--insecure. Encadeia o /app/start.sh ORIGINAL (start.sh -> exec
# server.py: gateway/MCP/healthcheck publicos intactos).
#
# Startup chain: railway.toml startCommand=/app/hermes-boot.sh
#   -> sobe tailscaled+serve em BACKGROUND -> exec /app/start.sh
# Vars (Railway service, NUNCA no repo): TS_AUTHKEY (reusavel), TS_HOSTNAME (default hermes-g2).
# Vars opcionais de instalacao: TS_VERSION (pin, default 1.98.9), TS_SKIP_UPGRADE=1
#   (freio de emergencia sem mudanca de codigo), TS_PKGS_BASE, TS_CHECKSUMS_FILE,
#   TS_BIN_ROOT (as tres ultimas existem para os testes poderem redirecionar).
# Pegadinha: env PORT=8080 do Railway quebra o TLS do Tailscale -> env -u PORT sempre.
# Pegadinha: `set -u` SEM `-e` e proposital. Com `-e`, um curl falho mataria o boot;
#   todo o fail-safe da instalacao depende de falha nao ser fatal.
set -u
DRY_RUN="${DRY_RUN:-0}"
TS_STATE_DIR="${TS_STATE_DIR:-/data/.tailscale}"
TS_SOCK="/var/run/tailscale/tailscaled.sock"
TS_TAILNET="${TS_TAILNET:-tail390702.ts.net}"
TS_HOSTNAME="${TS_HOSTNAME:-hermes-g2}"
TS_FQDN="${TS_HOSTNAME}.${TS_TAILNET}"
DASH_PORT="${DASH_PORT:-9119}"   # dashboard LOCAL existente (server.py spawna)
PROXY_PORT="${HOSTPROXY_PORT:-9200}"   # hostproxy loopback (Host-rewrite) -> dashboard
TERMINAL_PORT="${IRIS_TERMINAL_PORT:-3456}"   # bridge Terminal Mode, sempre loopback
TERMINAL_TS_PORT="${IRIS_TERMINAL_TS_PORT:-8443}"   # listener HTTPS separado na tailnet
TERMINAL_READY_ATTEMPTS="${IRIS_TERMINAL_READY_ATTEMPTS:-30}"
TERMINAL_READY_DELAY="${IRIS_TERMINAL_READY_DELAY:-2}"
# Versao pinada + checksums controlados no repo (ver tailscale-checksums.txt).
# O pin e REPRODUTIBILIDADE e ROLLBACK -- nao e correcao comprovada da perda no DERP.
TS_VERSION="${TS_VERSION:-1.98.9}"; TS_VERSION="${TS_VERSION#v}"
TS_PKGS_BASE="${TS_PKGS_BASE:-https://pkgs.tailscale.com/stable}"
TS_CHECKSUMS_FILE="${TS_CHECKSUMS_FILE:-/app/tailscale-checksums.txt}"
TS_BIN_ROOT="${TS_BIN_ROOT:-/data/bin/ts}"
# ts/current PRIMEIRO: e o ponteiro trocado atomicamente pelo ts_install. Se ele
# faltar ou estiver pendurado, o `command -v` cai para /data/bin (binarios antigos)
# em vez de ficar sem tailscale -- o estado anterior vira fallback, nao ponto de falha.
export PATH="$TS_BIN_ROOT/current:/data/bin:$PATH"

log(){ echo "[hermes-boot-v3] $*"; }
ts(){ env -u PORT tailscale --socket="$TS_SOCK" "$@"; }
running(){ ts status >/dev/null 2>&1; }
terminal_enabled(){
  case "${IRIS_TERMINAL_ENABLED:-0}" in
    1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) return 0;;
    *) return 1;;
  esac
}
terminal_ts_port_safe(){
  case "$TERMINAL_TS_PORT" in
    ""|*[!0-9]*|443)
      log "WARN: IRIS_TERMINAL_TS_PORT invalida/colide com dashboard; listener Terminal Mode ignorado"
      return 1
      ;;
  esac
  [ "$TERMINAL_TS_PORT" -ge 1 ] 2>/dev/null \
    && [ "$TERMINAL_TS_PORT" -le 65535 ] 2>/dev/null
}
terminal_remove_default_listener(){
  # Um valor invalido nao pode impedir o rollback do listener padrao que pode
  # ter ficado persistido por um deploy anterior. Nunca toca no dashboard 443.
  ts funnel --https=8443 off 2>/dev/null || true
  ts serve --https=8443 off 2>/dev/null || true
}

configure_terminal_serve(){
  if ! terminal_ts_port_safe; then
    terminal_remove_default_listener
    return 0
  fi
  # Funnel permanece desligado mesmo se algum estado antigo tiver sido
  # persistido no volume do Tailscale.
  ts funnel --https="$TERMINAL_TS_PORT" off 2>/dev/null || true

  if ! terminal_enabled; then
    # Rollback explicito: remover um listener persistido e idempotente e nao
    # afeta o dashboard em 443.
    ts serve --https="$TERMINAL_TS_PORT" off 2>/dev/null || true
    log "Terminal Mode desativado; serve $TERMINAL_TS_PORT explicitamente removido"
    return 0
  fi

  local ready=0 i
  for i in $(seq 1 "$TERMINAL_READY_ATTEMPTS"); do
    if curl -sf -m 2 -o /dev/null "http://127.0.0.1:$TERMINAL_PORT/healthz"; then
      ready=1
      break
    fi
    sleep "$TERMINAL_READY_DELAY"
  done
  if [ "$ready" = "1" ]; then
    if ts serve --bg --https="$TERMINAL_TS_PORT" "http://127.0.0.1:$TERMINAL_PORT"; then
      log "Terminal Mode tailnet-only ativo em HTTPS $TERMINAL_TS_PORT -> loopback $TERMINAL_PORT"
    else
      ts serve --https="$TERMINAL_TS_PORT" off 2>/dev/null || true
      log "WARN: Tailscale recusou listener Terminal Mode; serve $TERMINAL_TS_PORT removido"
    fi
  else
    # Nunca conservar uma rota stale apontando para um sidecar que nao ficou
    # pronto neste boot.
    ts serve --https="$TERMINAL_TS_PORT" off 2>/dev/null || true
    log "WARN: Terminal Mode nao ficou pronto; serve $TERMINAL_TS_PORT removido"
  fi
}

configure_serve_routes(){
  # Superficie historica: dashboard segue em 443 via hostproxy.
  ts serve --bg --https=443 "http://127.0.0.1:$PROXY_PORT"
  configure_terminal_serve
}

# ---------------------------------------------------------------------------
# Instalacao do Tailscale: pin + checksum do repo + troca atomica de ponteiro.
#
# O gate e por VERSAO, nao por presenca. O gate antigo (`command -v X || [ -x X ]`)
# dava true para binario truncado por download interrompido -- que ficava instalado
# no volume persistente PARA SEMPRE, sem caminho de upgrade nem de recuperacao.
#
# Layout:
#   $TS_BIN_ROOT/<versao>/{tailscaled,tailscale}   dir versionado, self-testado
#   $TS_BIN_ROOT/current -> <versao>               UNICO ponteiro, trocado por rename(2)
#
# Uma troca => nunca existe instante com tailscale e tailscaled em versoes diferentes.
# QUALQUER falha em QUALQUER etapa mantem o binario anterior e o boot segue.
# ---------------------------------------------------------------------------

# Versao lida do PROPRIO binario. Nunca de stamp file: stamp mente se o binario
# corromper depois. Falha de exec (truncado/arch errada) devolve vazio -> tratado
# como "precisa reinstalar", nunca aborta o boot.
ts_ver(){
  local b; b="$(command -v "$1" 2>/dev/null)"
  [ -n "$b" ] && [ -x "$b" ] || return 0
  timeout 5 "$b" --version 2>/dev/null | head -1 | tr -d '\r' \
    | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+'
}

# sha256 vem SO da tabela do repo. O sidecar remoto nao e consultado: baixar
# tarball e hash do mesmo servidor e TOFU, nao pin de supply chain.
ts_sum(){
  [ -r "$TS_CHECKSUMS_FILE" ] || return 0
  awk -v v="$1" -v a="$2" '
    /^[[:space:]]*#/ { next }
    $1 == v && $2 == a { print $3; exit }
  ' "$TS_CHECKSUMS_FILE" 2>/dev/null
}

# Mantem a versao ativa + a anterior mais recente (64MB cada); poda o resto.
# Guardar a anterior localmente e o que faz o rollback por TS_VERSION funcionar
# SEM rede. Glob + teste `-nt` em vez de parsear `ls` (SC2045).
ts_gc(){
  local keep="$1" d b newest=""
  # ATENCAO: o glob */ (com barra) SEGUE symlinks-para-diretorio, entao `current`
  # entra na lista. Sem o filtro -L abaixo o ponteiro seria eleito "mais recente"
  # (aponta pra versao que acabou de ser instalada), a versao anterior REAL seria
  # podada no lugar dele, e um rm -rf em "current/" apagaria o conteudo da versao
  # ATIVA atraves do symlink. Pego pelo tests/test_boot_install.sh (T10/T11).
  for d in "$TS_BIN_ROOT"/*/; do
    [ -d "$d" ] || continue                      # glob sem match vem literal
    [ -L "${d%/}" ] && continue                  # ponteiro `current`, nao e versao
    b="$(basename "$d")"
    case "$b" in .*) continue;; esac
    [ "$b" = "$keep" ] && continue
    if [ -z "$newest" ] || [ "$d" -nt "$newest" ]; then newest="$d"; fi
  done
  for d in "$TS_BIN_ROOT"/*/; do
    [ -d "$d" ] || continue
    [ -L "${d%/}" ] && continue
    b="$(basename "$d")"
    case "$b" in .*) continue;; esac
    [ "$b" = "$keep" ] && continue
    [ "$d" = "$newest" ] && continue
    rm -rf "$d" 2>/dev/null || true
  done
}

# Troca ATOMICA do ponteiro: symlink novo ao lado, renomeado por cima do atual.
# -T (GNU) / -h (BSD) impedem que o mv entre no diretorio apontado pelo symlink
# existente. A flag nao suportada falha ANTES de tocar em qualquer coisa, entao
# o `||` escolhe a implementacao certa sem risco de acao parcial.
ts_point_to(){
  local ver="$1"
  ln -sfn "$ver" "$TS_BIN_ROOT/.current.new" 2>/dev/null || return 1
  if mv -Tf "$TS_BIN_ROOT/.current.new" "$TS_BIN_ROOT/current" 2>/dev/null \
     || mv -hf "$TS_BIN_ROOT/.current.new" "$TS_BIN_ROOT/current" 2>/dev/null; then
    return 0
  fi
  rm -f "$TS_BIN_ROOT/.current.new" 2>/dev/null || true
  return 1
}

# Promove uma versao JA CACHEADA em $TS_BIN_ROOT/<ver> SEM REDE.
# E isto que faz o rollback por TS_VERSION funcionar offline: se o diretorio
# existe e os dois binarios passam no self-test, so troca o ponteiro. Sem este
# caminho, um rollback exigiria baixar de novo -- justamente o que pode nao estar
# disponivel na hora em que se precisa dele.
ts_promote_cached(){
  # Dois `local` separados de proposito: num `local a=X b=$a`, o $a ainda nao
  # esta atribuido e sob `set -u` isso e unbound variable FATAL (SC2318).
  local ver="$1"
  local dir="$TS_BIN_ROOT/$ver" vd vc
  [ -d "$dir" ] || return 1
  vd="$(timeout 5 "$dir/tailscaled" --version 2>/dev/null | head -1 | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')"
  vc="$(timeout 5 "$dir/tailscale"  --version 2>/dev/null | head -1 | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')"
  if [ "$vd" != "$ver" ] || [ "$vc" != "$ver" ]; then
    log "ts: cache de $ver reprovou no self-test (d=${vd:-none} c=${vc:-none})"; return 1
  fi
  ts_point_to "$ver" || { log "ts: troca do ponteiro falhou ($ver, cache)"; return 1; }
  log "ts: $ver promovido do cache local (sem rede)"
  ts_gc "$ver"
  return 0
}

ts_install(){
  local ver="$1" arch="$2" want stage tgz got vd vc dest
  want="$(ts_sum "$ver" "$arch")"
  if [ "${#want}" -ne 64 ] || [ -n "$(printf '%s' "$want" | tr -d '0-9a-f')" ]; then
    log "ts: sem checksum no repo para $ver/$arch -> NAO instala"; return 1
  fi
  mkdir -p "$TS_BIN_ROOT" 2>/dev/null || { log "ts: mkdir $TS_BIN_ROOT falhou"; return 1; }
  rm -rf "$TS_BIN_ROOT"/.stage.* 2>/dev/null || true   # sobra de boot que crashou
  # stage no MESMO filesystem do destino: mv entre filesystems degrada para
  # copy+unlink e deixa de ser atomico.
  stage="$(mktemp -d "$TS_BIN_ROOT/.stage.XXXXXX" 2>/dev/null)" \
    || { log "ts: mktemp em $TS_BIN_ROOT falhou"; return 1; }
  tgz="$stage/ts.tgz"
  curl -fsSL -m 180 -o "$tgz" "$TS_PKGS_BASE/tailscale_${ver}_${arch}.tgz" 2>/dev/null \
    || { log "ts: download falhou ($ver/$arch)"; rm -rf "$stage"; return 1; }
  got="$(sha256sum "$tgz" 2>/dev/null | awk '{print $1}')"
  if [ "$got" != "$want" ]; then
    log "ts: CHECKSUM MISMATCH $ver/$arch (repo=$want baixado=${got:-vazio})"
    rm -rf "$stage"; return 1
  fi
  # extrai por nome de membro explicito (o glob antigo /tmp/tailscale_*_$A casava
  # sobras de extracoes anteriores)
  tar -xzf "$tgz" -C "$stage" --strip-components=1 \
      "tailscale_${ver}_${arch}/tailscaled" "tailscale_${ver}_${arch}/tailscale" 2>/dev/null \
    || { log "ts: tar falhou ($ver/$arch)"; rm -rf "$stage"; return 1; }
  rm -f "$tgz" 2>/dev/null || true
  chmod 0755 "$stage/tailscaled" "$stage/tailscale" 2>/dev/null || true
  # self-test ANTES de promover: pega extracao truncada, disco cheio e arch errada
  vd="$(timeout 5 "$stage/tailscaled" --version 2>/dev/null | head -1 | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')"
  vc="$(timeout 5 "$stage/tailscale"  --version 2>/dev/null | head -1 | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')"
  if [ "$vd" != "$ver" ] || [ "$vc" != "$ver" ]; then
    log "ts: self-test reprovou ($ver): d=${vd:-none} c=${vc:-none}"; rm -rf "$stage"; return 1
  fi
  dest="$TS_BIN_ROOT/$ver"
  incoming="$TS_BIN_ROOT/.incoming.$ver.$$"
  quarantine="$TS_BIN_ROOT/.quarantine.$ver.$$"
  mv -f "$stage" "$incoming" 2>/dev/null \
    || { log "ts: stage->incoming falhou ($ver)"; rm -rf "$stage"; return 1; }
  # NUNCA apagar o destino antes de a nova versao estar pronta. A versao anterior
  # deste bloco fazia `rm -rf "$dest"` e so depois o `mv`: com o binario ativo
  # corrompido, o gate reinstala a MESMA versao para onde `current` aponta, o rm
  # apagava esse dir e um mv falho deixava o ponteiro PENDURADO -- com o log
  # dizendo "segue com o binario anterior" sem existir binario nenhum.
  if [ -e "$dest" ]; then
    mv -f "$dest" "$quarantine" 2>/dev/null \
      || { log "ts: nao consegui isolar o destino anterior ($ver)"; rm -rf "$incoming"; return 1; }
  fi
  if ! mv -f "$incoming" "$dest" 2>/dev/null; then
    log "ts: promocao falhou ($ver) -> restaurando o destino anterior"
    [ -e "$quarantine" ] && mv -f "$quarantine" "$dest" 2>/dev/null
    rm -rf "$incoming" 2>/dev/null || true
    return 1
  fi
  rm -rf "$quarantine" 2>/dev/null || true
  ts_point_to "$ver" || { log "ts: troca do ponteiro falhou ($ver) -> mantem o anterior"; return 1; }
  log "ts: $ver ativo ($arch)"
  ts_gc "$ver"
  return 0
}

# Ultima linha de defesa: se `current` ficou pendurado (aponta para dir
# inexistente), o PATH nao resolve e qualquer log de fail-safe seria mentira.
# Tenta apontar para alguma versao cacheada que passe no self-test; nao havendo
# nenhuma, REMOVE o ponteiro para o PATH cair em /data/bin, e diz isso alto.
ts_repair_pointer(){
  [ -L "$TS_BIN_ROOT/current" ] || return 0
  [ -d "$TS_BIN_ROOT/current" ] && return 0     # resolve -> nada a reparar
  local d b
  for d in "$TS_BIN_ROOT"/*/; do
    [ -d "$d" ] || continue
    [ -L "${d%/}" ] && continue
    b="$(basename "$d")"
    case "$b" in .*) continue;; esac
    if ts_promote_cached "$b"; then
      log "ts: ponteiro pendurado reparado -> $b"
      return 0
    fi
  done
  rm -f "$TS_BIN_ROOT/current" 2>/dev/null || true
  log "ts: ATENCAO ponteiro pendurado e nenhuma versao cacheada valida -> ponteiro removido, PATH cai em /data/bin"
  return 1
}

ts_ensure(){
  local A have_d have_c
  case "$(uname -m)" in
    x86_64)        A=amd64;;
    aarch64|arm64) A=arm64;;
    # arch desconhecida NUNCA cai em amd64: instalar binario de outra arquitetura
    # deixaria o no sem tailscale sem nenhum sinal ate o daemon falhar no exec.
    *)             A="";;
  esac
  have_d="$(ts_ver tailscaled)"; have_c="$(ts_ver tailscale)"
  if [ "${TS_SKIP_UPGRADE:-0}" = "1" ]; then
    log "ts: TS_SKIP_UPGRADE=1 -> mantem d=${have_d:-none} c=${have_c:-none}"
  elif [ -z "$A" ]; then
    log "ts: arch $(uname -m) nao suportada -> mantem d=${have_d:-none} c=${have_c:-none}"
  elif [ "$have_d" = "$TS_VERSION" ] && [ "$have_c" = "$TS_VERSION" ]; then
    log "ts: $TS_VERSION ja ativo ($A)"
  else
    log "ts: instalado d=${have_d:-none} c=${have_c:-none} -> desejado $TS_VERSION ($A)"
    # Cache local ANTES da rede: rollback por TS_VERSION tem que funcionar offline.
    ts_promote_cached "$TS_VERSION" \
      || ts_install "$TS_VERSION" "$A" \
      || log "ts: troca de versao falhou -> SEGUE com o binario anterior (fail-safe)"
  fi
  # so afirmamos fail-safe depois de conferir que ainda ha binario resolvivel
  ts_repair_pointer || true
}

mkdir -p "$TS_STATE_DIR" /var/run/tailscale /data/bin 2>/dev/null || true

tailscale_up_serve(){
  # 0) binarios: gate por VERSAO + checksum controlado no repo + troca atomica de
  #    ponteiro (ver ts_ensure/ts_install acima). A imagem nao traz tailscale; o
  #    volume /data cacheia entre deploys.
  #    NAO faz hot-swap de daemon vivo: se o tailscaled ja estiver rodando, ele
  #    segue no inode antigo e a versao nova so e adotada no proximo restart.
  #    Matar o daemon para adotar build novo derrubaria o no -- e se o build novo
  #    estivesse ruim, deixaria a Iris inalcancavel.
  ts_ensure
  TSD="$(command -v tailscaled 2>/dev/null || echo /data/bin/tailscaled)"
  # 1) tailscaled userspace, state no volume (preserva identidade/cert entre deploys)
  if ! running; then
    nohup env -u PORT "$TSD" --tun=userspace-networking --statedir="$TS_STATE_DIR" --socket="$TS_SOCK" >/var/log/tailscaled.log 2>&1 &
    sleep 4
  fi
  # 2) auth: state primeiro; TS_AUTHKEY so como fallback no 1o boot
  if ! running && [ -n "${TS_AUTHKEY:-}" ]; then
    env -u PORT tailscale --socket="$TS_SOCK" up --authkey="$TS_AUTHKEY" --hostname="$TS_HOSTNAME" --accept-dns=false || log "up falhou"
  fi
  running || { log "WARN: tailscale offline (state vazio + TS_AUTHKEY ausente) -> serve indisponivel"; return; }
  # 3) hostname estavel (= MagicDNS name); 4) cert warm-up (idempotente, instantaneo se cacheado)
  ts set --hostname="$TS_HOSTNAME"; sleep 2
  timeout 90 env -u PORT tailscale --socket="$TS_SOCK" cert "$TS_FQDN" >/dev/null 2>&1 || true
  # 5) GARANTIR tailnet-only: desliga qualquer Funnel herdado.
  ts funnel --https=443 off 2>/dev/null || true
  # Rollback cedo: nao espera os probes do dashboard para remover uma rota
  # Terminal Mode persistida quando a flag esta desligada.
  if ! terminal_enabled; then
    if terminal_ts_port_safe; then
      ts funnel --https="$TERMINAL_TS_PORT" off 2>/dev/null || true
      ts serve --https="$TERMINAL_TS_PORT" off 2>/dev/null || true
    else
      terminal_remove_default_listener
    fi
  fi
  # 5a) espera o dashboard local (server.py o sobe) responder em 9119.
  for i in $(seq 1 30); do curl -sf -m 2 -o /dev/null "http://127.0.0.1:$DASH_PORT/" && break; sleep 2; done
  # 5b) hostproxy: o dashboard valida o header Host (so loopback) e recusa (400) o
  #     Host que o `tailscale serve` repassa. Este proxy reescreve o Host para
  #     127.0.0.1:$DASH_PORT e encaminha HTTP + WebSocket (/api/ws). Escuta SO em
  #     loopback -> nunca exposto fora do tailnet/loopback.
  if ! curl -s -m 2 -o /dev/null "http://127.0.0.1:$PROXY_PORT/"; then
    HERMES_DASHBOARD_PORT="$DASH_PORT" HOSTPROXY_PORT="$PROXY_PORT" \
      nohup python3 /app/hostproxy.py >/var/log/hostproxy.log 2>&1 &
    for i in $(seq 1 15); do curl -s -m 2 -o /dev/null "http://127.0.0.1:$PROXY_PORT/" && break; sleep 1; done
  fi
  # 5c) publica o HOSTPROXY na tailnet (nao o dashboard direto) — o Host-rewrite resolve o 400.
  configure_serve_routes
  ts serve status 2>/dev/null || true
  ts funnel status 2>/dev/null || true   # esperado: vazio
  log "tailscale serve ativo (tailnet-only) -> hostproxy 127.0.0.1:$PROXY_PORT -> dashboard 127.0.0.1:$DASH_PORT"
}

# Hook restrito a testes: exercita apenas a configuracao das rotas Serve com
# um binario `tailscale` forjado no PATH. Nao instala binario, nao sobe daemon
# e nao encadeia o servidor.
if [ "${HERMES_BOOT_TEST_SERVE_ONLY:-0}" = "1" ]; then
  ts funnel --https=443 off 2>/dev/null || true
  configure_serve_routes
  exit 0
fi

# Hook de teste: roda SO a instalacao do binario e sai. Usado pelo
# tests/test_boot_install.sh -- nao sobe daemon, nao toca no serve, nao encadeia o
# start.sh. Sem ele a logica de instalacao so seria exercitavel em producao.
if [ "${TS_INSTALL_ONLY:-0}" = "1" ]; then ts_ensure; exit 0; fi

if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN: nao sobe tailscale; encadearia /app/start.sh"
else
  ( tailscale_up_serve ) &   # background: nao bloqueia o healthcheck
fi

# Encadeia o entrypoint ORIGINAL (intacto): start.sh -> exec server.py
# BEGIN IRIS PERSISTENT PRE-SERVER BOOTSTRAP
# Reapply volume-backed runtime patches once per boot process tree.
if [ "${IRIS_PREBOOT_DONE:-0}" != "1" ] && [ -x /data/.hermes/scripts/iris_pre_server_bootstrap.sh ]; then
  if HERMES_HOME="${HERMES_HOME:-/data/.hermes}" /data/.hermes/scripts/iris_pre_server_bootstrap.sh >> /data/.hermes/logs/iris-pre-server-bootstrap.log 2>&1; then
    export IRIS_PREBOOT_DONE=1
    export IRIS_WATCHDOGS_STARTED=1
  else
    log "WARN: persistent pre-server bootstrap failed"
  fi
fi
# END IRIS PERSISTENT PRE-SERVER BOOTSTRAP

# BEGIN IRIS TINI INIT SUPERVISOR
# Keep a real init as PID 1 so orphaned MCP/watchdog descendants are reaped.
# The fallback preserves availability if a future image unexpectedly omits tini.
if [ -x /usr/bin/tini ]; then
  if [ -x /app/start.sh ]; then
    exec /usr/bin/tini -s -- /app/start.sh
  else
    exec /usr/bin/tini -s -- python /app/server.py
  fi
else
  log "WARN: /usr/bin/tini unavailable; starting without init supervisor"
  if [ -x /app/start.sh ]; then exec /app/start.sh; else exec python /app/server.py; fi
fi
# END IRIS TINI INIT SUPERVISOR
