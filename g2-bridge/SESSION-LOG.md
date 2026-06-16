# Log da sessão — Integração óculos Even G2 ↔ Iris (2026-06-15/16)

Documento de handoff: o que foi executado, estado atual e pendências. Escrito para a Iris
(agente hermes) ter contexto do que mudou no servidor dela.

## Objetivo
Falar com a Iris pelos óculos Even Realities G2 usando o recurso BYOA / "Add Agent" do Even Hub,
que espera um endpoint OpenAI-compat. Solução: um **bridge n8n** na frente que traduz e consome a Iris.

## O que foi executado (cronológico)

### 1. Bridge n8n — workflow `Iris G2 bridge` (`k8tNwFXK8bYJAu1v`, ATIVO)
Criado e ativado na instância cobaiateam (`n8n.cobaiateam.com.br`). 8 nós:
Webhook POST `iris-g2` (responseNode) → Code valida Bearer + extrai última msg `user` →
IF → HTTP `POST https://hermes-production-bfba.up.railway.app/v1/chat/completions`
(Header Auth, `stream:false`, **timeout 22s**, `onError:continueErrorOutput`) →
Code sanitiza + monta `chat.completion` / Code ack → Respond.
- URL pública (vai no Even Hub): `https://n8n.cobaiateam.com.br/webhook/iris-g2`
- Token de entrada (G2): `<G2_TOKEN>` (const no nó `validate`, rotatável)
- Comportamento: token errado→401; Iris<22s→resposta real sanitizada (~300ch); >22s/erro→ack
  "Tô resolvendo isso e te aviso depois."
- Descoberta da spec BYOA (reverse-eng): o G2 faz `POST` na RAIZ da URL (não `/v1/chat/completions`),
  manda `{model:"openclaw", messages:[...]}` + header `x-openclaw-agent-id: main`, STT no device
  (texto, não áudio), timeout ~30s, espera JSON OpenAI NÃO-streaming. Isso explica o fracasso da
  Fase D (o endpoint nativo `/v1` do hermes recebia POST em `.../v1` cru → catch-all).

### 2. Credencial no n8n
John criou na UI a credencial Header Auth `Iris (Hermes Agent)` (id `c4kSBvTCKEHJHAx9`):
header `Authorization` = `Bearer <API_SERVER_KEY do hermes>`. Anexada ao nó `call Iris (hermes)`.
(A `API_SERVER_KEY` fica só nessa credencial criptografada do n8n — nunca no workflow exportado.)

### 3. Hermes — fix do api_server caído
`/v1/models` sem bearer dava 503 "api_server unavailable" (o reverse-proxy do server.py não
alcançava o loopback 127.0.0.1:8642), embora o admin respondesse. **Ação: `railway redeploy`**
(serviço `Iris`) → start.sh limpa `gateway.pid` stale, gateway re-sobe + api_server volta a escutar.

### 4. Hermes — fix da cadeia de modelo (`deploy-config.yaml`)
Causa do bloqueio: o agente caía no **Gemini** (fallback OpenRouter antigo) e o Gemini **rejeita o
schema de tools MCP** (ex: GitHub `issue_fields`) com 400 INVALID_ARGUMENT → toda rodada com tools
falhava (`502 agent_incomplete`). **Ação: troquei `fallback_providers` por cadeia de 3 níveis:**
```yaml
model: { default: "gpt-5.5", provider: "openai-codex" }
fallback_providers:
  - { provider: "anthropic",  model: "claude-sonnet-4-6" }       # assinatura Claude
  - { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" }  # último recurso
```
Deploy via `railway up` (deploy-config é baked na imagem → precisa rebuild). NUNCA Gemini (quebra schemas).

## Estado verificado (funciona)
- Óculos → bridge → Iris: **correto**. Request real do G2 (exec 166341): "boa noite" →
  "Boa noite, John. Precisa de algo?" em 5.4s.
- Queries conversacionais: resposta real ~2-5s, sanitizada, sem markdown.
- Queries com tool (ex: "tenho evento hoje?"): ~22s+ → estoura o deadline de 22s → **ack**
  (latência inerente agente+MCP, NÃO crash). Fix real = Fase 2 (push assíncrono).

## Diagnóstico ABERTO (precisa ação)
- **A Iris NÃO está usando o Codex.** Logs do gateway:
  `🔌 Provider: nous  Model: gpt-5.5 → HTTP 404 "Model 'gpt-5.5' not found"`.
  O `gpt-5.5` está indo pro **Nous Portal** (`inference-api.nousresearch.com`), não pro OpenAI Codex.
  Causa: provider em `auto` + **Codex OAuth não ativo no servidor** (CODEX_AUTH_B64 no volume stale;
  refresh token provavelmente morto) → `auto` não acha o Codex, tenta o Nous (credencial do setup
  inicial), 404, cai no fallback. Por isso responde, mas via fallback (assinatura Anthropic ou OpenRouter).

