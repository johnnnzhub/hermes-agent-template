#!/usr/bin/env python3
"""test_derp_loss.py — testes do monitor de saturação da fila DERP.

Alimenta o scripts/derp-loss.py com fixtures sintéticas de `tailscale debug
metrics` (via DERP_METRICS_FILE) e verifica quando ele fica em silêncio e quando
alerta. Nada toca a rede, o socket do tailscaled ou produção.

Invariantes centrais cobertos: nunca alerta sobre razão acumulada, contador zerado
por restart vira baseline nova, o braço crônico não repete a cada execução, o
ciclo é exclusivo entre processos, e estado corrompido falha fechado.

Só stdlib. Uso: python3 tests/test_derp_loss.py
"""
import fcntl
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "scripts" / "derp-loss.py"
WINDOW = 900

PASSED = 0
FAILED = 0


def ok(name):
    global PASSED
    PASSED += 1
    print(f"  ok    {name}")


def bad(name, detail=""):
    global FAILED
    FAILED += 1
    print(f"  FAIL  {name}")
    if detail:
        print(f"        {detail}")


def eq(name, got, want):
    ok(name) if got == want else bad(name, f"esperado={want!r} obtido={got!r}")


def silent(name, out):
    ok(name) if out.strip() == "" else bad(name, f"esperava silencio, veio: {out.strip()!r}")


def speaks(name, out, needle=""):
    if out.strip() and (not needle or needle in out):
        ok(name)
    else:
        bad(name, f"esperava alerta contendo {needle!r}, veio: {out.strip()!r}")


class Env:
    def __init__(self, **extra):
        self.dir = Path(tempfile.mkdtemp())
        self.metrics = self.dir / "metrics.txt"
        self.extra = extra
        self.daemon = "1:100"

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def env_for(self, daemon=None, **override):
        env = dict(os.environ)
        env.update({
            "DERP_METRICS_FILE": str(self.metrics),
            "DERP_STATE_DIR": str(self.dir),
            "DERP_OBSERVE_ONLY": "0",
            # execucoes sequenciais aqui SIMULAM janelas; sem zerar o piso o
            # debounce as descartaria por virem milissegundos apos a anterior.
            # O piso real e exercitado no T18.
            "DERP_MIN_SPAN_SECONDS": "0",
            # fora do observe-only o monitor falha fechada sem destino resolvido;
            # os testes armados declaram um. O guard em si e coberto no T22.
            "DERP_ALERT_DEST": "teste:canal-de-teste",
            "DERP_DAEMON_ID": daemon if daemon is not None else self.daemon,
        })
        env.update({k: str(v) for k, v in self.extra.items()})
        env.update({k: str(v) for k, v in override.items()})
        return env

    def write_metrics(self, queued, dropped, errq=0):
        self.metrics.write_text(
            "# TYPE magicsock_send_derp counter\n"
            "magicsock_send_derp 999\n"
            f"magicsock_send_derp_queued {queued}\n"
            f"magicsock_send_derp_dropped {dropped}\n"
            f"magicsock_send_derp_error_queue {errq}\n"
            "tailscaled_outbound_dropped_packets_total{reason=\"multicast\"} 647\n"
        )

    def run(self, queued, dropped, errq=0, daemon=None, **override):
        self.write_metrics(queued, dropped, errq)
        r = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True,
                           text=True, env=self.env_for(daemon, **override))
        self.last = r
        return r.stdout

    def state(self):
        return json.loads((self.dir / "derp-loss.json").read_text())

    def history(self):
        p = self.dir / "derp-loss.jsonl"
        return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []

    def seed_history(self, entries):
        with (self.dir / "derp-loss.jsonl").open("a") as fh:
            for e in entries:
                fh.write(json.dumps(e) + "\n")

    def backdate_state(self, seconds):
        """Envelhece o epoch do estado, para simular gap de coleta."""
        st = self.state()
        st["epoch"] -= seconds
        (self.dir / "derp-loss.json").write_text(json.dumps(st))


print("== monitor de saturacao da fila DERP ==")

