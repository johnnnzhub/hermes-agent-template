# Runbook — ativação do monitor de perda DERP

Estado: **não ativado.** O `scripts/derp-loss.py` é versionado no repo mas não está
instalado em `HERMES_HOME/scripts/` nem registrado no cron. Este runbook é o gate
de ativação, separado do PR.

## Por que existe

Os contadores do relay DERP mostravam ~1,06% de descarte acumulado (385.193 de
36.506.064) com 209 episódios de saturação de fila. Mas a razão acumulada desde o
boot não diz se a coisa está piorando — ela é ~1% por construção e pareceria
alarmante para sempre. O que interessa é crescimento, e é isso que o monitor mede.

## Pré-requisitos

1. Rodar **dentro do container**. Existe `hermes` também no Mac (`~/.hermes/`);
   registrado ali, o job monitora o `tailscaled` do Mac, grava estado no Mac, e
   você fica com um monitor verde que não olha para nada.
   Confirmar: `hermes cron list` e `HERMES_HOME` apontando para `/data/.hermes`.
2. Confirmar o subcomando de métricas no binário do container:
   `tailscale --socket=/var/run/tailscale/tailscaled.sock debug metrics | grep magicsock_send_derp`
   Deve devolver `magicsock_send_derp_queued` e `magicsock_send_derp_dropped`.
   **Não** usar `tailscale metrics print`: ele não expõe esses contadores, e o que
   ele expõe (`tailscaled_outbound_dropped_packets_total`) mede drop de tstun por
   protocolo/multicast — um monitor lendo dali nunca dispara.
3. Estado em volume persistente. O default é `$HERMES_HOME/state/`; `/tmp` some no
   restart e inutilizaria o histórico.

## Fase 0 — observe-only, 7 dias (obrigatória)

`DERP_OBSERVE_ONLY=1` é o **default do script**. Nessa fase ele acumula
`derp-loss.jsonl` e nunca imprime nada.

Isso não é cerimônia: o limiar agudo de 3% é chute informado. Os drops vêm em
rajada (~1.843 por episódio, ~6 episódios/dia), então uma janela de 15 min que
contenha um episódio normal marca 1–4% legitimamente. Sem uma distribuição real,
o número seria ajustado por incômodo nas duas primeiras semanas.

Instalar e agendar em observe-only:

```
cp scripts/derp-loss.py $HERMES_HOME/scripts/derp-loss.py
hermes cron create "*/15 * * * *" --name derp-loss-monitor --no-agent \
  --script derp-loss.py
```

O scheduler escolhe o interpretador pela **extensão** (`.sh`/`.bash` → bash, resto
→ Python), ignorando o shebang. Manter o `.py`.

Depois de 7 dias, calcular o p95 da razão de janela sobre o `.jsonl` e fixar:

```
DERP_ACUTE_RATIO = max(0.03, 2 × p95(ratio))
```

## Ativação dos alertas

Só depois da fase 0. Setar `DERP_OBSERVE_ONLY=0` e re-registrar o job com entrega.

Entrega: **apenas o grupo Briefing, pelo gateway Hermes já existente.** Nenhum
token cru novo entra no repositório — usar o canal já configurado no serviço.
Confirmar o identificador do canal no container antes de registrar; não assumir.

O cron `--no-agent --script` trata **stdout vazio como run silencioso**, então o
script só produz entrega quando há problema. Zero ruído por construção. Exit code
diferente de zero é entregue como erro pelo próprio scheduler.

## Critério implementado

| Guarda | Comportamento |
|---|---|
| Primeira execução | grava baseline, silencioso |
| Restart do `tailscaled` (`pid:starttime`) ou contador que diminuiu | **nova baseline**, silencioso — contador zerado nunca vira alerta |

| Braço | Condição |
|---|---|
| Agudo | `Δqueued ≥ 20.000` **e** `Δdropped ≥ 500` **e** razão ≥ 3%, em **duas janelas consecutivas**. Histerese: rearma só após uma janela < 1,5% |
| Crônico | razão de 24 h ≥ 2 × razão dos 7 dias anteriores, com razão de 24 h ≥ 0,5% e volume ≥ 2.000.000 |

A exigência de duas janelas é o núcleo: rajada é transiente, degradação é
persistente, e só a persistência distingue as duas.

Todos os limiares são env vars (`DERP_ACUTE_RATIO`, `DERP_MIN_QUEUED`,
`DERP_MIN_DROPPED`, `DERP_REARM_RATIO`, `DERP_CHRONIC_*`) — ajuste sem mudança de
código.

## Verificação pós-ativação

1. `hermes cron list` mostra o job e o `HERMES_HOME` correto.
2. Após ~30 min, `derp-loss.jsonl` tem 2 linhas com `dq`/`dd` plausíveis.
3. Run manual com stdout vazio: `python3 $HERMES_HOME/scripts/derp-loss.py; echo "exit=$?"`
   → sem saída, `exit=0`.
4. Testar o caminho de alerta sem esperar degradação: rodar com
   `DERP_ACUTE_RATIO=0` e `DERP_MIN_QUEUED=0` num `DERP_STATE_DIR` **temporário**
   por duas execuções e confirmar que a mensagem chega ao Briefing. Nunca apontar
   o teste para o state dir real — contaminaria a baseline.

## Rollback

`hermes cron delete derp-loss-monitor` no container. O script e o estado são
inertes sem o job. Remover `$HERMES_HOME/scripts/derp-loss.py` é opcional.

## Testes

`python3 tests/test_derp_loss.py` — 28 asserts em 13 cenários, com fixtures
sintéticas. Não toca rede, socket do tailscaled nem produção.
