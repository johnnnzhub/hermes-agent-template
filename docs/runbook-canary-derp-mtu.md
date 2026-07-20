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
4. Decidir **antes** o destino do `TS_DEBUG_MTU=1024` — ver seção final.
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

```
sudo mkdir -p /etc/systemd/system/tailscaled.service.d
sudo tee /etc/systemd/system/tailscaled.service.d/10-canary.conf >/dev/null <<'EOF'
[Service]
Environment=TS_DEBUG_MTU=1024
EOF

sudo systemctl daemon-reload
sudo systemctl restart tailscaled
```

Note que o drop-in **não** define `TS_DEBUG_ALWAYS_USE_DERP`: no Hetzner a flag
nunca foi aplicada. Se por algum motivo ela existir no ambiente do serviço,
removê-la aqui é o passo equivalente ao "desligar o forçamento".

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
sudo rm -f /etc/systemd/system/tailscaled.service.d/10-canary.conf
sudo systemctl daemon-reload
sudo systemctl restart tailscaled
```

Se o estado de partida incluía DERP forçado, repor a linha
`Environment=TS_DEBUG_ALWAYS_USE_DERP=1` no drop-in em vez de removê-lo.

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

## Sobre o `TS_DEBUG_MTU=1024`

Permanece **hipótese de canário**, não estado final. Não é rede de proteção
grátis: reduz throughput e adiciona overhead de fragmentação em todo caminho,
inclusive DERP. Se o canário "der certo" e o MTU 1024 ficar permanente por
inércia, trocou-se um contorno por outro e o ganho líquido pode ser negativo.

Decisão sobre mantê-lo: tomada **antes** do canário, não no calor do resultado.

## Precedente

`tailscale/tailscale#9894` — black-hole de payload em userspace networking, com
workaround de MTU 1024. Justifica o canário; **não prova sozinho** que a Railway
(nem o Hetzner) tenha exatamente a mesma causa.