# ---------------------------------------------------------------------------
# T1 — primeira execucao grava baseline e fica em silencio
# ---------------------------------------------------------------------------
e = Env()
silent("T1 primeira execucao e silenciosa", e.run(1_000_000, 10_000))
eq("T1 grava baseline", e.state()["queued"], 1_000_000)
eq("T1 historico marca a primeira", e.history()[0].get("reset"), "primeira-execucao")

# ---------------------------------------------------------------------------
# T2 — razao ACUMULADA alta (1%) sem crescimento: silencio
# ---------------------------------------------------------------------------
silent("T2 sem crescimento e silencioso", e.run(1_000_000, 10_000))
eq("T2 delta zerado no historico", e.history()[-1]["dq"], 0)
e.close()

# ---------------------------------------------------------------------------
# T3 — restart do tailscaled: contador MENOR vira baseline, nunca alerta
# ---------------------------------------------------------------------------
e = Env()
e.run(5_000_000, 50_000)
silent("T3 restart nao alerta", e.run(120, 3, daemon="2:200"))
eq("T3 vira baseline nova", e.state()["queued"], 120)
eq("T3 historico marca o restart", e.history()[-1].get("reset"), "restart-tailscaled")
eq("T3 zera as janelas acumuladas", e.state()["consecutive_breaches"], 0)
e.close()

# ---------------------------------------------------------------------------
# T4/T5/T6/T7 — agudo: uma janela nao basta, duas alertam, histerese, rearme
# ---------------------------------------------------------------------------
e = Env()
e.run(1_000_000, 10_000)
silent("T4 uma janela ruim nao alerta", e.run(1_100_000, 15_000))     # 5% em 100k
eq("T4 registra a janela", e.state()["consecutive_breaches"], 1)

speaks("T5 duas janelas consecutivas alertam", e.run(1_200_000, 20_000),
       "descarte sustentado")
eq("T5 marca estado de alerta", e.state()["alerting"], True)
silent("T6 histerese evita repetir", e.run(1_300_000, 25_000))
silent("T7 janela normal rearma em silencio", e.run(1_400_000, 25_100))
silent("T7 primeira ruim pos-rearme", e.run(1_500_000, 30_100))
speaks("T7 segunda ruim volta a alertar", e.run(1_600_000, 35_100), "descarte sustentado")
e.close()

# ---------------------------------------------------------------------------
# T8 — JANELA OCIOSA NAO REARMA. Sem volume, razao 0 nao e evidencia de melhora.
# ---------------------------------------------------------------------------
e = Env()
e.run(1_000_000, 10_000)
e.run(1_100_000, 15_000)
speaks("T8 entra em alerta", e.run(1_200_000, 20_000), "descarte sustentado")
silent("T8 janela ociosa e silenciosa", e.run(1_200_000, 20_000))     # dq=0
eq("T8 janela ociosa NAO rearma", e.state()["alerting"], True)
e.close()

# ---------------------------------------------------------------------------
# T9 — volume abaixo do piso nao alerta, mesmo com razao horrivel
# ---------------------------------------------------------------------------
e = Env()
e.run(1_000, 10)
silent("T9 volume baixo nao alerta (1a)", e.run(1_050, 35))          # 50% em 50
silent("T9 volume baixo nao alerta (2a)", e.run(1_100, 60))
eq("T9 nao conta como janela ruim", e.state()["consecutive_breaches"], 0)
e.close()

# ---------------------------------------------------------------------------
# T10 — observe-only por MARCADOR (nao depende de env do servico nem de restart)
# ---------------------------------------------------------------------------
e = Env()
(e.dir / "derp-loss.observe-only").touch()
e.run(1_000_000, 10_000)
e.run(1_100_000, 15_000)
silent("T10 marcador silencia o alerta", e.run(1_200_000, 20_000))
eq("T10 mesmo assim acumula historico", len(e.history()), 3)
e.close()

