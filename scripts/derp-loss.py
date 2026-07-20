#!/usr/bin/env python3
"""derp-loss.py — monitor de saturação da fila DERP local do Tailscale.

NÃO ESTÁ ATIVO. Versionado no repo, mas não instalado em HERMES_HOME/scripts/ nem
registrado no cron. Ativação é gate separado — ver docs/runbook-monitor-derp.md.

O QUE ISTO MEDE, E O QUE NÃO MEDE
`magicsock_send_derp_dropped` / `_queued` / `_error_queue` contam eviction e
saturação da fila de escrita DERP **deste nó**. Isso NÃO é perda fim-a-fim do
caminho: pacote descartado aqui nunca entrou na rede, e pacote perdido no meio do
caminho não aparece aqui. Tratar a razão como "perda do link" superestima em
repouso e subestima quando o problema é do outro lado. Para perda fim-a-fim, medir
payload byte-exato e WebSocket — ver docs/runbook-canary-derp-mtu.md.

CONTADORES
`tailscale debug metrics` (fallback: localapi no socket unix). Cuidado:
`tailscale metrics print` NÃO expõe esses contadores; o que ele expõe
(`tailscaled_outbound_dropped_packets_total{reason=...}`) mede drop de tstun por
protocolo/multicast — um monitor lendo dali nunca dispara. Verificado na 1.98.9.

CRITÉRIO
Nunca alerta sobre a razão ACUMULADA desde o boot: ela é ~1% por construção e
pareceria alarmante para sempre. Só delta importa.

  Guardas   restart do tailscaled (pid:starttime), contador que diminuiu, gap de
            coleta maior que MAX_SPAN, ou mudança de configuração
            => regrava como NOVA BASELINE e sai silencioso.
            Estado corrompido => FALHA FECHADA: não sobrescreve, sai != 0.

  Agudo     Δqueued >= MIN_QUEUED e Δdropped >= MIN_DROPPED e razão da janela
            >= ACUTE_RATIO, em DUAS janelas consecutivas. As duas janelas são o
            núcleo: os descartes vêm em rajada e uma rajada de PTY sozinha
            atravessa o limiar. Rajada é transiente, degradação é persistente.
            Histerese: rearma só após uma janela COM TRÁFEGO abaixo de REARM_RATIO
            (janela ociosa não rearma — dq=0 daria razão 0 e limparia o latch).

  Crônico   razão agregada de 24 h contra a dos 7 dias anteriores, com cobertura
            temporal mínima em cada balde. Latch + cooldown: não repete a cada
            execução enquanto a condição persistir.

FASE 0 (padrão)
Observe-only é o DEFAULT: acumula histórico e nunca alerta. Ativa por env
DERP_OBSERVE_ONLY=1 ou pela presença do arquivo marcador
`<state>/derp-loss.observe-only` — o marcador é preferível porque não depende de
env do serviço nem de restart. Os limiares abaixo são chute informado até existir
distribuição real; só então fixar ACUTE_RATIO em max(3%, 2 x p95(razão)).

SAÍDA
Imprime em stdout SÓ quando alerta. O cron do hermes (--no-agent --script) trata
stdout vazio como run silencioso.
"""
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 2
QUEUED = "magicsock_send_derp_queued"
DROPPED = "magicsock_send_derp_dropped"
ERRQ = "magicsock_send_derp_error_queue"

TS_SOCKET = os.environ.get("TS_SOCKET", "/var/run/tailscale/tailscaled.sock")
STATE_DIR = Path(os.environ.get(
    "DERP_STATE_DIR",
    str(Path(os.environ.get("HERMES_HOME", "/data/.hermes")) / "state"),
))
STATE = STATE_DIR / "derp-loss.json"
HISTORY = STATE_DIR / "derp-loss.jsonl"
LOCK = STATE_DIR / "derp-loss.lock"
OBSERVE_MARKER = STATE_DIR / "derp-loss.observe-only"

