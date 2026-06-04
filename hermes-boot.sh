#!/usr/bin/env bash
# hermes-boot.sh v2 — torna o caminho público do Hermes durável a redeploy do Railway.
#
# Acionado pelo Custom Start Command do Railway (Settings → Deploy → Custom Start Command):
#     /data/bin/hermes-boot.sh
# NÃO usar no "Pre-Deploy Command" (roda num container efêmero separado → falha).
# Ele encadeia o /app/start.sh ORIGINAL no final (setup essencial + exec server.py).
#
# Por que existe: a imagem do template NÃO inclui Tailscale, e tailscaled/funnel/g2_proxy/
# dashboard-0.0.0.0 eram setup manual efêmero — qualquer redeploy zerava o acesso público.
# Este script reconstrói tudo no boot a partir do volume persistente /data.
#
# Vars (Railway service): TS_AUTHKEY (reusável), TS_HOSTNAME (default 58efd16a465e), DRY_RUN=1.
# Pegadinha: tailscaled precisa de `env -u PORT` (a var PORT=8080 do Railway quebra o TLS do Funnel).
set -u
DRY_RUN="${DRY_RUN:-0}"
SKIP_EXEC="${SKIP_EXEC:-0}"
TS_STATE_DIR="${TS_STATE_DIR:-/data/.tailscale}"   # --statedir (NÃO --state): precisa de DIR p/ guardar o cert do Funnel
TS_SOCK="/var/run/tailscale/tailscaled.sock"
TS_TAILNET="${TS_TAILNET:-tail390702.ts.net}"
# Hostname FIXO do node = DNS name do Funnel (URL do G2). PRECISA ser re-fixado a cada boot
# (seção 1a) senão o node herda o hostname ALEATÓRIO do container (hex) e a URL muda a cada deploy.
TS_HOSTNAME="${TS_HOSTNAME:-hermes-g2}"
TS_FQDN="${TS_HOSTNAME}.${TS_TAILNET}"
DASH_PORT="${FUNNEL_DASH_PORT:-9121}"
G2_PORT="${G2_PROXY_PORT:-8655}"
export PATH="/data/bin:$PATH"

log(){ echo "[hermes-boot] $*"; }
run(){ if [ "$DRY_RUN" = "1" ]; then log "DRY: $*"; else log "RUN: $*"; eval "$*" || log "  (falhou, seguindo)"; fi; }
listening(){ ss -ltn 2>/dev/null | grep -qE "[:.]$1 "; }
running(){ ts status >/dev/null 2>&1; }
ts(){ env -u PORT tailscale --socket="$TS_SOCK" "$@"; }

mkdir -p "$TS_STATE_DIR" /var/run/tailscale /data/bin 2>/dev/null || true

# 0) Tailscale: usa o cache no volume /data/bin se houver; senão baixa o tarball
#    estático e cacheia lá (a imagem não traz tailscale; cache evita reinstalar).
if command -v tailscaled >/dev/null 2>&1; then
  log "tailscale presente: $(command -v tailscaled)"
elif [ "$DRY_RUN" = "1" ]; then
  log "DRY: baixaria o tarball estático do tailscale (ausente nesta imagem)"
else
  case "$(uname -m)" in
    x86_64) TSARCH=amd64;; aarch64|arm64) TSARCH=arm64;;
    armv7l) TSARCH=arm;; *) TSARCH=amd64;;
  esac
  log "tailscale ausente — baixando tarball estático ($TSARCH; cacheia em /data/bin)..."
  TSPKG="$(curl -fsSL https://pkgs.tailscale.com/stable/ 2>/dev/null | grep -oE "tailscale_[0-9.]+_${TSARCH}\.tgz" | head -1)"
  if [ -n "$TSPKG" ]; then
    curl -fsSL -o /tmp/ts.tgz "https://pkgs.tailscale.com/stable/$TSPKG" \
      && tar -xzf /tmp/ts.tgz -C /tmp \
      && cp -a /tmp/tailscale_*_${TSARCH}/tailscaled /tmp/tailscale_*_${TSARCH}/tailscale /data/bin/ \
      && log "  tailscale instalado em /data/bin ($TSPKG)" || log "  download/extract falhou"
  else
    log "  não resolveu a versão do pacote — abortando install"
  fi
fi
TAILSCALED_BIN="$(command -v tailscaled 2>/dev/null || echo /data/bin/tailscaled)"

