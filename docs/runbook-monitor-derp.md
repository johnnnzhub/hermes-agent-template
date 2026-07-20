# Runbook — ativação do monitor de saturação da fila DERP

Estado: **não ativado.** O `scripts/derp-loss.py` é versionado e vai na imagem
(`/app/scripts/`), mas não está em `HERMES_HOME/scripts/` nem registrado no cron.
Este runbook é o gate de ativação, separado do PR.

## O que isto mede, e o que não mede

`magicsock_send_derp_dropped` / `_queued` / `_error_queue` contam **eviction e
saturação da fila de escrita DERP deste nó**. Isso não é perda fim-a-fim: pacote
descartado aqui nunca entrou na rede, e pacote perdido no meio do caminho não
aparece aqui. Tratar a razão como "perda do link" superestima em repouso e
subestima quando o problema é do outro lado.

Para perda fim-a-fim, o instrumento é outro: payload byte-exato e WebSocket, em
`docs/runbook-canary-derp-mtu.md`.

## Pré-requisitos

1. **Rodar dentro do container.** Existe `hermes` também no Mac (`~/.hermes/`);
   registrado ali, o job monitora o `tailscaled` do Mac, grava estado no Mac, e
   você fica com um monitor verde que não olha para nada.
   Confirmar: `echo "$HERMES_HOME"` → `/data/.hermes`.
2. Confirmar os contadores no binário do container:
   ```
   tailscale --socket=/var/run/tailscale/tailscaled.sock debug metrics \
     | grep -E 'magicsock_send_derp_(queued|dropped|error_queue)'
   ```
   **Não** usar `tailscale metrics print`: ele não expõe esses contadores, e o que
   ele expõe (`tailscaled_outbound_dropped_packets_total`) mede drop de tstun por
   protocolo/multicast — um monitor lendo dali nunca dispara.
3. Estado em volume persistente (default `$HERMES_HOME/state/`). `/tmp` some no
   restart e inutilizaria o histórico.

## Fase 0 — observe-only, 7 dias (obrigatória)

Ativar o modo pelo **arquivo marcador**, não por env var: o marcador não depende
do ambiente do serviço nem de restart, e fica visível no volume.

```
mkdir -p "$HERMES_HOME/scripts" "$HERMES_HOME/state"
cp /app/scripts/derp-loss.py "$HERMES_HOME/scripts/derp-loss.py"
touch "$HERMES_HOME/state/derp-loss.observe-only"
```

Antes de criar o job, **verificar se já existe** — `create` não é idempotente e
registrá-lo duas vezes deixa dois jobs concorrentes:

```
hermes cron list | grep -i derp-loss
```

Se não existir:

```
hermes cron create "*/15 * * * *" --name derp-loss-monitor --no-agent \
  --script derp-loss.py --deliver "<plataforma>:<chat_id do grupo Briefing>"
```

Se já existir, **editar pelo id**, nunca recriar:

```
hermes cron edit <job_id> --schedule "*/15 * * * *" --deliver "<plataforma>:<chat_id>"
```

O scheduler escolhe o interpretador pela **extensão** (`.sh`/`.bash` → bash, resto
→ Python), ignorando o shebang. Manter o `.py`.

### Sobre o `--deliver` — a ativação está BLOQUEADA até isto ser resolvido

`--deliver` aceita `origin`, `local`, `telegram`, `discord`, `signal` ou
`platform:chat_id`. A entrega tem que ser **apenas o grupo Briefing**, pelo
gateway já configurado — nenhum token novo entra no repo.

**O destino Briefing não existe hoje no diretório de canais vivo.** Enquanto não
existir, sair do observe-only é proibido, e o próprio script recusa:

```
derp-loss: fora do observe-only sem destino de alerta resolvido
(DERP_ALERT_DEST ou <state>/derp-loss.dest) -- nao alerta
```

Isso é falha fechada deliberada, com exit code 5. Um alerta que não sabe para onde
vai é pior que nenhum: cria a impressão de cobertura. Não há placeholder no repo e
não deve haver — o valor entra na ativação, depois de resolvido contra o
diretório vivo, em `<state>/derp-loss.dest` ou na env `DERP_ALERT_DEST`.

Durante a fase 0 o job é silencioso por construção e não exige destino.

### Fim da fase 0

Depois de 7 dias, calcular o p95 da razão de janela sobre o `.jsonl` e fixar:

```
DERP_ACUTE_RATIO = max(0.03, 2 × p95(ratio))
```

Os 3% do default são chute informado até existir essa distribuição. Os descartes
vêm em rajada, então uma janela de 15 min que contenha um episódio normal marca
1–4% legitimamente; sem dado real o limiar seria ajustado por incômodo.

## Ativação dos alertas

```
rm "$HERMES_HOME/state/derp-loss.observe-only"
```

