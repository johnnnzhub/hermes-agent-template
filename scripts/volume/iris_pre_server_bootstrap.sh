#!/usr/bin/env bash
set -u
export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"
export MALLOC_TRIM_THRESHOLD_="${MALLOC_TRIM_THRESHOLD_:-131072}"
HERMES_HOME="${HERMES_HOME:-/data/.hermes}"
FOXY_HOME="${FOXY_HERMES_HOME:-/data/.hermes/profiles/foxy}"
LOG_DIR="$HERMES_HOME/logs"
BOOT_LOG="$LOG_DIR/iris-pre-server-bootstrap.log"
mkdir -p "$LOG_DIR" "$HERMES_HOME/scripts" "$FOXY_HOME/logs" 2>/dev/null || true
log(){ printf '%s %s
' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$BOOT_LOG" 2>/dev/null || true; }

# ── Relatorio de patchers ────────────────────────────────────────────────────
#
# Ate 2026-08-02 cada patcher rodava com `|| log WARN` e mais nada. Patcher morto
# virava uma linha de log num arquivo que ninguem le, e o container subia com
# /health 200 enquanto uma funcao morria calada. Dois ja estavam nesse estado ha
# semanas sem ninguem notar.
#
# A correcao NAO e abortar o boot. Hoje ha patcher vermelho conhecido em
# producao; fail-closed direto brickaria a Iris no proximo boot -- trocaria
# "degradado em silencio" por "fora do ar", que e pior.
#
# Entao: por padrao continua tolerante, MAS grava um relatorio legivel por
# maquina (patcher -> ok/falhou) que o check pos-deploy diffa contra o baseline.
# O modo estrito e opt-in por IRIS_BOOTSTRAP_STRICT=1, para ser ligado depois
# que o baseline estiver limpo. Ligar antes disso e o erro que este comentario
# existe para impedir.
RELATORIO="$HERMES_HOME/runtime/bootstrap-patchers.json"
mkdir -p "$(dirname "$RELATORIO")" 2>/dev/null || true
_resultados=""
_falhas=0

roda_patcher(){
  # $1 = rotulo curto, $2 = caminho, $3.. = argumentos
  local rotulo="$1" caminho="$2"; shift 2
  [ -f "$caminho" ] || { _resultados="${_resultados}${_resultados:+,}\"$rotulo\":\"ausente\""; return 0; }
  if python "$caminho" "$@" >> "$BOOT_LOG" 2>&1; then
    _resultados="${_resultados}${_resultados:+,}\"$rotulo\":\"ok\""
    return 0
  fi
  _resultados="${_resultados}${_resultados:+,}\"$rotulo\":\"falhou\""
  _falhas=$((_falhas + 1))
  log "WARN $rotulo failed"
  if [ "${IRIS_BOOTSTRAP_STRICT:-0}" = "1" ]; then
    log "FATAL modo estrito: abortando o boot por falha em $rotulo"
    printf '{"strict":true,"aborted_on":"%s",%s}\n' "$rotulo" "$_resultados" > "$RELATORIO" 2>/dev/null || true
    exit 1
  fi
  return 0
}

log "pre-server bootstrap start"
roda_patcher ensure_allocator_bootstrap "$HERMES_HOME/scripts/ensure_allocator_bootstrap.py"
roda_patcher ensure_tini_bootstrap "$HERMES_HOME/scripts/ensure_tini_bootstrap.py"
roda_patcher ensure_persistent_mcp_binaries "$HERMES_HOME/scripts/ensure_persistent_mcp_binaries.py"
# BEGIN IRIS ONE-SHOT POST-RESTART VERIFIER
if [ -x "$HERMES_HOME/scripts/post_restart_verifier.py" ] && [ -f "$HERMES_HOME/runtime/restart-verifier.armed" ]; then
  python "$HERMES_HOME/scripts/post_restart_verifier.py" >> "$HERMES_HOME/logs/post-restart-verifier.log" 2>&1 &
fi
# END IRIS ONE-SHOT POST-RESTART VERIFIER
roda_patcher ensure_codex_only "$HERMES_HOME/scripts/ensure_codex_only.py"
roda_patcher ensure_codex_oauth_gateway_autostart "$HERMES_HOME/scripts/ensure_codex_oauth_gateway_autostart.py"
# Patches operacionais idempotentes do runtime Hermes/Iris.
roda_patcher apply_iris_ops_runtime_patches "$HERMES_HOME/scripts/apply_iris_ops_runtime_patches.py"
roda_patcher apply_iris_model_routing_patch "$HERMES_HOME/scripts/apply_iris_model_routing_patch.py"
roda_patcher apply_iris_cron_whatsapp_context_patch "$HERMES_HOME/scripts/apply_iris_cron_whatsapp_context_patch.py"
roda_patcher apply_iris_whatsapp_owner_groups_patch "$HERMES_HOME/scripts/apply_iris_whatsapp_owner_groups_patch.py"
roda_patcher ensure_whatsapp_group_routes "$HERMES_HOME/scripts/ensure_whatsapp_group_routes.py"
roda_patcher apply_iris_journal_group_capture_patch "$HERMES_HOME/scripts/apply_iris_journal_group_capture_patch.py"
roda_patcher apply_iris_tasks_router_gateway_patch "$HERMES_HOME/scripts/apply_iris_tasks_router_gateway_patch.py"
if [ "${IRIS_WATCHDOGS_STARTED:-0}" != "1" ]; then
  if [ -x "$HERMES_HOME/scripts/whatsapp_gateway_watchdog_daemon.py" ]; then
    env -u CODEX_AUTH_B64 HERMES_HOME="$HERMES_HOME" \
      WHATSAPP_WATCHDOG_INTERVAL="${WHATSAPP_WATCHDOG_INTERVAL:-60}" \
      WHATSAPP_WATCHDOG_INITIAL_DELAY="${WHATSAPP_WATCHDOG_INITIAL_DELAY:-30}" \
      nohup "$HERMES_HOME/scripts/whatsapp_gateway_watchdog_daemon.py" \
      >> "$LOG_DIR/whatsapp-gateway-watchdog-daemon.stdout.log" 2>&1 &
    log "default watchdog launch requested"
  fi
  if [ -x "$FOXY_HOME/scripts/foxy_gateway_watchdog_daemon.py" ]; then
    env -u CODEX_AUTH_B64 FOXY_HERMES_HOME="$FOXY_HOME" \
      FOXY_GATEWAY_START_DELAY="${FOXY_GATEWAY_START_DELAY:-10}" \
      FOXY_GATEWAY_WATCHDOG_INTERVAL="${FOXY_GATEWAY_WATCHDOG_INTERVAL:-60}" \
      nohup "$FOXY_HOME/scripts/foxy_gateway_watchdog_daemon.py" \
      >> "$FOXY_HOME/logs/foxy-gateway-watchdog-daemon.stdout.log" 2>&1 &
    log "foxy watchdog launch requested"
  fi
else
  log "watchdog launch skipped: already owned by an earlier bootstrap layer"
fi

# Relatorio legivel por maquina. E contra este arquivo que o check pos-deploy
# compara -- nao contra contagem de WARN, que nao enxerga o patcher que retorna
# exit 0 e imprime "skip patch".
printf '{"strict":%s,"falhas":%s,%s}\n' \
  "$([ "${IRIS_BOOTSTRAP_STRICT:-0}" = "1" ] && echo true || echo false)" \
  "$_falhas" "$_resultados" > "$RELATORIO" 2>/dev/null || true
log "patchers: $_falhas falha(s); relatorio em $RELATORIO"

log "pre-server bootstrap done"