## Pendências (John / Iris)
1. **Re-autenticar o Codex no servidor** (corrige o provider `nous`→`openai-codex`):
   dashboard hermes → Models/Keys → OpenAI Codex → device-code login
   (ou `hermes auth add codex-oauth` / `hermes model` → OpenAI Codex). Depois validar nos logs
   que o provider virou `openai-codex` e o `gpt-5.5` para de 404.
2. **Confirmar a assinatura Anthropic como fallback** (provider `anthropic`): exige Claude Max +
   créditos extras comprados (a cota base não é consumível pelo hermes; bug upstream #15080).
   Auth: `claude setup-token` → `ANTHROPIC_TOKEN` no Railway, ou OAuth Claude Code no dashboard.
   Se falhar, a cadeia cai no OpenRouter Claude (`OPENROUTER_API_KEY` já setada).
3. **Even Hub → Add Agent** (passo do device): URL `https://n8n.cobaiateam.com.br/webhook/iris-g2`,
   token `<G2_TOKEN>`; remover endpoint morto `hermes-g2.tail390702.ts.net/v1`.
4. **Fase 2 (latência de tool-queries):** push assíncrono — ack na hora + entrega o resultado depois
   por outro canal (WhatsApp/Telegram/foxy) em vez de estourar os 22s.

## Atualização 2026-06-16 (pós-fixes da Iris + verificação)

A Iris mexeu no servidor e reportou. Reconciliação:

**Confirmado/bom (supera meu achado "Codex não carregado"):**
- Iris achou a raiz real: o `server.py` reescrevia `provider: auto` no restart (lógica de merge antiga).
  **Patchou `/app/server.py` pra priorizar o provider do `deploy-config.yaml`.** Agora roda
  `openai-codex` / `gpt-5.5` de verdade. api_server (8642) de volta (restart via API de admin).
- Fallback que ela deixou ativo: **openai-codex → openrouter (Claude)**. Anthropic direto REMOVIDO
  da cadeia (era o tier que eu tinha posto; estava buggy/precisava Max+créditos).

**Correção (verificado empiricamente, sem segredo):** a orientação da Iris de apontar o Even Hub
pra `/v1` está INVERTIDA pro comportamento do G2:
- `POST /v1` → `401 {"error":"Unauthorized"}` (catch-all do ADMIN = falha).
- `POST /v1/chat/completions` → `401 {"error":{"message":"Invalid API key"...}}` (chega no api_server).
O G2 posta na URL EXATA configurada (não acrescenta `/chat/completions`). Logo, pra usar o /v1 nativo
direto no G2, a URL teria que ser `.../v1/chat/completions` (completa) — e mesmo assim sem o ack
gracioso dos 22s nem a sanitização. **O bridge segue sendo o caminho device-provado e melhor de UX.**

**Durabilidade — RECONCILIADO no repo (2026-06-16):** o patch da Iris vivia só no `/app/server.py`
do container (efêmero — `/app` não é git; rebuild do `railway up` sobe o working tree). Aliniei:
- `server.py` `write_config_yaml`: agora **preserva provider explícito não-"auto"** (start.sh copia
  o deploy-config pinando `openai-codex`; só cai em `auto` se não houver provider explícito). Era a
  linha que forçava `auto` sempre que havia API key (OPENROUTER) → mis-resolvia gpt-5.5 pro Nous → 404.
  (Reimplementação minha do patch da Iris — mesmo resultado; Iris deve confirmar que casa com o dela.)
- `deploy-config.yaml`: fallback = **`openrouter` (anthropic/claude-sonnet-4.6)** só. Anthropic direto
  REMOVIDO (decisão John/Iris: exige Max+créditos extras + bug #15080). Cadeia final: codex → openrouter.
- Sintaxe `server.py` validada (ast.parse OK). Container atual já está correto (patch da Iris) — NÃO
  redeployei; o repo alinhado é pra um `railway up` futuro não regredir.

## Artefatos / refs
- Workflow vivo: n8n cobaiateam id `k8tNwFXK8bYJAu1v` (ativo).
- `projects/agents/hermes/g2-bridge/`: `README.md`, `Iris-G2-bridge.workflow.json` (token placeholdered), `test.mjs`.
- `projects/agents/hermes/deploy-config.yaml`: cadeia de fallback editada (working tree, não commitado).
- Endpoint hermes consumido: `server.py` `route_api_v1` (porta 8642 loopback) — não alterado.
- Spec BYOA: blog `blog.juchunko.com/en/even-realities-g2-openclaw-bridge` + `github.com/dAAAb/openclaw-even-g2-bridge-skill`.
