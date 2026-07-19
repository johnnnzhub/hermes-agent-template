#!/usr/bin/env python3
"""derp-loss.py — monitor de perda no relay DERP do Tailscale.

NAO ESTA ATIVO. Este arquivo e versionado no repo mas nao e instalado em
HERMES_HOME/scripts/ nem registrado no cron. A ativacao e um gate separado --
ver docs/runbook-monitor-derp.md.

CONTADORES
Le `tailscale debug metrics` (fallback: localapi no socket unix) e extrai
magicsock_send_derp_queued e magicsock_send_derp_dropped.

Cuidado: `tailscale metrics print` NAO expoe esses contadores. O que ele expoe --
tailscaled_outbound_dropped_packets_total{reason=...} -- parece o certo e nao e:
mede drop de tstun por protocolo/multicast, nao saturacao de fila DERP. Um monitor
lendo dali mede a coisa errada e nunca dispara. Verificado empiricamente na 1.98.9.

CRITERIO
Nunca alerta sobre a razao ACUMULADA desde o boot: ela e ~1% por construcao e
pareceria alarmante para sempre. So delta importa.

  Guardas   restart do tailscaled (pid:starttime) ou contador que diminuiu
            => regrava como NOVA BASELINE e sai silencioso. Idem 1a execucao.

  Agudo     Dq >= MIN_QUEUED e Dd >= MIN_DROPPED e razao da janela >= ACUTE_RATIO,
            em DUAS janelas consecutivas. As duas janelas sao o nucleo do criterio:
            os drops vem em rajada (~1.843 por episodio de saturacao, ~6/dia) e uma
            rajada de PTY sozinha atravessa o limiar. Rajada e transiente,
            degradacao e persistente -- so a persistencia distingue as duas.
            Histerese: so rearma apos uma janela abaixo de REARM_RATIO.

  Cronico   razao agregada de 24h vs. os 7 dias anteriores. Pega o link apodrecendo
            devagar sem nunca estourar o limiar agudo numa janela isolada.

FASE 0 (padrao)
DERP_OBSERVE_ONLY=1 e o DEFAULT: acumula historico e nunca alerta. Os limiares
abaixo sao chute informado ate existirem 7 dias de dado real; so entao fixar
ACUTE_RATIO em max(3%, 2 x p95(razao de janela)) e desligar o observe-only.

SAIDA
Imprime em stdout SO quando alerta. O cron do hermes (--no-agent --script) trata
stdout vazio como run silencioso, entao nao ha ruido por construcao.

Uso: python3 derp-loss.py
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 1
QUEUED = "magicsock_send_derp_queued"
DROPPED = "magicsock_send_derp_dropped"

TS_SOCKET = os.environ.get("TS_SOCKET", "/var/run/tailscale/tailscaled.sock")
STATE_DIR = Path(os.environ.get(
    "DERP_STATE_DIR",
    str(Path(os.environ.get("HERMES_HOME", "/data/.hermes")) / "state"),
))
STATE = STATE_DIR / "derp-loss.json"
HISTORY = STATE_DIR / "derp-loss.jsonl"

OBSERVE_ONLY = os.environ.get("DERP_OBSERVE_ONLY", "1") == "1"
ACUTE_RATIO = float(os.environ.get("DERP_ACUTE_RATIO", "0.03"))
REARM_RATIO = float(os.environ.get("DERP_REARM_RATIO", "0.015"))
MIN_QUEUED = int(os.environ.get("DERP_MIN_QUEUED", "20000"))
MIN_DROPPED = int(os.environ.get("DERP_MIN_DROPPED", "500"))
CHRONIC_FACTOR = float(os.environ.get("DERP_CHRONIC_FACTOR", "2.0"))
CHRONIC_MIN_RATIO = float(os.environ.get("DERP_CHRONIC_MIN_RATIO", "0.005"))
CHRONIC_MIN_QUEUED = int(os.environ.get("DERP_CHRONIC_MIN_QUEUED", "2000000"))
HISTORY_MAX = int(os.environ.get("DERP_HISTORY_MAX", "5000"))

DAY = 86400


def read_metrics_text():
    """Fixture (testes) > `tailscale debug metrics` > localapi no socket unix."""
    fixture = os.environ.get("DERP_METRICS_FILE")
    if fixture:
        return Path(fixture).read_text()
    try:
        r = subprocess.run(
            ["tailscale", "--socket=" + TS_SOCKET, "debug", "metrics"],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout
    except Exception:  # noqa: BLE001
        pass
    try:
        r = subprocess.run(
            ["curl", "-sf", "--unix-socket", TS_SOCKET,
             "-H", "Host: local-tailscaled.sock",
             "http://local-tailscaled.sock/localapi/v0/metrics"],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout
    except Exception:  # noqa: BLE001
        pass
    return None


def parse_metrics(text):
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[0] in (QUEUED, DROPPED):
            try:
                out[parts[0]] = int(parts[1])
            except ValueError:
                pass
    return out


def daemon_id():
    """pid:starttime do tailscaled. Detecta restart com precisao.

    Sem /proc (macOS nos testes) devolve None e a deteccao de restart fica so por
    contador que diminuiu -- que ja cobre o caso, so com menos precisao.
    """
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
                # /proc/pid/stat: o campo 2 (comm) vem entre parenteses e pode
                # conter espacos -> cortar no ULTIMO ")" antes de dividir.
                rest = (p / "stat").read_text().rsplit(")", 1)[1].split()
                return f"{p.name}:{rest[19]}"   # campo 22 = starttime
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        return None
    return None


def load_state():
    try:
        return json.loads(STATE.read_text())
    except Exception:  # noqa: BLE001
        return None


def write_atomic(path, text):
    """Escrita atomica: .tmp no MESMO diretorio + rename.

    Staging em /tmp faria o rename cruzar filesystem (EXDEV) e deixar de ser atomico.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


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