# 1) tailscaled + auth (state no volume reusa a identidade → preserva a URL; authkey é fallback)
if running; then
  log "tailscaled rodando e autenticado — skip"
else
  # nohup: sobrevive a fechar a sessão ssh (restauro manual) e ao reparent. --statedir (não --state):
  # sem o DIR, o tailscaled não tem "var root" p/ o cert do Funnel → TLS falha "tlsv1 alert internal error".
  run "nohup env -u PORT '$TAILSCALED_BIN' --tun=userspace-networking --statedir='$TS_STATE_DIR' --socket='$TS_SOCK' >/var/log/tailscaled.log 2>&1 &"
  [ "$DRY_RUN" = "1" ] || sleep 4
  if running; then
    log "tailscale autenticado pelo state do volume"
  elif [ -n "${TS_AUTHKEY:-}" ]; then
    log "tailscale up --authkey=<oculto> --hostname=$TS_HOSTNAME"
    [ "$DRY_RUN" = "1" ] || env -u PORT tailscale --socket="$TS_SOCK" up --authkey="$TS_AUTHKEY" --hostname="$TS_HOSTNAME" --accept-dns=false || log "  up falhou (seguindo)"
  else
    log "WARN: tailscale offline e TS_AUTHKEY ausente — Funnel ficará indisponível"
  fi
fi

# 1a) Fixa o hostname (= DNS name do Funnel) a um valor ESTÁVEL toda vez. CRÍTICO: o node key
#     persiste no /data, mas o DNS name segue o HostName do container (hex aleatório por deploy);
#     sem re-fixar, a URL do G2 muda a cada redeploy. `tailscale set` é não-disruptivo.
if running; then run "ts set --hostname='$TS_HOSTNAME'"; [ "$DRY_RUN" = "1" ] || sleep 2; fi

# 1b) Aquece o cert TLS do Funnel (idempotente). Depende do --statedir acima; sem warm-up o 1º
#     handshake externo pode falhar. Best-effort + timeout (1ª emissão ACME pode demorar num
#     volume novo; com state persistente o cert já está cacheado e isso é instantâneo).
if running; then run "timeout 90 env -u PORT tailscale --socket='$TS_SOCK' cert '$TS_FQDN' >/dev/null 2>&1"; fi

# 2) g2_proxy (8655) — endpoint /v1 do G2
if listening "$G2_PORT"; then log "g2_proxy já escutando em $G2_PORT"; else
  run "cd /data && nohup python3 /data/g2_proxy.py >/var/log/g2_proxy.log 2>&1 &"
  [ "$DRY_RUN" = "1" ] || sleep 1
fi

# 3) dashboard servível pelo Funnel (0.0.0.0 + --insecure aceita o Host público do Funnel)
if listening "$DASH_PORT"; then log "dashboard do Funnel já em $DASH_PORT"; else
  run "nohup hermes dashboard --host 0.0.0.0 --port $DASH_PORT --no-open --skip-build --tui --insecure >/var/log/hermes-dash-$DASH_PORT.log 2>&1 &"
  [ "$DRY_RUN" = "1" ] || sleep 2
fi

# 4) Funnel routes (idempotente): raiz + /api → dashboard; /v1 → g2_proxy
run "ts funnel --bg http://127.0.0.1:$DASH_PORT"
run "ts funnel --bg --set-path=/api http://127.0.0.1:$DASH_PORT/api"
run "ts funnel --bg --set-path=/v1 http://127.0.0.1:$G2_PORT/v1"
ts funnel status 2>/dev/null || true

# 5) Encadeia o entrypoint ORIGINAL do container: mkdir/seed/rm gateway.pid + exec server.py.
#    Pular o start.sh foi a causa do deploy FAILED 2026-06-03 (gateway.pid stale → "PID file race lost").
#    SKIP_EXEC=1: aplica só a blindagem e NÃO reencadeia. Dois usos:
#      (1) restauro manual via `railway ssh` com o server.py já rodando como PID 1;
#      (2) chamado de dentro do start.sh do fork — que faz o exec server.py ele mesmo.
if [ "$SKIP_EXEC" = "1" ]; then
  log "SKIP_EXEC=1 — blindagem aplicada, NÃO reencadeia start.sh"
elif [ "$DRY_RUN" != "1" ]; then
  log "blindagem aplicada; encadeando /app/start.sh"
  if [ -x /app/start.sh ]; then exec /app/start.sh; else exec python /app/server.py; fi
fi
