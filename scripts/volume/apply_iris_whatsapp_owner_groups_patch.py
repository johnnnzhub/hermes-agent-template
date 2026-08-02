#!/usr/bin/env python3
"""Reapply Iris's WhatsApp owner-group gate to the installed Hermes runtime.

The Hermes install tree under /opt is replaced by image updates, while /data is
persistent. This idempotent pre-boot patch keeps owner-typed messages enabled
only for configured allowlisted groups and leaves every other profile opted out.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import time
from pathlib import Path

BRIDGE_PATH = Path(os.environ.get(
    "IRIS_WHATSAPP_BRIDGE_PATH",
    "/opt/hermes-agent/scripts/whatsapp-bridge/bridge.js",
))
ADAPTER_PATH = Path(os.environ.get(
    "IRIS_WHATSAPP_ADAPTER_PATH",
    "/opt/hermes-agent/plugins/platforms/whatsapp/adapter.py",
))
BACKUP_ROOT = Path(os.environ.get(
    "IRIS_WHATSAPP_PATCH_BACKUP_ROOT",
    "/data/.hermes/backups/whatsapp-owner-groups-runtime",
))

BRIDGE_OLD = """      if (msg.key.fromMe) {
        if (isGroup || chatId.includes('status')) {
          emitDebugEvent({
            stage: 'ignored',
            reason: isGroup ? 'from_me_group' : 'from_me_status',
            chatId: redactWhatsAppId(chatId),
          });
          continue;
        }

        if (WHATSAPP_MODE === 'bot') {
"""
BRIDGE_NEW = """      if (msg.key.fromMe) {
        // Status/newsletter pseudo-chats are never actionable. In bot mode,
        // allow owner-typed group messages to reach the owner gate below;
        // that gate still requires the explicit forwarding flag and a matching
        // group JID in the bridge allowlist. Other modes retain the old drop.
        if (chatId.includes('status')) {
          emitDebugEvent({
            stage: 'ignored',
            reason: 'from_me_status',
            chatId: redactWhatsAppId(chatId),
          });
          continue;
        }
        if (isGroup && WHATSAPP_MODE !== 'bot') {
          emitDebugEvent({
            stage: 'ignored',
            reason: 'from_me_group',
            chatId: redactWhatsAppId(chatId),
          });
          continue;
        }

        if (WHATSAPP_MODE === 'bot') {
"""

# Ancoras: o MENOR trecho contiguo estavel, nao o bloco inteiro.
#
# Ate 2026-08-02 estas duas ancoras eram blocos de 3 e 4 linhas contiguas. O
# upstream inseriu tratamento de `send_read_receipts` no MEIO das duas entre
# 0.18.2 e 0.19.1 -- sem remover nem renomear nada -- e as duas pararam de casar.
# Bloco longo e fragil por construcao: quanto mais linhas a ancora cobre, maior a
# chance de o upstream escrever alguma coisa la dentro. Ancorar numa unica linha
# estavel e inserir DEPOIS dela sobrevive a insercao de vizinhos.
#
# Verificado nas duas arvores: as ancoras abaixo casam exatamente uma vez em
# 0.18.2 e em 0.19.1.
ADAPTER_INIT_OLD = """        self._group_allow_from = self._coerce_allow_list(config.extra.get(\"group_allow_from\") or config.extra.get(\"groupAllowFrom\"))
"""
ADAPTER_INIT_NEW = """        self._group_allow_from = self._coerce_allow_list(config.extra.get(\"group_allow_from\") or config.extra.get(\"groupAllowFrom\"))
        _forward_owner_messages = config.extra.get(\"forward_owner_messages\")
        if _forward_owner_messages is None:
            _forward_owner_messages = os.getenv(\"WHATSAPP_FORWARD_OWNER_MESSAGES\", \"\")
        self._forward_owner_messages = str(_forward_owner_messages).strip().lower() in {
            \"1\", \"true\", \"yes\", \"on\",
        }
"""

ADAPTER_ENV_OLD = """            bridge_env = with_hermes_node_path()
            if self._reply_prefix is not None:
                bridge_env[\"WHATSAPP_REPLY_PREFIX\"] = self._reply_prefix
"""
ADAPTER_ENV_NEW = """            bridge_env = with_hermes_node_path()
            if self._reply_prefix is not None:
                bridge_env[\"WHATSAPP_REPLY_PREFIX\"] = self._reply_prefix
            bridge_env[\"WHATSAPP_DM_POLICY\"] = self._dm_policy
            # Owner forwarding is opt-in per profile. The bridge's owner gate
            # checks chatId against WHATSAPP_ALLOWED_USERS; only while enabled
            # do we extend that inherited DM allowlist with configured group JIDs.
            bridge_env[\"WHATSAPP_FORWARD_OWNER_MESSAGES\"] = (
                \"true\" if self._forward_owner_messages else \"false\"
            )
            bridge_allowed_users = {
                value.strip()
                for value in bridge_env.get(\"WHATSAPP_ALLOWED_USERS\", \"\").split(\",\")
                if value.strip()
            }
            bridge_allowed_users.update(self._allow_from)
            if self._forward_owner_messages:
                bridge_allowed_users.update(self._group_allow_from)
            if bridge_allowed_users:
                bridge_env[\"WHATSAPP_ALLOWED_USERS\"] = \",\".join(sorted(bridge_allowed_users))
"""


def _replace_once(text: str, old: str, new: str, *, label: str) -> tuple[str, bool]:
    if new in text:
        return text, False
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one upstream block, found {count}")
    return text.replace(old, new, 1), True


def _atomic_write(path: Path, text: str) -> None:
    mode = path.stat().st_mode
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        handle.write(text)
        temp = Path(handle.name)
    try:
        os.chmod(temp, mode)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _backup(path: Path, backup_dir: Path) -> None:
    backup_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup_dir / path.name)


def patch_runtime() -> list[str]:
    bridge = BRIDGE_PATH.read_text(encoding="utf-8")
    adapter = ADAPTER_PATH.read_text(encoding="utf-8")

    bridge, bridge_changed = _replace_once(
        bridge, BRIDGE_OLD, BRIDGE_NEW, label="bridge owner-group prefilter"
    )
    adapter, init_changed = _replace_once(
        adapter, ADAPTER_INIT_OLD, ADAPTER_INIT_NEW, label="adapter owner flag"
    )
    adapter, env_changed = _replace_once(
        adapter, ADAPTER_ENV_OLD, ADAPTER_ENV_NEW, label="adapter bridge environment"
    )

    changed: list[str] = []
    if bridge_changed or init_changed or env_changed:
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        backup_dir = BACKUP_ROOT / stamp
        if bridge_changed:
            _backup(BRIDGE_PATH, backup_dir / "bridge")
            _atomic_write(BRIDGE_PATH, bridge)
            changed.append(str(BRIDGE_PATH))
        if init_changed or env_changed:
            _backup(ADAPTER_PATH, backup_dir / "adapter")
            _atomic_write(ADAPTER_PATH, adapter)
            changed.append(str(ADAPTER_PATH))

    # Explicit postconditions make silent partial application impossible.
    final_bridge = BRIDGE_PATH.read_text(encoding="utf-8")
    final_adapter = ADAPTER_PATH.read_text(encoding="utf-8")
    required = {
        "bridge bot-only group prefilter": "if (isGroup && WHATSAPP_MODE !== 'bot')" in final_bridge,
        "bridge status hard-drop": "reason: 'from_me_status'" in final_bridge,
        "adapter config flag": "self._forward_owner_messages" in final_adapter,
        "adapter explicit env flag": "WHATSAPP_FORWARD_OWNER_MESSAGES" in final_adapter,
        "adapter group allowlist union": "bridge_allowed_users.update(self._group_allow_from)" in final_adapter,
    }
    failed = [name for name, ok in required.items() if not ok]
    if failed:
        raise RuntimeError("postcondition failed: " + ", ".join(failed))
    return changed


def main() -> int:
    changed = patch_runtime()
    print("whatsapp owner-group runtime patch: " + (", ".join(changed) if changed else "unchanged"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
