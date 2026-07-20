# Runbook — canário de remoção do DERP forçado (Hetzner)

Estado: **não executado.** Escrito para o runtime **Hetzner** (`herdr-runner-1`),
não para a Railway. Os comandos abaixo são systemd; não há nenhum comando Railway
neste runbook, por decisão explícita.

## Por que não na Railway

`TS_DEBUG_ALWAYS_USE_DERP=1` foi aplicado em 2026-06-16 para contornar um
black-hole de MTU no caminho DIRECT: o handshake TLS (cert ~4,8 KB) era dropado com
DF set e sem ICMP de volta. Sintoma: HTTPS via MagicDNS oscilava 16/16
TIMEOUT/ECONNRESET na janela direct contra 8/8 HTTP 200 na janela DERP, enquanto
`tailscale ping` sempre passava — pacotes pequenos passavam, grandes não.

Esse black-hole é propriedade da rede da Railway (userspace networking, NAT de
egress). Testar lá gasta o orçamento de mudança arriscada num sistema que será
desligado, a resposta não vale no destino, e um restart interage com o HOLD do
Gate D. No Hetzner a rede é real e o `tailscaled` roda com TUN de kernel, então há
chance concreta de a flag ser simplesmente desnecessária — que é a pergunta.

## O que a ausência de endpoints não prova

Na Railway o peer não anuncia nenhum `Endpoints` e `direct_ipv4`/`direct_ipv6`
ficam em 0 bytes. Isso **não** é evidência de que o caminho direto seja impossível:
`TS_DEBUG_ALWAYS_USE_DERP=1` desativa o UDP no magicsock e *produz* essa
observação. É circular. Só o Teste 0, com a flag desligada, mede o estado real.

## Pré-requisitos

1. **Tailscale operacional no `herdr-runner-1`**, com o serviço da Iris alcançável
   pela tailnet. Isso é trabalho de ingress pós-MVP e ainda não existe — o canário
   fica bloqueado até lá.
2. Monitor rodando há **≥ 7 dias** com `.jsonl` populado, para haver "antes".
   Lembrando que ele mede saturação **local** da fila; a decisão do canário se
   apoia nos testes fim-a-fim, não nele.
3. Acesso out-of-band testado **antes** de mexer: SSH direto ao host
   (`ssh herdr-runner-1`, chave `~/.ssh/hetzner-herdr`) funcionando de forma
   independente da tailnet. Se o canário derrubar a tailnet, é a mão remota.
   Testar depois de quebrar não conta.
4. **Confirmar se o DERP forçado existe de fato neste runtime.** O experimento é
   remover a flag; se ela não estiver aplicada aqui, não há o que remover e o
   canário não deve rodar (viraria outro experimento, sem a pergunta original):
   ```
   systemctl show tailscaled -p Environment
   sudo tr '\0' '\n' < /proc/$(pidof tailscaled)/environ | grep TS_DEBUG || echo "(nenhuma TS_DEBUG no processo)"
   sudo systemd-analyze cat-config systemd/system/tailscaled.service | grep -n TS_DEBUG
   ```
   As três leituras juntas cobrem unit, drop-ins e `EnvironmentFile`. Se nenhuma
   apontar `TS_DEBUG_ALWAYS_USE_DERP`, **parar aqui**.
5. Rollback pré-digitado num segundo terminal; `journalctl -fu tailscaled` num
   terceiro.
6. Janela em dia útil, não sexta. John presente do começo ao fim.

## Baseline, ainda com DERP forçado

**30 amostras, não 8** — 30 dá p50/p95 utilizável; 8 dá anedota. Salvar em arquivo
com timestamp. Rodar do Mac.

