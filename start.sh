#!/bin/bash
set -e

# Mirror dashboard-ref-only's startup: create every directory hermes expects
# and seed a default config.yaml if the volume is empty. Without these,
# `hermes dashboard` endpoints that hit logs/, sessions/, cron/, etc. can fail
# with opaque errors even though no auth is actually involved.
mkdir -p /data/.hermes/cron /data/.hermes/sessions /data/.hermes/logs \
         /data/.hermes/memories /data/.hermes/skills /data/.hermes/pairing \
         /data/.hermes/hooks /data/.hermes/image_cache /data/.hermes/audio_cache \
         /data/.hermes/workspace /data/.hermes/skins /data/.hermes/plans \
         /data/.hermes/home

# Stamp the install method as "docker" so hermes treats this as an immutable
# container image, not a pip checkout. hermes's detect_install_method() reads
# $HERMES_HOME/.install_method FIRST (before any .git / pip fallback). Without
# this stamp the template falls through to "pip" — because the Dockerfile strips
# /opt/hermes-agent/.git — and the dashboard's "Update Hermes" button then runs
# a real `hermes update` (PyPI pip-upgrade) INSIDE the running container. That
# upgrade is ephemeral (reverts on the next redeploy) and can desync the Python
# package from the image's pre-built web_dist/ui-tui bundles. Stamping "docker"
# makes that button correctly refuse with "pull a fresh image / redeploy", which
# matches the real upgrade path here (bump HERMES_REF in Railway + redeploy).
# Written unconditionally each boot so it stays correct and self-heals.
printf 'docker\n' > /data/.hermes/.install_method

# Codex OAuth (assistente dev): seeda ~/.codex/auth.json a partir da env var
# CODEX_AUTH_B64 (Railway) na PRIMEIRA vez. HOME=/data (ver Dockerfile), então
# isto é /data/.codex/auth.json — NO VOLUME PERSISTENTE. Só escreve se ainda não
# existe: depois disso o hermes gerencia o arquivo (refresh do token rotaciona
# tanto este quanto /data/.hermes/auth.json, ambos persistentes), e sobrescrever
# a cada boot poderia restaurar um refresh token stale. O hermes importa essas
# credenciais pro auth store no load_pool — agent/credential_sources.py _seed_from_singletons.
if [ -n "${CODEX_AUTH_B64:-}" ] && [ ! -f "$HOME/.codex/auth.json" ]; then
  mkdir -p "$HOME/.codex"
  printf '%s' "$CODEX_AUTH_B64" | base64 -d > "$HOME/.codex/auth.json"
  chmod 600 "$HOME/.codex/auth.json"
fi

# Config gerenciado: aplica o deploy-config.yaml versionado (provider openai-codex,
# model gpt-5.5, fallback + auxiliary em OpenRouter) a CADA boot. Self-heal da trap
# do write_config_yaml em server.py — salvar na UI /setup re-força provider "auto",
# mas o próximo boot restaura o provider correto a partir deste arquivo.
if [ -f /app/deploy-config.yaml ]; then
  cp /app/deploy-config.yaml /data/.hermes/config.yaml
elif [ ! -f /data/.hermes/config.yaml ] && [ -f /opt/hermes-agent/cli-config.yaml.example ]; then
  cp /opt/hermes-agent/cli-config.yaml.example /data/.hermes/config.yaml
fi

# Persona: SOUL.md ocupa o slot #1 do system prompt (identidade do agente).
# Gerenciada pelo repo (projects/agents/hermes/soul.md) — sobrescreve a cada boot.
# Para ajustar a persona, edite o soul.md no repo e faça novo deploy.
if [ -f /app/soul.md ]; then
  cp /app/soul.md /data/.hermes/SOUL.md
fi

[ ! -f /data/.hermes/.env ] && touch /data/.hermes/.env

# is_config_complete() em server.py lê LLM_MODEL do /data/.hermes/.env — mantém em
# sync com a env var LLM_MODEL do Railway (gpt-5.5) sem precisar salvar pela UI.
if [ -n "${LLM_MODEL:-}" ]; then
  if grep -q '^LLM_MODEL=' /data/.hermes/.env; then
    sed -i "s|^LLM_MODEL=.*|LLM_MODEL=${LLM_MODEL}|" /data/.hermes/.env
  else
    printf 'LLM_MODEL=%s\n' "$LLM_MODEL" >> /data/.hermes/.env
  fi
fi

# Bootstrap OAuth tokens from env var (e.g. xAI Grok SuperGrok).
# Set HERMES_AUTH_JSON_BOOTSTRAP to the contents of a locally-generated
# ~/.hermes/auth.json. Written only once — subsequent token refreshes update
# the file in place on the persistent volume.
if [ ! -f /data/.hermes/auth.json ] && [ -n "${HERMES_AUTH_JSON_BOOTSTRAP}" ]; then
  printf '%s' "${HERMES_AUTH_JSON_BOOTSTRAP}" > /data/.hermes/auth.json
  chmod 600 /data/.hermes/auth.json
fi

# Clear any stale gateway PID file left over from the previous container.
# `hermes gateway` writes /data/.hermes/gateway.pid on start but does not
# remove it on SIGTERM. Since /data is a persistent volume, the file
# survives container restarts and causes every subsequent boot to exit with
# "ERROR gateway.run: PID file race lost to another gateway instance".
# No hermes process can be running at this point (we're pre-exec in a fresh
# container), so removing the file unconditionally is safe.
rm -f /data/.hermes/gateway.pid

exec python /app/server.py