# ---------------------------------------------------------------------------
# T11 — GAP de coleta: delta acumulado em intervalo >> janela vira baseline
# ---------------------------------------------------------------------------
e = Env()
e.run(1_000_000, 10_000)
e.backdate_state(WINDOW * 10)
silent("T11 gap de coleta nao alerta", e.run(9_000_000, 900_000))
eq("T11 gap vira baseline", e.history()[-1].get("reset"), "gap-de-coleta")
e.close()

# ---------------------------------------------------------------------------
# T12 — mudanca de configuracao zera o estado de alerta acumulado
# ---------------------------------------------------------------------------
e = Env()
e.run(1_000_000, 10_000)
e.run(1_100_000, 15_000)
eq("T12 tinha janela acumulada", e.state()["consecutive_breaches"], 1)
silent("T12 troca de limiar e silenciosa", e.run(1_200_000, 20_000, DERP_ACUTE_RATIO="0.10"))
eq("T12 zera o acumulado", e.state()["consecutive_breaches"], 0)
eq("T12 marca o motivo", e.history()[-1].get("reset"), "config-mudou")
e.close()

# ---------------------------------------------------------------------------
# T13 — CRONICO: alerta uma vez e NAO repete na execucao seguinte (latch)
# ---------------------------------------------------------------------------
def seed_chronic(env, prior_dd, recent_dd):
    now = int(time.time())
    # 7 dias anteriores: 400 janelas (cobertura > 50% de 7 dias)
    env.seed_history([
        {"ts": "x", "epoch": now - DAY_ - i * 1500, "dq": 50_000, "dd": prior_dd,
         "ratio": prior_dd / 50_000}
        for i in range(400)
    ])
    # ultimas 24h: 60 janelas (cobertura > 50% de 24h), volume > 2M
    env.seed_history([
        {"ts": "x", "epoch": now - i * 1200, "dq": 50_000, "dd": recent_dd,
         "ratio": recent_dd / 50_000}
        for i in range(1, 61)
    ])


DAY_ = 86400 + 3600   # comeca fora da janela de 24h

e = Env()
seed_chronic(e, prior_dd=50, recent_dd=400)      # 0.1% -> 0.8%
e.run(1_000_000, 10_000)
speaks("T13 deriva cronica alerta", e.run(1_010_000, 10_050), "deriva cronica")
silent("T13 NAO repete na execucao seguinte", e.run(1_020_000, 10_100))
silent("T13 nem na terceira", e.run(1_030_000, 10_150))
e.close()

# ---------------------------------------------------------------------------
# T14 — cronico nao dispara quando 24h ~ 7 dias
# ---------------------------------------------------------------------------
e = Env()
seed_chronic(e, prior_dd=400, recent_dd=400)
e.run(1_000_000, 10_000)
silent("T14 sem deriva nao alerta", e.run(1_010_000, 10_050))
e.close()

# ---------------------------------------------------------------------------
# T15 — cronico com baseline historica de ZERO descartes precisa alertar
# ---------------------------------------------------------------------------
e = Env()
seed_chronic(e, prior_dd=0, recent_dd=400)
e.run(1_000_000, 10_000)
speaks("T15 baseline zero alerta", e.run(1_010_000, 10_050), "onde nao havia")
e.close()

# ---------------------------------------------------------------------------
# T16 — cronico exige COBERTURA: poucas amostras nao declaram tendencia
# ---------------------------------------------------------------------------
e = Env()
now = int(time.time())
e.seed_history([{"ts": "x", "epoch": now - DAY_ - i * 1500, "dq": 500_000,
                 "dd": 500, "ratio": 0.001} for i in range(5)])
e.seed_history([{"ts": "x", "epoch": now - i * 1200, "dq": 500_000, "dd": 5_000,
                 "ratio": 0.01} for i in range(1, 6)])
e.run(1_000_000, 10_000)
silent("T16 cobertura insuficiente nao alerta", e.run(1_010_000, 10_050))
e.close()