```
# 1. asset grande (>100 KB) servido pelo dashboard
curl -sk https://<no>.<tailnet>.ts.net/ | grep -oE '/[a-zA-Z0-9._/-]+\.(js|css)' | head

# 2. payload grande, 30 amostras, handshake novo a cada uma
for i in $(seq 30); do
  curl -s -o /dev/null -w '%{http_code} %{size_download} %{time_total}\n' \
    https://<no>.<tailnet>.ts.net/<asset>
done

# 3. ping — --until-direct=false e OBRIGATORIO (ver nota abaixo)
tailscale ping --until-direct=false --c=30 <no>

# 4. caminho atual
tailscale status --json | jq '.Peer[] | select(.HostName=="<no>") | {CurAddr, Relay, Endpoints}'

# 5. condicoes locais
tailscale netcheck
```

> **`tailscale ping` para no primeiro pong direct por padrão.** `--until-direct`
> tem default **true** ("stop once a direct path is established"), então
> `--c=20 | grep -c direct` devolveria no máximo 1 e qualquer gate do tipo "16 de
> 20 direct" seria impossível de satisfazer. Usar `--until-direct=false` em todas
> as medições.

## Execução

No host, via drop-in do systemd — o `tailscaled` do Hetzner é serviço, não
container, então **reinicia-se só o daemon de rede**, sem derrubar a aplicação:

O drop-in faz **uma coisa só**: neutralizar o DERP forçado. Nada de MTU — ver a
seção final.

```
sudo mkdir -p /etc/systemd/system/tailscaled.service.d
sudo tee /etc/systemd/system/tailscaled.service.d/90-canary.conf >/dev/null <<'EOF'
[Service]
# 90- para ordenar DEPOIS de qualquer drop-in existente: para a mesma variavel,
# a ultima atribuicao vence. Setar =0 (e nao apenas omitir) e o que neutraliza a
# flag quando ela vem da unit, de outro drop-in ou de um EnvironmentFile --
# omitir so garantiria que ESTE arquivo nao a define.
Environment=TS_DEBUG_ALWAYS_USE_DERP=0
EOF

sudo systemctl daemon-reload
sudo systemctl restart tailscaled
```

**Confirmar que a neutralização pegou, antes de qualquer teste:**

```
systemctl show tailscaled -p Environment | tr ' ' '\n' | grep TS_DEBUG
sudo tr '\0' '\n' < /proc/$(pidof tailscaled)/environ | grep TS_DEBUG
```

Ambos têm que mostrar `TS_DEBUG_ALWAYS_USE_DERP=0` e nenhuma outra fonte
sobrescrevendo. Se o processo ainda subir com `=1`, o drop-in perdeu para outra
fonte e **o canário não começou** — investigar antes de medir qualquer coisa,
porque todos os testes seguintes passariam medindo o relay de novo.

Downtime: só a sessão da tailnet, enquanto o `tailscaled` reinicia (segundos). A
aplicação e o dashboard não são reiniciados.

## Validação

### Teste 0 — bloqueante: o caminho é direct de fato?

Vem antes de todos.

```
# aquece: 60 s de trafego para o direct ter chance de subir
for i in $(seq 30); do curl -sk -o /dev/null https://<no>.<tailnet>.ts.net/; sleep 2; done

tailscale status --json | jq '.Peer[] | select(.HostName=="<no>") | {CurAddr, Relay, Endpoints}'
tailscale ping --until-direct=false --c=20 <no> | grep -c 'direct'
```

Se `Endpoints` continuar vazio e os pings continuarem via DERP, **o teste não
aconteceu**: o tailscaled caiu de volta no relay sozinho, todos os testes seguintes
passariam, e a conclusão "direct funciona" seria falsa. Abortar.

### Teste 1 — payload grande (decisivo)

O bug original era MTU no handshake TLS, direção **servidor → Mac**. O teste força
**resposta** grande, não requisição grande.

```
for i in $(seq 30); do
  curl -s -o /tmp/canary.bin \
    -w '%{http_code} %{size_download} %{time_total}\n' \
    https://<no>.<tailnet>.ts.net/<asset-grande>
done
```

