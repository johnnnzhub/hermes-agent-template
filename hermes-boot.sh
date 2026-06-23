#!/usr/bin/env bash
# hermes-boot.sh v3 — reintroduz Tailscale (tailnet-only) no container Railway.
# Dashboard segue LOCAL em 127.0.0.1:9119 (server.py o sobe); quem publica na
# tailnet e o `tailscale serve` (https=443). SEM Funnel (nada publico). SEM
# g2_proxy. SEM dashboard 0.0.0.0/--insecure. Encadeia o /app/start.sh ORIGINAL
# (start.sh -> exec server.py: gateway/MCP/healthcheck 100% intactos).
#
# Startup chain: railway.toml startCommand=/app/hermes-boot.sh
#   -> sobe tailscaled+serve em BACKGROUND -> exec /app/start.sh
# Vars (Railway service, NUNCA no repo): TS_AUTHKEY (reusavel), TS_HOSTNAME (default hermes-g2).
# Pegadinha: env PORT=8080 do Railway quebra o TLS do Tailscale -> env -u PORT sempre.
set -u
DRY_RUN="${DRY_RUN:-0}"
TS_STATE_DIR="${TS_STATE_DIR:-/data/.tailscale}"
TS_SOCK="/var/run/tailscale/tailscaled.sock"
TS_TAILNET="${TS_TAILNET:-tail390702.ts.net}"
TS_HOSTNAME="${TS_HOSTNAME:-hermes-g2}"
TS_FQDN="${TS_HOSTNAME}.${TS_TAILNET}"
DASH_PORT="${DASH_PORT:-9119}"   # dashboard LOCAL existente (server.py spawna)
PROXY_PORT="${HOSTPROXY_PORT:-9200}"   # hostproxy loopback (Host-rewrite) -> dashboard
export PATH="/data/bin:$PATH"

log(){ echo "[hermes-boot-v3] $*"; }
ts(){ env -u PORT tailscale --socket="$TS_SOCK" "$@"; }
running(){ ts status >/dev/null 2>&1; }

mkdir -p "$TS_STATE_DIR" /var/run/tailscale /data/bin 2>/dev/null || true

tailscale_up_serve(){
  # 0) binarios (cacheia no volume; a imagem nao traz tailscale). O script usa AMBOS
  #    tailscaled (daemon) e tailscale (cliente) -> baixa/reinstala se QUALQUER um faltar.
  have(){ command -v "$1" >/dev/null 2>&1 || [ -x "/data/bin/$1" ]; }
  if ! have tailscaled || ! have tailscale; then
    case "$(uname -m)" in x86_64) A=amd64;; aarch64|arm64) A=arm64;; *) A=amd64;; esac
    P="$(curl -fsSL https://pkgs.tailscale.com/stable/ 2>/dev/null | grep -oE "tailscale_[0-9.]+_${A}\.tgz" | head -1)"
    [ -n "$P" ] && curl -fsSL -o /tmp/ts.tgz "https://pkgs.tailscale.com/stable/$P" \
      && tar -xzf /tmp/ts.tgz -C /tmp \
      && cp -a /tmp/tailscale_*_${A}/tailscaled /tmp/tailscale_*_${A}/tailscale /data/bin/ \
      && log "tailscale baixado ($P)" || log "download tailscale falhou"
  fi
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
  ts serve --bg --https=443 "http://127.0.0.1:$PROXY_PORT"
  ts serve status 2>/dev/null || true
  ts funnel status 2>/dev/null || true   # esperado: vazio
  log "tailscale serve ativo (tailnet-only) -> hostproxy 127.0.0.1:$PROXY_PORT -> dashboard 127.0.0.1:$DASH_PORT"
}

if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN: nao sobe tailscale; encadearia /app/start.sh"
else
  ( tailscale_up_serve ) &   # background: nao bloqueia o healthcheck
fi

# Encadeia o entrypoint ORIGINAL (intacto): start.sh -> exec server.py
if [ -x /app/start.sh ]; then exec /app/start.sh; else exec python /app/server.py; fi
