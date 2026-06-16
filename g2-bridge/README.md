# Iris × Even Realities G2 — bridge n8n (BYOA)

Bridge HTTP que liga os óculos **Even Realities G2** à **Iris** (agente hermes) pelo recurso
**Add Agent / BYOA** do Even Hub. O G2 fala com um endpoint OpenAI-compat; o n8n traduz e
consome a Iris real.

```
Even G2 (STT no device)
  → Even Hub "Add Agent" (URL + Token)
  → POST raiz  https://n8n.cobaiateam.com.br/webhook/iris-g2   [Bearer G2_TOKEN]
  → n8n "Iris G2 bridge" (k8tNwFXK8bYJAu1v): valida token · extrai msg · chama Iris (22s) · sanitiza
  → POST  https://hermes-production-bfba.up.railway.app/v1/chat/completions  [Header Auth, stream:false]
  → hermes api_server = Iris REAL (tools/memória/persona)
  → 200 JSON OpenAI chat.completion → HUD do G2
```

## Spec do BYOA (engenharia reversa — fonte: blog.juchunko.com G2×OpenClaw + worker.js de ref.)

- O G2 faz **`POST` na RAIZ exata da URL** colada no app. **NÃO** acrescenta `/v1/chat/completions`.
  Por isso a URL no Even Hub tem que ser o **webhook completo** (`.../webhook/iris-g2`).
- Payload: `{"model":"openclaw","messages":[{"role":"user","content":"..."}]}` + header
  `x-openclaw-agent-id: main`. STT é **no device** (manda texto, não áudio).
- Resposta esperada: **JSON OpenAI `chat.completion` NÃO-streaming**, `200`, `application/json`.
- **Timeout ~30s** no G2 → deadline interno de **22s**.
- Display: ~**400 chars**, plain-text, sem markdown/links/código.

Diagnóstico do fracasso da Fase D (endpoint /v1 nativo do hermes): o app rejeitava porque o
G2 batia na raiz da URL (`.../v1`) e não em `/v1/chat/completions` (caía no catch-all do admin),
e/ou o tool-call de ~34s estourava os 30s. O bridge n8n conserta path, formato e timeout sem
mexer no hermes.

## Comportamento

| Caso | Resposta |
|------|----------|
| Token errado | `401` `{error:{message,type}}` |
| Iris responde < 22s (query sem tool, ~6s) | `200` resposta real sanitizada (~300ch) |
| Iris demora > 22s (tool-call ~34s) / offline / sem credencial | `200` ack: `Tô resolvendo isso e te aviso depois.` |

Brevidade é aplicada 2×: o hermes injeta ~400ch (`_inject_brevity`) e o n8n re-sanitiza ~300ch.

## Setup

### 1. Credencial no n8n (passo do John — chave prod fica com você)
`n8n_manage_credentials` está DESLIGADO no MCP de propósito, então a credencial é criada na UI:
1. n8n → Credentials → New → **Header Auth**.
2. Name (do header) = `Authorization` · Value = `Bearer <API_SERVER_KEY do hermes>`
   (a chave está nas Railway vars do serviço `hermes` e na memória `project_foxy_hermes_migration`).
3. Nomeie a credencial (ex.: `hermes-g2-key`).
4. Workflow `Iris G2 bridge` → nó **call Iris (hermes)** → selecione essa credencial → Save.

### 2. Token de entrada (G2_TOKEN)
Gerado fora do repo, embutido como const no nó `validate + extract` (rotatável). O valor real
**não** vai pro git (placeholder `__G2_TOKEN__` no `.workflow.json`). Para girar: edite a const
no nó e reconfigure o app Even.

### 3. Even Hub (passo do John — no device)
1. Even Hub → **Add Agent** → Nome `Iris` · URL `https://n8n.cobaiateam.com.br/webhook/iris-g2`
   (URL completa) · Token = `G2_TOKEN`.
2. **Remover** o endpoint morto `hermes-g2.tail390702.ts.net/v1` (herança Tailscale).
3. Testar: "Iris, resume meu foco agora.", "Qual minha próxima reunião?", "O que faço primeiro?".

## Teste

```bash
G2_TOKEN=<token> node projects/agents/hermes/g2-bridge/test.mjs
```
Antes da credencial: tudo cai no ack (prova o contrato). Depois: `no-tool` volta resposta real da Iris.

## Se o app Even ainda rejeitar
1. **Probe webhook.site**: aponte o Add Agent pro webhook.site, fale nos óculos, capture o
   request exato (headers/body) que o G2 manda pro nosso endpoint e ajuste o bridge.
2. **Plano B — plugin g2-fluxo**: caminho provado (carta CHAT já fala com a cobaia no device).
   Apontar uma carta pra Iris = `src/api.ts` (`sendToIris()`) + `src/input.ts` + fonte de histórico.
   UX mais pesada (abrir plugin, gravar voz), por isso é fallback.

## Fase 2 (pós-MVP)
- Push assíncrono de tarefa longa: em vez de abortar em 22s, rodar o hermes em background e
  empurrar o resultado por um canal (WhatsApp quando o chip chegar; Telegram/foxy enquanto isso).
- Roteador de intenção, lembrete rápido, comando executivo.

## Arquivos
- `Iris-G2-bridge.workflow.json` — export importável (token placeholdered).
- `test.mjs` — teste ponta-a-ponta.
- Workflow vivo: n8n cobaiateam, id `k8tNwFXK8bYJAu1v` (ativo).
- Endpoint hermes consumido: `../server.py` (`route_api_v1`) — **não mexer**.