Validar `size_download` **byte-exato** contra `Content-Length`, não só o status.
Corpo truncado com HTTP 200 é a assinatura do black-hole de MTU — checar só o
código de status deixa passar exatamente o modo de falha caçado.

### Teste 2 — WebSocket

`/api/ws` e `/api/events` segurados por 10 min contínuos, contando quedas e
reconexões.

### Teste 3 — ping

`tailscale ping --until-direct=false --c=30 <no>`, comparado com a baseline.

## GO/NO-GO

GO exige **os quatro**. Qualquer falha isolada = NO-GO, rollback imediato, sem
depurar no ar.

| # | Critério | Número |
|---|---|---|
| 1 | Caminho realmente direct | `Endpoints` não-vazio **e** ≥ 16/20 pings `direct` com `--until-direct=false` |
| 2 | Payload grande | 30/30 com HTTP 200 **e** `size_download == Content-Length` |
| 3 | Latência | p95 do teste grande **≤** p95 da baseline |
| 4 | WebSocket | **0** quedas em 10 min contínuos |

**Os contadores DERP não entram no GO/NO-GO.** Uma vez em direct não há tráfego
DERP, então `send_derp_dropped` para de crescer por ausência de tráfego, não por
qualidade — e mesmo com relay eles medem saturação da fila **local**, não perda
fim-a-fim. Usar isso como critério leria "melhorou" em qualquer cenário. A medição
de perda que decide é a do Teste 1 (byte-exato) e a do Teste 2 (WebSocket).

O critério 3 é explícito de propósito: se o direct não for mais rápido que o relay,
não há motivo para aceitar o risco. "Empatou" é NO-GO.

## Rollback

Pré-digitar antes de começar. Não se compõe comando sob pressão.

```
sudo rm -f /etc/systemd/system/tailscaled.service.d/90-canary.conf
sudo systemctl daemon-reload
sudo systemctl restart tailscaled
```

Remover o drop-in restaura o estado de partida, que incluía o DERP forçado — é
por isso que o canário **neutraliza por `=0` em vez de apagar a fonte original**:
a volta é apagar um arquivo, não reconstruir configuração.

Confirmação de que voltou:

```
systemctl show tailscaled -p Environment
tailscale status --json | jq '.Peer[] | select(.HostName=="<no>") | {CurAddr, Relay}'
for i in $(seq 10); do curl -s -o /dev/null -w '%{http_code}\n' https://<no>.<tailnet>.ts.net/; done
```

Orçar 5 min até "confirmado restaurado".

## Janela

**Máximo 45 min** do primeiro restart do `tailscaled` até a decisão. Parada dura:
se não for GO em T+45, rollback independente de quão promissor pareça. Canário sem
prazo vira debug em produção.

## Sobre o `TS_DEBUG_MTU=1024` — opção REJEITADA

Não entra neste procedimento, nem como rede de proteção temporária. Registrado
aqui para que não seja reintroduzido por alguém que leia só o issue upstream.

Duas razões:

1. **Confunde o experimento.** A pergunta é "o caminho direto funciona sem o
   relay forçado?". Aplicar MTU 1024 junto testa "o caminho direto funciona com
   pacotes pequenos", que é outra pergunta — e cujo GO não autorizaria remover o
   DERP forçado sem o MTU, que é o estado que se quer alcançar.
2. **Não é grátis.** Reduz throughput e adiciona overhead de fragmentação em todo
   caminho, inclusive DERP. Um "deu certo" com MTU 1024 permanente troca um
   contorno por outro, possivelmente com ganho líquido negativo.

Se o canário der NO-GO por payload grande truncado, aí sim MTU vira hipótese —
como **experimento seguinte e separado**, com seu próprio GO/NO-GO, e nunca
misturado a este.

## Precedente

`tailscale/tailscale#9894` — black-hole de payload em userspace networking, com
workaround de MTU 1024. Justifica o canário; **não prova sozinho** que a Railway
(nem o Hetzner) tenha exatamente a mesma causa.
