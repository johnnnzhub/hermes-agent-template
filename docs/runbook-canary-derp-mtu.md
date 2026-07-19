# Runbook — canário de remoção do DERP forçado

Estado: **não executado, e não para executar na Railway.**

## Onde rodar, e por quê não é aqui

`TS_DEBUG_ALWAYS_USE_DERP=1` foi aplicado em 2026-06-16 para contornar um
black-hole de MTU no caminho DIRECT: o handshake TLS (cert ~4,8 KB) era dropado
com DF set e sem ICMP de volta. Sintoma: HTTPS via MagicDNS oscilava 16/16
TIMEOUT/ECONNRESET na janela direct contra 8/8 HTTP 200 na janela DERP, enquanto
`tailscale ping` sempre passava (pacotes pequenos passavam, grandes não).

Esse black-hole é propriedade da rede da **Railway** (userspace networking, NAT de
egress). A Iris está em migração para o Hetzner, onde a rede é real e o perfil é
outro. Rodar o canário aqui gasta o orçamento de mudança arriscada num sistema que
será desligado, e a resposta obtida **não vale no destino**.

Além disso, um restart agora interage com o HOLD do Gate D: queima a evidência de
estabilidade, pode re-registrar o hostname na tailnet, e muda o estado que o
rollback do Gate D assume.

**Executar no Hetzner, depois da migração.** O que deve subir antes, e já hoje, é
o monitor (`docs/runbook-monitor-derp.md`): ele é read-only, não reinicia nada, e
o `.jsonl` que acumula é exatamente a linha de base contra a qual este canário
será medido.

## O que a ausência de endpoints não prova

Hoje o peer não anuncia nenhum `Endpoints` e os contadores mostram 0 bytes em
`direct_ipv4`/`direct_ipv6`. Isso **não** é evidência de que o caminho direto seja
impossível: `TS_DEBUG_ALWAYS_USE_DERP=1` desativa o UDP no magicsock e *produz*
essa observação. É circular. Só o Teste 0 abaixo, com a flag desligada, mede o
estado real da rede.

## Pré-condições

1. Monitor rodando há **≥ 7 dias** com `.jsonl` populado. Sem "antes", o canário
   não é mensurável.
2. HOLD do Gate D formalmente liberado por escrito.
3. Acesso out-of-band testado **antes** de mexer em qualquer coisa: SSH ao host,
   logs, e um segundo caminho até o dashboard. Se o canário derrubar a tailnet,
   são as mãos remotas.
4. Decidir **antes** o destino do `TS_DEBUG_MTU=1024`: ver a seção final.
5. Rollback pré-digitado num segundo terminal; logs streamando num terceiro.
6. Janela em dia útil, não sexta. John presente do começo ao fim.

## Baseline, ainda com DERP forçado

**30 amostras, não 8** — 30 dá p50/p95 utilizável; 8 dá anedota. Salvar em arquivo
com timestamp.

```
# 1. descobrir um asset grande (>100 KB) servido pelo dashboard
curl -sk https://<no>/ | grep -oE '/[a-zA-Z0-9._/-]+\.(js|css)' | head

# 2. payload grande, 30 amostras, handshake novo a cada uma
for i in $(seq 30); do
  curl -s -o /dev/null -w '%{http_code} %{size_download} %{time_total}\n' https://<no>/<asset>
done

# 3. ping
tailscale ping --c=30 <no>

# 4. caminho atual
tailscale status --json | jq '.Peer[] | select(.HostName=="<no>") | {CurAddr, Relay, Endpoints}'

# 5. condições locais
tailscale netcheck

# 6. três janelas do monitor (45 min): Dq, Dd e razão de cada uma, do .jsonl
```

## Execução

```
# 1. rede de proteção primeiro, SEM deploy
railway variable set TS_DEBUG_MTU=1024 --service Iris --skip-deploys

# 2. desliga o forçamento. SETAR 0 — NUNCA DELETAR.
railway variable set TS_DEBUG_ALWAYS_USE_DERP=0 --service Iris --skip-deploys

# 3. confirmar que as duas gravaram, ANTES de reiniciar
railway variable list --kv --service Iris | grep TS_DEBUG

# 4. um único restart, sem rebuild
railway restart --service Iris
```

`railway variable delete` **não tem** `--skip-deploys` e sempre dispara deploy
(verificado no `--help`); por isso setar `=0` em vez de deletar. O envknob aceita
`"0"` como false, o rollback fica simétrico, e a entrada continua visível no
painel para ninguém esquecer que existiu.