WINDOW = int(os.environ.get("DERP_WINDOW_SECONDS", "900"))
MAX_SPAN = WINDOW * int(os.environ.get("DERP_MAX_SPAN_FACTOR", "3"))
# Amostra tirada logo apos a anterior NAO e uma janela. Sem este piso, uma
# execucao manual (ou duas do cron se sobrepondo) acrescenta janelas de delta
# zero que diluem a razao e inflam a contagem de cobertura do braco cronico.
MIN_SPAN = int(os.environ.get("DERP_MIN_SPAN_SECONDS", str(WINDOW // 3)))
ACUTE_RATIO = float(os.environ.get("DERP_ACUTE_RATIO", "0.03"))
REARM_RATIO = float(os.environ.get("DERP_REARM_RATIO", "0.015"))
MIN_QUEUED = int(os.environ.get("DERP_MIN_QUEUED", "20000"))
MIN_DROPPED = int(os.environ.get("DERP_MIN_DROPPED", "500"))
CHRONIC_FACTOR = float(os.environ.get("DERP_CHRONIC_FACTOR", "2.0"))
CHRONIC_MIN_RATIO = float(os.environ.get("DERP_CHRONIC_MIN_RATIO", "0.005"))
CHRONIC_MIN_QUEUED = int(os.environ.get("DERP_CHRONIC_MIN_QUEUED", "2000000"))
CHRONIC_MIN_WINDOWS_RECENT = int(os.environ.get("DERP_CHRONIC_MIN_WINDOWS_RECENT", "48"))
CHRONIC_MIN_WINDOWS_PRIOR = int(os.environ.get("DERP_CHRONIC_MIN_WINDOWS_PRIOR", "96"))
CHRONIC_COVERAGE = float(os.environ.get("DERP_CHRONIC_COVERAGE", "0.5"))
CHRONIC_COOLDOWN = int(os.environ.get("DERP_CHRONIC_COOLDOWN", "86400"))
HISTORY_MAX = int(os.environ.get("DERP_HISTORY_MAX", "5000"))
# `dropped` conta eviction de pacote ANTIGO da fila; `error_queue` conta o pacote
# ATUAL descartado apos as tentativas. Os dois sao descarte real, entao os dois
# entram na decisao -- contar so o primeiro deixa passar o caso em que a fila
# rejeita tudo que chega (dropped nao cresce, error_queue sim).
COUNT_ERRQ = os.environ.get("DERP_COUNT_ERRQ", "1") == "1"
DEST_FILE = STATE_DIR / "derp-loss.dest"

DAY = 86400


class StateCorrupt(Exception):
    """Estado ilegível. Falha fechada: nunca sobrescrever uma baseline suspeita."""


def observe_only():
    if OBSERVE_MARKER.exists():
        return True
    return os.environ.get("DERP_OBSERVE_ONLY", "1") == "1"


def alert_destination():
    """Destino explícito dos alertas, ou None.

    Fora do observe-only o monitor FALHA FECHADA sem destino resolvido: um alerta
    que não sabe para onde vai é pior que nenhum, porque cria a impressão de
    cobertura. Não há placeholder nem default -- o valor entra na ativação, depois
    de resolvido contra o diretório de canais vivo.
    """
    env = os.environ.get("DERP_ALERT_DEST", "").strip()
    if env:
        return env
    try:
        v = DEST_FILE.read_text().strip()
        return v or None
    except OSError:
        return None


def config_fingerprint():
    """Muda quando um limiar ou o modo muda. Estado de alerta acumulado sob uma
    configuração não vale para outra -- ao trocar, zera contadores e latches."""
    payload = json.dumps({
        "observe_only": observe_only(), "window": WINDOW, "max_span": MAX_SPAN,
        "min_span": MIN_SPAN,
        "acute": ACUTE_RATIO, "rearm": REARM_RATIO,
        "min_q": MIN_QUEUED, "min_d": MIN_DROPPED,
        "c_factor": CHRONIC_FACTOR, "c_ratio": CHRONIC_MIN_RATIO,
        "c_queued": CHRONIC_MIN_QUEUED, "c_wr": CHRONIC_MIN_WINDOWS_RECENT,
        "c_wp": CHRONIC_MIN_WINDOWS_PRIOR, "c_cov": CHRONIC_COVERAGE,
        "c_cool": CHRONIC_COOLDOWN, "count_errq": COUNT_ERRQ,
    }, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def read_metrics_text():
    fixture = os.environ.get("DERP_METRICS_FILE")
    if fixture:
        try:
            return Path(fixture).read_text()
        except OSError:
            return None
    for cmd in (
        ["tailscale", "--socket=" + TS_SOCKET, "debug", "metrics"],
        ["curl", "-sf", "--unix-socket", TS_SOCKET,
         "-H", "Host: local-tailscaled.sock",
         "http://local-tailscaled.sock/localapi/v0/metrics"],
    ):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout
        except Exception:  # noqa: BLE001
            continue
    return None


def parse_metrics(text):
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[0] in (QUEUED, DROPPED, ERRQ):
            try:
                out[parts[0]] = int(parts[1])
            except ValueError:
                pass
    return out


def daemon_id():
    """pid:starttime do tailscaled. Sem /proc devolve None e a detecção de restart
    fica só por contador que diminuiu -- cobre o caso com menos precisão."""
    override = os.environ.get("DERP_DAEMON_ID")
    if override is not None:
        return override or None
    try:
        for p in Path("/proc").iterdir():
            if not p.name.isdigit():
                continue
            try:
                if (p / "comm").read_text().strip() != "tailscaled":
                    continue
                # o campo 2 (comm) vem entre parênteses e pode conter espaços
                # -> cortar no ÚLTIMO ")" antes de dividir
                rest = (p / "stat").read_text().rsplit(")", 1)[1].split()
                return f"{p.name}:{rest[19]}"   # campo 22 = starttime
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        return None
    return None


def load_state():
    if not STATE.exists():
        return None
    try:
        raw = STATE.read_text()
    except OSError as e:
        raise StateCorrupt(f"nao consegui ler {STATE}: {e}")
    if not raw.strip():
        raise StateCorrupt(f"estado vazio em {STATE}")
    try:
        data = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        raise StateCorrupt(f"json invalido em {STATE}: {e}")
    if not isinstance(data, dict) or "queued" not in data or "dropped" not in data:
        raise StateCorrupt(f"estado sem campos obrigatorios em {STATE}")
    return data


def write_atomic(path, text):
    """Tempfile EXCLUSIVO no mesmo diretório + rename. Nome fixo .tmp faria duas
    execuções concorrentes disputarem o mesmo arquivo; /tmp faria o rename cruzar
    filesystem (EXDEV) e deixar de ser atômico."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def save_state(state):
    write_atomic(STATE, json.dumps(state, indent=2) + "\n")


def append_history(entry):
    HISTORY.parent.mkdir(parents=True, exist_ok=True)
    with HISTORY.open("a") as fh:
        fh.write(json.dumps(entry) + "\n")
    try:
        lines = HISTORY.read_text().splitlines()
        if len(lines) > HISTORY_MAX:
            write_atomic(HISTORY, "\n".join(lines[-HISTORY_MAX:]) + "\n")
    except Exception:  # noqa: BLE001
        pass


def load_history():
    out = []
    try:
        for line in HISTORY.read_text().splitlines():
            try:
                e = json.loads(line)
                if "epoch" in e and "dq" in e and "dd" in e:
                    out.append(e)
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        pass
    return out


def ratio(dd, dq):
    return (dd / dq) if dq > 0 else 0.0


def baseline(now, iso, m, did, fp, reason):
    return {
        "schema": SCHEMA, "ts": iso, "epoch": now,
        "queued": m[QUEUED], "dropped": m[DROPPED], "errq": m.get(ERRQ, 0),
        "daemon_id": did, "config_fp": fp,
        "consecutive_breaches": 0, "alerting": False, "chronic_alert_epoch": None,
        "reset": reason,
    }


def drops(entry):
    """Descarte total de uma janela do histórico. `derrq` pode faltar em linhas
    antigas -- ausente conta como zero, nunca como erro."""
    d = int(entry.get("dd", 0))
    return d + int(entry.get("derrq", 0) or 0) if COUNT_ERRQ else d


def covered_seconds(entries, lo, hi):
    """União temporal REAL coberta pelas amostras dentro de [lo, hi].

    Contar amostras x tamanho-nominal-de-janela (`len(x) * WINDOW`) superestima:
    ignora o span real de cada amostra e conta duas vezes qualquer sobreposição.
    Com isso, um punhado de amostras densas passava por "12 horas de cobertura".
    Aqui cada amostra vale o intervalo que ela de fato mediu, recortado ao balde,
    e os intervalos são fundidos antes de somar.
    """
    iv = []
    for e in entries:
        end = int(e["epoch"])
        start = end - int(e.get("span") or WINDOW)
        start, end = max(start, lo), min(end, hi)
        if end > start:
            iv.append((start, end))
    iv.sort()
    total, cur_s, cur_e = 0, None, None
    for s, en in iv:
        if cur_e is None:
            cur_s, cur_e = s, en
        elif s <= cur_e:
            cur_e = max(cur_e, en)
        else:
            total += cur_e - cur_s
            cur_s, cur_e = s, en
    if cur_e is not None:
        total += cur_e - cur_s
    return total


def chronic_check(now):
    """24 h contra os 7 dias anteriores, com cobertura mínima em cada balde.

    Sem a checagem de cobertura, dois punhados de amostras esparsas (monitor fora
    do ar, deploy, janela recém-iniciada) bastariam para declarar tendência.
    """
    hist = [e for e in load_history() if not e.get("reset")]
    recent = [e for e in hist if e["epoch"] >= now - DAY]
    prior = [e for e in hist if now - 8 * DAY <= e["epoch"] < now - DAY]
    if len(recent) < CHRONIC_MIN_WINDOWS_RECENT or len(prior) < CHRONIC_MIN_WINDOWS_PRIOR:
        return None
    if covered_seconds(recent, now - DAY, now) < CHRONIC_COVERAGE * DAY:
        return None
    if covered_seconds(prior, now - 8 * DAY, now - DAY) < CHRONIC_COVERAGE * 7 * DAY:
        return None

    rq, rd = sum(e["dq"] for e in recent), sum(drops(e) for e in recent)
    pq, pd = sum(e["dq"] for e in prior), sum(drops(e) for e in prior)
    if rq < CHRONIC_MIN_QUEUED or pq <= 0:
        return None
    r_recent, r_prior = ratio(rd, rq), ratio(pd, pq)
    if r_recent < CHRONIC_MIN_RATIO:
        return None

    if r_prior <= 0:
        # Baseline histórica sem nenhum descarte. Qualquer degradação é uma
        # regressão infinita em razão -- comparar por fator daria divisão por zero
        # e o caso passaria despercebido, que é o oposto do desejado.
        return (
            f"DERP: descarte na fila local apareceu onde nao havia. 24h em "
            f"{r_recent * 100:.2f}% ({rd} de {rq}); os 7 dias anteriores tinham "
            f"zero descartes em {pq} enfileirados."
        )
    if r_recent < CHRONIC_FACTOR * r_prior:
        return None
    return (
        f"DERP: deriva cronica no descarte da fila local. 24h em "
        f"{r_recent * 100:.2f}% ({rd} de {rq}) contra {r_prior * 100:.2f}% nos 7 "
        f"dias anteriores ({pd} de {pq}) -- fator {r_recent / r_prior:.1f}x."
    )


def run():
    text = read_metrics_text()
    if text is None:
        # Falha de leitura não é descarte. Sair silencioso evita transformar
        # indisponibilidade do socket em alerta de rede; o exit != 0 sinaliza.
        print("derp-loss: nao consegui ler as metricas do tailscaled", file=sys.stderr)
        return 2
    m = parse_metrics(text)
    if QUEUED not in m or DROPPED not in m:
        print("derp-loss: contadores magicsock_send_derp_* ausentes", file=sys.stderr)
        return 3

    now = int(time.time())
    iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    did, fp = daemon_id(), config_fingerprint()

    try:
        prev = load_state()
    except StateCorrupt as e:
        # FALHA FECHADA: não sobrescreve. Regravar aqui apagaria silenciosamente a
        # baseline e o histórico de alerta, escondendo justamente o que deu errado.
        print(f"derp-loss: {e} -- estado NAO foi sobrescrito, intervencao manual",
              file=sys.stderr)
        return 4

    if prev is None:
        save_state(baseline(now, iso, m, did, fp, "primeira-execucao"))
        append_history({"ts": iso, "epoch": now, "dq": 0, "dd": 0, "derrq": 0,
                        "ratio": 0.0, "reset": "primeira-execucao"})
        return 0

    span = now - int(prev.get("epoch", now))
    reset_reason = None
    if prev.get("config_fp") != fp:
        reset_reason = "config-mudou"
    elif (did is not None and prev.get("daemon_id") is not None
          and did != prev["daemon_id"]):
        reset_reason = "restart-tailscaled"
    elif m[QUEUED] < prev.get("queued", 0) or m[DROPPED] < prev.get("dropped", 0):
        reset_reason = "restart-tailscaled"
    elif span > MAX_SPAN:
        # Delta acumulado num intervalo muito maior que a janela não é comparável
        # a uma janela; tratar como janela seria inventar uma taxa.
        reset_reason = "gap-de-coleta"

    if reset_reason:
        save_state(baseline(now, iso, m, did, fp, reset_reason))
        append_history({"ts": iso, "epoch": now, "dq": 0, "dd": 0, "derrq": 0,
                        "ratio": 0.0, "reset": reset_reason})
        return 0

    if span < MIN_SPAN:
        # Ainda dentro da janela anterior: nao ha janela nova para medir. Sair sem
        # gravar nada mantem o historico como uma serie de janelas reais, que e o
        # que o braco cronico agrega.
        return 0

    dq = m[QUEUED] - prev.get("queued", 0)
    dd = m[DROPPED] - prev.get("dropped", 0)
    derrq = m.get(ERRQ, 0) - prev.get("errq", 0)
    # descarte total: eviction de pacote antigo (dd) + pacote atual recusado pela
    # fila cheia (derrq). Contar so o primeiro deixaria passar exatamente o caso
    # em que a fila rejeita tudo que chega.
    dd_total = dd + derrq if COUNT_ERRQ else dd
    r = ratio(dd_total, dq)
    append_history({"ts": iso, "epoch": now, "dq": dq, "dd": dd, "derrq": derrq,
                    "ratio": round(r, 6), "span": span})

    consecutive = int(prev.get("consecutive_breaches", 0))
    alerting = bool(prev.get("alerting", False))
    chronic_epoch = prev.get("chronic_alert_epoch")

    breach = dq >= MIN_QUEUED and dd_total >= MIN_DROPPED and r >= ACUTE_RATIO
    consecutive = consecutive + 1 if breach else 0
    # Rearme exige VOLUME: janela ociosa tem dq=0 e razão 0, e limparia o latch
    # sem nenhuma evidência de que a situação melhorou.
    if alerting and dq >= MIN_QUEUED and r < REARM_RATIO:
        alerting = False

    alerts = []
    armed = not observe_only()
    if armed and alert_destination() is None:
        # FALHA FECHADA: fora do observe-only sem destino resolvido, nao alerta e
        # nao finge estar monitorando. Sai != 0 para o scheduler entregar o erro.
        save_state({
            "schema": SCHEMA, "ts": iso, "epoch": now,
            "queued": m[QUEUED], "dropped": m[DROPPED], "errq": m.get(ERRQ, 0),
            "daemon_id": did, "config_fp": fp,
            "consecutive_breaches": consecutive, "alerting": alerting,
            "chronic_alert_epoch": chronic_epoch,
        })
        print("derp-loss: fora do observe-only sem destino de alerta resolvido "
              "(DERP_ALERT_DEST ou <state>/derp-loss.dest) -- nao alerta",
              file=sys.stderr)
        return 5

    if armed:
        if consecutive >= 2 and not alerting:
            alerting = True
            extra = f", {derrq} recusados por fila cheia" if derrq > 0 else ""
            alerts.append(
                f"DERP: descarte sustentado na fila local. {consecutive} janelas "
                f"consecutivas com {r * 100:.2f}% ({dd_total} de {dq} enfileirados "
                f"na ultima{extra}). Mede saturacao local, nao perda fim-a-fim."
            )
        chronic = chronic_check(now)
        if chronic:
            due = chronic_epoch is None or (now - int(chronic_epoch)) >= CHRONIC_COOLDOWN
            if due:
                chronic_epoch = now
                alerts.append(chronic)
        else:
            chronic_epoch = None   # condição limpou -> rearma o braço crônico

    save_state({
        "schema": SCHEMA, "ts": iso, "epoch": now,
        "queued": m[QUEUED], "dropped": m[DROPPED], "errq": m.get(ERRQ, 0),
        "daemon_id": did, "config_fp": fp,
        "consecutive_breaches": consecutive, "alerting": alerting,
        "chronic_alert_epoch": chronic_epoch,
    })

    for a in alerts:
        print(a)
    return 0


def main():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    # Lock cobrindo o ciclo INTEIRO (ler -> calcular -> append -> gravar).
    # Sem ele, duas execuções sobrepostas duplicam delta e alerta, ou uma perde a
    # gravação da outra. Não-bloqueante: se já há execução em curso, esta sai
    # silenciosa -- é um monitor periódico, a próxima janela cobre.
    with LOCK.open("w") as lk:
        try:
            fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return 0
        try:
            return run()
        finally:
            fcntl.flock(lk, fcntl.LOCK_UN)


if __name__ == "__main__":
    sys.exit(main())
