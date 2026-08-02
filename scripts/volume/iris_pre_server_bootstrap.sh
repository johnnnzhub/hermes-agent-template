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
log "pre-server bootstrap start"
if [ -x "$HERMES_HOME/scripts/ensure_allocator_bootstrap.py" ]; then
  python "$HERMES_HOME/scripts/ensure_allocator_bootstrap.py" >> "$BOOT_LOG" 2>&1 || log "WARN allocator bootstrap failed"
fi
if [ -x "$HERMES_HOME/scripts/ensure_tini_bootstrap.py" ]; then
  python "$HERMES_HOME/scripts/ensure_tini_bootstrap.py" >> "$BOOT_LOG" 2>&1 || log "WARN tini bootstrap failed"
fi
if [ -x "$HERMES_HOME/scripts/ensure_persistent_mcp_binaries.py" ]; then
  python "$HERMES_HOME/scripts/ensure_persistent_mcp_binaries.py" >> "$BOOT_LOG" 2>&1 || log "WARN persistent MCP bootstrap failed"
fi
# BEGIN IRIS ONE-SHOT POST-RESTART VERIFIER
if [ -x "$HERMES_HOME/scripts/post_restart_verifier.py" ] && [ -f "$HERMES_HOME/runtime/restart-verifier.armed" ]; then
  python "$HERMES_HOME/scripts/post_restart_verifier.py" >> "$HERMES_HOME/logs/post-restart-verifier.log" 2>&1 &
fi
# END IRIS ONE-SHOT POST-RESTART VERIFIER
if [ -x "$HERMES_HOME/scripts/ensure_codex_only.py" ]; then
  python "$HERMES_HOME/scripts/ensure_codex_only.py" >> "$BOOT_LOG" 2>&1 || log "WARN codex-only lock failed"
fi
if [ -x "$HERMES_HOME/scripts/ensure_codex_oauth_gateway_autostart.py" ]; then
  python "$HERMES_HOME/scripts/ensure_codex_oauth_gateway_autostart.py" >> "$BOOT_LOG" 2>&1 || log "WARN Codex OAuth gateway autostart patch failed"
fi
# Patches operacionais idempotentes do runtime Hermes/Iris.
if [ -f "$HERMES_HOME/scripts/apply_iris_ops_runtime_patches.py" ]; then
  python "$HERMES_HOME/scripts/apply_iris_ops_runtime_patches.py" >> "$BOOT_LOG" 2>&1 || log "WARN runtime patch failed"
fi
if [ -f "$HERMES_HOME/scripts/apply_iris_model_routing_patch.py" ]; then
  python "$HERMES_HOME/scripts/apply_iris_model_routing_patch.py" >> "$BOOT_LOG" 2>&1 || log "WARN model routing patch failed"
fi
if [ -f "$HERMES_HOME/scripts/apply_iris_cron_whatsapp_context_patch.py" ]; then
  python "$HERMES_HOME/scripts/apply_iris_cron_whatsapp_context_patch.py" >> "$BOOT_LOG" 2>&1 || log "WARN cron WhatsApp context patch failed"
fi
if [ -x "$HERMES_HOME/scripts/apply_iris_whatsapp_owner_groups_patch.py" ]; then
  python "$HERMES_HOME/scripts/apply_iris_whatsapp_owner_groups_patch.py" >> "$BOOT_LOG" 2>&1 || log "WARN WhatsApp owner-group runtime patch failed"
fi
if [ -x "$HERMES_HOME/scripts/ensure_whatsapp_group_routes.py" ]; then
  python "$HERMES_HOME/scripts/ensure_whatsapp_group_routes.py" >> "$BOOT_LOG" 2>&1 || log "WARN group route self-heal failed"
fi
if [ -x "$HERMES_HOME/scripts/apply_iris_journal_group_capture_patch.py" ]; then
  python "$HERMES_HOME/scripts/apply_iris_journal_group_capture_patch.py" >> "$BOOT_LOG" 2>&1 || log "WARN journal group capture patch failed"
fi
if [ -x "$HERMES_HOME/scripts/apply_iris_tasks_router_gateway_patch.py" ]; then
  python "$HERMES_HOME/scripts/apply_iris_tasks_router_gateway_patch.py" >> "$BOOT_LOG" 2>&1 || log "WARN tasks router gateway patch failed"
fi
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
log "pre-server bootstrap done"
