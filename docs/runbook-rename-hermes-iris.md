# Runbook — rename do nó `hermes-g2` → `hermes-iris`

Estado: **não executado.** Gate operacional separado do upgrade do Tailscale,
porque misturar mudança de versão e mudança de hostname piora diagnóstico e
rollback — se algo quebrar, não se sabe qual das duas causou.

## Não precisa de mudança de código

`TS_HOSTNAME` **não está setado** no painel do serviço `Iris` (verificado
2026-07-19: só existem lá `TS_AUTHKEY` e `TS_DEBUG_ALWAYS_USE_DERP`). O
`hermes-boot.sh` usa o default `hermes-g2`, e uma env var no painel o sobrescreve.
Então o rename é uma variável e um restart — nada a deployar.

O boot já executa a sequência inteira sozinho: `tailscale set --hostname` →
`tailscale cert $TS_FQDN` → `tailscale serve --bg --https=443`.

## Os dois riscos reais

**1. A emissão do cert novo falha em silêncio.** O `hermes-boot.sh` faz
`timeout 90 ... tailscale cert "$TS_FQDN" ... || true`. Se o certificado de
`hermes-iris.tail390702.ts.net` não sair, o `serve` fica sem cert e **a Iris fica
inalcançável pela tailnet** — que é o caminho normal de acesso ao dashboard, já
que não há Funnel e o dashboard escuta em loopback.

Por isso o acesso out-of-band tem que estar testado **antes** de mexer. Testar
depois de quebrar não conta.

**2. Config órfã do `serve`.** O `tailscale serve` guarda a configuração chaveada
pelo nome DNS. Após o rename pode sobrar a entrada de `hermes-g2...:443` ao lado
da nova. O `hermes-boot.sh` não faz `serve reset`, então isso é passo manual.

## Pré-condições

1. Acesso out-of-band **testado agora**, não assumido:
   - `railway ssh --service Iris` conecta
   - `railway logs --service Iris` streama
   - `https://hermes-production-bfba.up.railway.app/health` responde
2. Rollback pré-digitado num segundo terminal (seção abaixo).
3. Nenhum cron na janela; ninguém usando o endpoint `/v1` dos óculos G2.
4. John presente.

## Execução

```
# 1. seta o hostname novo SEM disparar deploy
railway variable set TS_HOSTNAME=hermes-iris --service Iris --skip-deploys

# 2. confirma que gravou ANTES de reiniciar
railway variable list --kv --service Iris | grep TS_HOSTNAME

# 3. um único restart, sem rebuild
railway restart --service Iris
```

Nunca `railway up`: ele faria rebuild e subiria a working tree local.
Nunca `railway variable delete`: não tem `--skip-deploys` e sempre dispara deploy.

Downtime esperado: 60–120 s até o HTTPS responder. Caem todas as sessões PTY e os
assinantes de `/api/ws` e `/api/events`.

## Verificação

Nesta ordem — a 2 é a que decide.

```
# 1. nó renomeado
tailscale status | grep hermes-iris

# 2. CERT EMITIDO para o nome novo (o passo que falha em silêncio)
openssl s_client -connect hermes-iris.tail390702.ts.net:443 \
  -servername hermes-iris.tail390702.ts.net </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -dates

# 3. HTTPS responde no nome novo
curl -s -o /dev/null -w '%{http_code}\n' https://hermes-iris.tail390702.ts.net/

# 4. sem entrada órfã do nome antigo
railway ssh --service Iris -- tailscale --socket=/var/run/tailscale/tailscaled.sock serve status

# 5. gateway subiu (ver nota abaixo)
curl -su "$ADMIN" https://hermes-production-bfba.up.railway.app/setup/api/status | jq .gateway
```

Se a 4 mostrar entrada órfã de `hermes-g2`, limpar dentro do container:
`tailscale --socket=... serve reset` e deixar o boot republicar (ou republicar à
mão apontando para `http://127.0.0.1:9200`).

Sobre a 5: há incidente de 2026-07-16 em que o gateway não voltou sozinho após
restart, ~35 min até um `POST /setup/api/gateway/start` manual. O commit `e2eab53`
trata a detecção de auto-start, mas tem pouca quilometragem.

## Rollback

Pré-digitar antes de começar.

```
railway variable set TS_HOSTNAME=hermes-g2 --service Iris --skip-deploys
railway variable list --kv --service Iris | grep TS_HOSTNAME
railway restart --service Iris
```

O cert antigo continua em `/data/.tailscale`, então a volta é rápida. Orçar 5 min
até "confirmado restaurado".

## Depois do rename, fora do container

- Repontar o **Hermes Desktop** no Mac para `hermes-iris.tail390702.ts.net`.
- Atualizar as memórias que citam a FQDN antiga
  (`project_iris_desktop_tailscale.md`, `reference_iris_chat_channel.md`).
- Confirmar que o plugin `iris-glass` usa a URL pública do Railway e não a tailnet
  — os óculos não estão na tailnet, então deve estar, mas é verificação, não
  suposição.
- No repo, `hermes-g2` ainda aparece em comentários de `hostproxy.py` e nos docs
  históricos de `g2-bridge/` (endpoint já descomissionado). Atualizar em commit
  próprio, depois do cutover confirmado.