def chronic_check(now):
    """Compara a razao agregada de 24h com a dos 7 dias anteriores."""
    hist = [e for e in load_history() if not e.get("reset")]
    recent = [e for e in hist if e["epoch"] >= now - DAY]
    prior = [e for e in hist if now - 8 * DAY <= e["epoch"] < now - DAY]
    if not recent or not prior:
        return None
    rq, rd = sum(e["dq"] for e in recent), sum(e["dd"] for e in recent)
    pq, pd = sum(e["dq"] for e in prior), sum(e["dd"] for e in prior)
    if rq < CHRONIC_MIN_QUEUED or pq <= 0:
        return None
    r_recent, r_prior = ratio(rd, rq), ratio(pd, pq)
    if r_recent < CHRONIC_MIN_RATIO:
        return None
    if r_prior <= 0 or r_recent < CHRONIC_FACTOR * r_prior:
        return None
    return (
        f"DERP: deriva cronica. Perda de 24h em {r_recent * 100:.2f}% "
        f"({rd} de {rq}) contra {r_prior * 100:.2f}% nos 7 dias anteriores "
        f"({pd} de {pq}) -- fator {r_recent / r_prior:.1f}x."
    )


def main():
    text = read_metrics_text()
    if text is None:
        # Falha de leitura nao e perda de pacote. Sair silencioso evita transformar
        # indisponibilidade do socket em alerta de rede. O cron sinaliza exit != 0.
        return 2
    m = parse_metrics(text)
    if QUEUED not in m or DROPPED not in m:
        return 3

    now = int(time.time())
    iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    queued, dropped, did = m[QUEUED], m[DROPPED], daemon_id()
    prev = load_state()

    fresh = {
        "schema": SCHEMA, "ts": iso, "epoch": now,
        "queued": queued, "dropped": dropped, "daemon_id": did,
        "consecutive_breaches": 0, "alerting": False,
    }

    if prev is None:
        save_state(fresh)
        append_history({"ts": iso, "epoch": now, "dq": 0, "dd": 0,
                        "ratio": 0.0, "reset": "primeira-execucao"})
        return 0

    # Contador zerado por restart NUNCA vira alerta: vira nova baseline.
    restarted = (
        (did is not None and prev.get("daemon_id") is not None and did != prev["daemon_id"])
        or queued < prev.get("queued", 0)
        or dropped < prev.get("dropped", 0)
    )
    if restarted:
        save_state(fresh)
        append_history({"ts": iso, "epoch": now, "dq": 0, "dd": 0,
                        "ratio": 0.0, "reset": "restart-tailscaled"})
        return 0

    dq = queued - prev.get("queued", 0)
    dd = dropped - prev.get("dropped", 0)
    r = ratio(dd, dq)
    append_history({"ts": iso, "epoch": now, "dq": dq, "dd": dd, "ratio": round(r, 6)})

    consecutive = int(prev.get("consecutive_breaches", 0))
    alerting = bool(prev.get("alerting", False))

    breach = dq >= MIN_QUEUED and dd >= MIN_DROPPED and r >= ACUTE_RATIO
    consecutive = consecutive + 1 if breach else 0
    if alerting and r < REARM_RATIO:
        alerting = False   # histerese: rearma so depois de a janela normalizar

    alerts = []
    if not OBSERVE_ONLY:
        if consecutive >= 2 and not alerting:
            alerting = True
            alerts.append(
                f"DERP: perda sustentada. {consecutive} janelas consecutivas com "
                f"{r * 100:.2f}% ({dd} descartes em {dq} enfileirados na ultima)."
            )
        chronic = chronic_check(now)
        if chronic:
            alerts.append(chronic)

    save_state({
        "schema": SCHEMA, "ts": iso, "epoch": now,
        "queued": queued, "dropped": dropped, "daemon_id": did,
        "consecutive_breaches": consecutive, "alerting": alerting,
    })

    for a in alerts:
        print(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