# ---------------------------------------------------------------------------
# T17 — EXCLUSAO MUTUA: com o lock tomado, a execucao sai silenciosa e nao grava
# ---------------------------------------------------------------------------
e = Env()
e.run(1_000_000, 10_000)
before = e.state()["queued"]
e.write_metrics(2_000_000, 40_000)
lock_path = e.dir / "derp-loss.lock"
with lock_path.open("w") as lk:
    fcntl.flock(lk, fcntl.LOCK_EX)
    r = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True,
                       text=True, env=e.env_for())
    silent("T17 execucao concorrente e silenciosa", r.stdout)
    eq("T17 sai limpo", r.returncode, 0)
    eq("T17 NAO grava estado sob lock alheio", e.state()["queued"], before)

# solto o lock: a proxima execucao processa normalmente
silent("T17 apos soltar o lock, processa", e.run(2_000_000, 40_000))
eq("T17 estado avancou", e.state()["queued"], 2_000_000)

e.close()

# ---------------------------------------------------------------------------
# T18 — corrida real com o piso de janela ATIVO: 6 processos simultaneos nao
# acrescentam janela nenhuma. Sem o piso, os que perdem a corrida pelo lock
# rodam logo depois e gravam janelas de delta zero, que diluem a razao e inflam
# a contagem de cobertura do braco cronico.
# ---------------------------------------------------------------------------
e = Env(DERP_MIN_SPAN_SECONDS=300)
e.run(1_000_000, 10_000)                       # baseline, epoch = agora
hist_before = len(e.history())
e.write_metrics(3_000_000, 60_000)
procs = [subprocess.Popen([sys.executable, str(SCRIPT)], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, env=e.env_for())
         for _ in range(6)]
outs = []
for p in procs:
    o, _ = p.communicate()
    outs.append(o)
added = len(e.history()) - hist_before
eq("T18 6 simultaneas nao criam janela espuria", added, 0)
silent("T18 nenhuma delas alerta", "".join(outs))
try:
    e.state()
    ok("T18 estado permanece json valido")
except Exception as exc:  # noqa: BLE001
    bad("T18 estado permanece json valido", repr(exc))
eq("T18 sem tempfile orfao", len(list(e.dir.glob("derp-loss.json.*.tmp"))), 0)
e.close()

# ---------------------------------------------------------------------------
# T19 — estado CORROMPIDO falha fechada: nao sobrescreve a baseline
# ---------------------------------------------------------------------------
e = Env()
e.run(1_000_000, 10_000)
corrupt = "{isto nao e json"
(e.dir / "derp-loss.json").write_text(corrupt)
out = e.run(1_100_000, 15_000)
silent("T19 corrompido nao imprime alerta", out)
ok("T19 sinaliza por exit code") if e.last.returncode != 0 \
    else bad("T19 sinaliza por exit code", f"exit={e.last.returncode}")
eq("T19 NAO sobrescreve o estado suspeito",
   (e.dir / "derp-loss.json").read_text(), corrupt)
ok("T19 diz o que houve no stderr") if "estado NAO foi sobrescrito" in e.last.stderr \
    else bad("T19 diz o que houve no stderr", e.last.stderr.strip()[:120])
e.close()

# ---------------------------------------------------------------------------
# T20 — le os contadores certos e registra fila cheia
# ---------------------------------------------------------------------------
e = Env()
e.run(1_000_000, 10_000, errq=5)
st = e.state()
eq("T20 le magicsock_send_derp_queued", st["queued"], 1_000_000)
eq("T20 le magicsock_send_derp_dropped", st["dropped"], 10_000)
eq("T20 le magicsock_send_derp_error_queue", st["errq"], 5)
e.run(1_100_000, 15_000, errq=9)
eq("T20 registra delta de fila cheia", e.history()[-1]["derrq"], 4)
e.close()

# ---------------------------------------------------------------------------
# T22 — FALHA FECHADA sem destino: fora do observe-only e sem destino resolvido,
# nao alerta e sinaliza. Um alerta que nao sabe para onde vai e pior que nenhum,
# porque cria impressao de cobertura.
# ---------------------------------------------------------------------------
e = Env()
e.run(1_000_000, 10_000, DERP_ALERT_DEST="")
e.run(1_100_000, 15_000, DERP_ALERT_DEST="")
out = e.run(1_200_000, 20_000, DERP_ALERT_DEST="")
silent("T22 sem destino nao alerta", out)
ok("T22 sinaliza por exit code") if e.last.returncode == 5 \
    else bad("T22 sinaliza por exit code", f"exit={e.last.returncode}")
