# `scripts/volume/` — a camada de patch que roda em todo boot

Estes arquivos **não fazem parte da imagem**. Eles vivem no volume Railway, em
`/data/.hermes/scripts/`, e são executados a cada inicialização por
`iris_pre_server_bootstrap.sh`, que por sua vez é chamado pelo `hermes-boot.sh` e de
novo pelo `start.sh`.

Estão versionados aqui porque, até 2026-08-02, **existiam apenas no volume**. Sem cópia
no git, perder o volume significava perder a camada inteira que mantém o roteamento dos
grupos de WhatsApp, o contexto do cron, a captura de journal e o lock codex-only — sem
nenhuma forma de reconstruí-la.

Versionar não muda nada em produção: o `Dockerfile` copia `scripts/` para `/app/scripts/`
só para que os arquivos possam ser copiados para `HERMES_HOME/scripts/` na ativação.
Estar aqui **não agenda nada**.

## O que estes patchers editam

Sete deles editam o **core** em `/opt/hermes-agent`, casando por âncora de texto contra
o código da versão instalada. Três editam o wrapper em `/app`. Isso significa que
**todo bump do core pode quebrá-los**, e é a razão de o upgrade 0.19.1 estar gated por
uma matriz de veredito por patcher.

| arquivo | alvo | isolável por |
|---|---|---|
| `ensure_allocator_bootstrap.py` | `/app/start.sh` | `IRIS_START_SH_PATH` |
| `ensure_tini_bootstrap.py` | `/app/hermes-boot.sh`, `/app/start.sh` | `IRIS_HERMES_BOOT_PATH` |
| `ensure_persistent_mcp_binaries.py` | configs de MCP | `IRIS_MCP_CONFIG_PATHS` |
| `ensure_codex_only.py` | config canônica + `/app/deploy-config.yaml` | `HERMES_HOME` (parcial) |
| `ensure_codex_oauth_gateway_autostart.py` | `/app/server.py` | `IRIS_SERVER_AUTOSTART_TARGET` |
| `apply_iris_ops_runtime_patches.py` | `/app/server.py`, `agent/agent_init.py`, `agent/conversation_compression.py`, `batch_runner.py` | — |
| `apply_iris_model_routing_patch.py` | `gateway/run.py`, `iris_model_router.py` | — |
| `apply_iris_cron_whatsapp_context_patch.py` | bridge + cron do core | `HERMES_RUNTIME_ROOT` |
| `apply_iris_whatsapp_owner_groups_patch.py` | `plugins/platforms/whatsapp/adapter.py`, `scripts/whatsapp-bridge/bridge.js` | `IRIS_WHATSAPP_BRIDGE_PATH`, `IRIS_WHATSAPP_ADAPTER_PATH` |

## Três ainda NÃO estão aqui

`apply_iris_journal_group_capture_patch.py`, `apply_iris_tasks_router_gateway_patch.py` e
`ensure_whatsapp_group_routes.py` **embutem IDs de grupo de WhatsApp** (`...@g.us`) no
código. Este repositório é **público**, então eles ficam de fora até que a lista seja
externalizada — lida do config canônico em vez de hardcoded, o que também remove a
duplicação de fonte de verdade entre patcher e config.

Enquanto isso, eles existem só no volume, e essa é uma pendência nomeada, não um
esquecimento.

## Dois defeitos de padrão conhecidos

**1. Falham abertos.** Todas as chamadas em `iris_pre_server_bootstrap.sh` estão
encadeadas com `|| log "WARN ..."`. Patcher que falha vira uma linha de log e o boot
segue. O sintoma que isso produz não é o container cair: é ele subir com `/health` 200 e
WhatsApp `connected` enquanto uma função morre calada.

Baseline conhecido em 2026-08-01 (0.18.2), **pré-existente**:

- `ensure_codex_oauth_gateway_autostart.py` → `unsupported is_config_complete shape`;
- `apply_iris_cron_whatsapp_context_patch.py` → `bridge quote extraction: expected one
  upstream anchor, found 0`.

**2. Aplicam parcial e retornam sucesso.** `apply_iris_ops_runtime_patches.py` insere a
definição de uma função num bloco e a chamada dela noutro, sem exigir os dois. Quando o
primeiro não casou, gravou `/app/server.py` com a chamada e sem a função:
`GET /glass/tasks` respondeu 500 por `NameError` de 2026-07-13 até 2026-08-02.

Pior variante: `apply_iris_tasks_router_gateway_patch.py` com âncora ausente **retorna
exit 0 e imprime "skip patch"** — falso verde, que nem entra na contagem de WARN.

Por isso o critério de aceite de qualquer boot não pode ser exit code nem contagem de
WARN. Tem que ser **efeito verificado**.