`railway up` é proibido: faria rebuild e subiria a working tree local.

## Validação

### Teste 0 — bloqueante: o caminho mudou de fato?

Este vem antes de todos, e é o que quase se esquece.

```
# aquece: 60 s de tráfego para o direct ter chance de subir
for i in $(seq 30); do curl -sk -o /dev/null https://<no>/; sleep 2; done

tailscale status --json | jq '.Peer[] | select(.HostName=="<no>") | {CurAddr, Relay, Endpoints}'
tailscale ping --c=20 <no> | grep -c direct
```

Se `Endpoints` continuar vazio e os pings continuarem via DERP, **o teste não
aconteceu**: o tailscaled caiu de volta no relay sozinho, todos os testes abaixo
vão passar, e a conclusão "direct funciona" seria falsa. Abortar e voltar.

### Teste 1 — payload grande (decisivo)

O bug original era MTU no handshake TLS, direção **container → Mac**. O teste
precisa forçar **resposta** grande, não requisição grande.

```
for i in $(seq 30); do
  curl -s -o /tmp/canary.bin -w '%{http_code} %{size_download} %{time_total}\n' https://<no>/<asset-grande>
done
```

Validar `size_download` **byte-exato** contra `Content-Length`, não só o status.
Corpo truncado com HTTP 200 é a assinatura do black-hole de MTU — checar só o
código de status deixa passar exatamente o modo de falha caçado.

### Testes 2–4

- WebSocket: segurar `/api/ws` e `/api/events` por 10 min contínuos, contar quedas.
- `tailscale ping --c=30`, comparar com a baseline.
- Contadores: 3 janelas do monitor (45 min). Os contadores zeraram no restart,
  então só razões **de janela** são comparáveis. Durante o canário, rodar o script
  à mão a cada 5 min — o monitor fica ~30 min sem sinal justamente depois do
  restart, por causa da detecção de baseline nova.

## GO/NO-GO

GO exige **os cinco**. Qualquer falha isolada = NO-GO, rollback imediato, sem
depurar no ar.

| # | Critério | Número |
|---|---|---|
| 1 | Caminho realmente direct | ≥ 16/20 pings `direct` **e** `Endpoints` não-vazio |
| 2 | Payload grande | 30/30 com HTTP 200 **e** `size_download == Content-Length` |
| 3 | Latência | p95 do teste grande **≤** p95 da baseline |
| 4 | WebSocket | **0** quedas em 10 min contínuos |
| 5 | Perda | razão ≤ 0,5% em 3 janelas consecutivas, cada uma com Δq ≥ 20.000 |

O critério 3 é explícito de propósito: se o direct não for mais rápido que o
relay, não há motivo para aceitar o risco. "Empatou" é NO-GO.

## Rollback

Pré-digitar antes de começar. Não se compõe comando sob pressão.

```
railway variable set TS_DEBUG_ALWAYS_USE_DERP=1 --service Iris --skip-deploys
railway variable list --kv --service Iris | grep TS_DEBUG
railway restart --service Iris
```

Confirmação de que voltou — os quatro:

```
railway variable list --kv --service Iris | grep TS_DEBUG_ALWAYS_USE_DERP   # = 1
tailscale ping --c=10 <no> | grep -c "via DERP"                             # = 10
for i in $(seq 10); do curl -s -o /dev/null -w '%{http_code}\n' https://<no>/; done
curl -su "$ADMIN" <admin-url>/setup/api/status | jq .gateway                # running
```

Orçar 5 min até "confirmado restaurado".

## Janela

**Máximo 45 min** do primeiro restart até a decisão. Parada dura: se não for GO em
T+45, rollback independente de quão promissor pareça. Canário sem prazo vira debug
em produção.

## Sobre o `TS_DEBUG_MTU=1024`

Permanece **hipótese de canário**, não estado final. Ele não é rede de proteção
grátis: reduz throughput e adiciona overhead de fragmentação em todo caminho,
inclusive DERP. Se o canário "der certo" e o MTU 1024 ficar permanente por
inércia, trocou-se um contorno por outro e o ganho líquido pode ser negativo.

Decisão sobre mantê-lo ou não: tomada **antes** do canário, com antecedência, não
no calor do resultado.

## Precedente

`tailscale/tailscale#9894` — black-hole de payload em userspace networking, com
workaround de MTU 1024. Justifica o canário; **não prova sozinho** que a Railway
tem exatamente a mesma causa.