ok("T22 explica no stderr") if "sem destino de alerta" in e.last.stderr \
    else bad("T22 explica no stderr", e.last.stderr.strip()[:120])

# o mesmo cenario com destino declarado por ARQUIVO passa a alertar
(e.dir / "derp-loss.dest").write_text("teste:canal-por-arquivo\n")
speaks("T22 destino por arquivo destrava", e.run(1_300_000, 25_000, DERP_ALERT_DEST=""),
       "descarte sustentado")

# observe-only nao exige destino
e2 = Env()
(e2.dir / "derp-loss.observe-only").touch()
e2.run(1_000_000, 10_000, DERP_ALERT_DEST="")
silent("T22 observe-only nao exige destino", e2.run(1_100_000, 15_000, DERP_ALERT_DEST=""))
eq("T22 observe-only sai limpo", e2.last.returncode, 0)
e2.close()
e.close()

# ---------------------------------------------------------------------------
# T23 — error_queue PARTICIPA da decisao. Fila que recusa tudo que chega tem
# dropped parado e error_queue crescendo: antes isso passava batido.
# ---------------------------------------------------------------------------
e = Env()
e.run(1_000_000, 10_000, errq=0)
silent("T23 primeira janela so-errq nao basta", e.run(1_100_000, 10_000, errq=5_000))
eq("T23 mas conta como janela ruim", e.state()["consecutive_breaches"], 1)
speaks("T23 duas janelas so-errq alertam", e.run(1_200_000, 10_000, errq=10_000),
       "recusados por fila cheia")
e.close()

# desligando a contagem, o mesmo cenario fica silencioso
e = Env(DERP_COUNT_ERRQ=0)
e.run(1_000_000, 10_000, errq=0)
e.run(1_100_000, 10_000, errq=5_000)
silent("T23 DERP_COUNT_ERRQ=0 ignora errq", e.run(1_200_000, 10_000, errq=10_000))
e.close()

# ---------------------------------------------------------------------------
# T24 — COBERTURA por tempo real, nao por contagem. Amostras densas e
# sobrepostas cobrem pouco tempo e nao podem declarar tendencia.
# ---------------------------------------------------------------------------
e = Env()
now = int(time.time())
# 400 amostras "prior" espremidas em ~28h, cada uma medindo 900s -> muita
# sobreposicao. Pela contagem antiga dariam 100h de cobertura.
e.seed_history([{"ts": "x", "epoch": now - 86400 - 3600 - i * 250, "dq": 50_000,
                 "dd": 50, "derrq": 0, "span": 900, "ratio": 0.001}
                for i in range(400)])
# 60 amostras "recent" espremidas em ~4h
e.seed_history([{"ts": "x", "epoch": now - i * 240, "dq": 50_000, "dd": 400,
                 "derrq": 0, "span": 900, "ratio": 0.008} for i in range(1, 61)])
e.run(1_000_000, 10_000)
silent("T24 amostras sobrepostas nao declaram tendencia", e.run(1_010_000, 10_050))
e.close()

# ---------------------------------------------------------------------------
# T21 — metricas ilegiveis nao viram alerta de rede
# ---------------------------------------------------------------------------
d = Path(tempfile.mkdtemp())
env = dict(os.environ)
env.update({"DERP_METRICS_FILE": str(d / "inexistente.txt"),
            "DERP_STATE_DIR": str(d), "DERP_OBSERVE_ONLY": "0"})
r = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, env=env)
silent("T21 falha de leitura nao alerta", r.stdout)
ok("T21 sinaliza por exit code") if r.returncode != 0 else bad("T21 sinaliza por exit code")
shutil.rmtree(d, ignore_errors=True)

print()
print(f"passou: {PASSED}   falhou: {FAILED}")
sys.exit(1 if FAILED else 0)