Sair do observe-only muda o **fingerprint de configuração**, e o monitor zera
sozinho o estado de alerta acumulado na primeira execução seguinte (silenciosa,
registrada como `config-mudou` no histórico). Isso é intencional: contadores de
janela acumulados sob outra configuração não valem para a nova.

Trocar qualquer limiar tem o mesmo efeito.

## Critério implementado

| Guarda | Comportamento |
|---|---|
| Primeira execução | grava baseline, silencioso |
| Restart do `tailscaled` (`pid:starttime`) ou contador que diminuiu | **nova baseline**, silencioso |
| Gap de coleta maior que 3× a janela | **nova baseline** (`gap-de-coleta`) — delta acumulado num intervalo muito maior que a janela não é uma taxa de janela |
| Execução dentro do piso de janela (< 1/3 da janela desde a anterior) | sai sem gravar — evita janelas espúrias de delta zero que diluiriam a razão e inflariam a cobertura |
| Mudança de configuração | reset silencioso (`config-mudou`) |
| Estado ilegível | **falha fechada**: não sobrescreve, sai com código ≠ 0 e explica no stderr |
| Outra execução em curso | sai silenciosa (lock exclusivo sobre o ciclo inteiro) |

| Braço | Condição |
|---|---|
| Agudo | `Δqueued ≥ 20.000` **e** `Δdropped ≥ 500` **e** razão ≥ 3%, em **duas janelas consecutivas**. Histerese: rearma só após uma janela **com tráfego** e razão < 1,5% — janela ociosa não rearma |
| Crônico | razão de 24 h ≥ 2× a dos 7 dias anteriores, com cobertura temporal mínima em cada balde. **Latch + cooldown de 24 h**: não repete a cada execução enquanto a condição persistir. Baseline histórica com zero descartes é tratada à parte (comparação por fator seria divisão por zero) |

Todos os limiares são env vars (`DERP_ACUTE_RATIO`, `DERP_MIN_QUEUED`,
`DERP_MIN_DROPPED`, `DERP_REARM_RATIO`, `DERP_WINDOW_SECONDS`,
`DERP_MIN_SPAN_SECONDS`, `DERP_MAX_SPAN_FACTOR`, `DERP_CHRONIC_*`).

## Verificação pós-ativação

1. `hermes cron list` mostra **um** job `derp-loss-monitor` (não dois).
2. Run manual silencioso:
   ```
   python3 "$HERMES_HOME/scripts/derp-loss.py"; echo "exit=$?"
   ```
   → sem saída, `exit=0`.
3. Após ~30 min, `derp-loss.jsonl` tem 2 linhas com `dq`/`dd` plausíveis.
4. **Testar a ENTREGA de verdade — atravessando o scheduler.** Rodar
   `python3 derp-loss.py` à mão prova apenas a stdout local: não passa pelo
   scheduler, não exercita o `--deliver` e não diz nada sobre o destino estar
   certo. O teste tem que ser um job real, temporário e controlado:

   ```
   # a) script trivial que so imprime um token conhecido
   cat > "$HERMES_HOME/scripts/derp-deliver-probe.sh" <<'EOF'
   #!/bin/bash
   echo "probe de entrega derp-loss: $(date -u +%FT%TZ)"
   EOF
   chmod +x "$HERMES_HOME/scripts/derp-deliver-probe.sh"

   # b) job no-agent com o MESMO destino do monitor
   hermes cron create "0 5 31 2 *" --name derp-deliver-probe --no-agent \
     --script derp-deliver-probe.sh --deliver "<destino resolvido>"
   #    (a expressao 31/02 nunca ocorre: o job so roda quando forcado abaixo)

   # c) forcar a execucao no proximo tick e conferir
   hermes cron list                      # pegar o job_id
   hermes cron run <job_id>
   hermes cron runs <job_id>             # confirmar sucesso da tentativa
   ```

   Confirmar que a mensagem chegou **ao Briefing e a nenhum outro canal**, e só
   então:

   ```
   hermes cron remove <job_id>
   rm -f "$HERMES_HOME/scripts/derp-deliver-probe.sh"
   ```

   O probe usa script próprio, e não o `derp-loss.py`, justamente para não
   escrever em `<state>` nem contaminar a baseline.

## Rollback

```
hermes cron list                 # pegar o job_id
hermes cron remove <job_id>      # remove exige o ID, nao o nome amigavel
```

O script e o estado ficam inertes sem o job. Remover
`$HERMES_HOME/scripts/derp-loss.py` é opcional.

## Testes

`python3 tests/test_derp_loss.py` — 56 asserts em 21 cenários, com fixtures
sintéticas. Cobre latch do crônico, exclusão mútua, falha fechada em estado
corrompido, janela ociosa que não rearma, gap de coleta e reset por configuração.
Não toca rede, socket do tailscaled nem produção.
