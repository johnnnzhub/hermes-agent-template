#!/usr/bin/env python3
"""test_derp_loss.py — testes do monitor de perda DERP.

Alimenta o scripts/derp-loss.py com fixtures sinteticas de `tailscale debug
metrics` (via DERP_METRICS_FILE) e verifica quando ele fica em silencio e quando
alerta. Nada toca a rede, o socket do tailscaled ou producao.

O invariante mais importante coberto aqui: o monitor NUNCA alerta sobre a razao
acumulada, so sobre crescimento -- e contador zerado por restart vira baseline
nova, nunca alerta.

So depende da stdlib. Uso: python3 tests/test_derp_loss.py
"""
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
    """Ambiente isolado: state dir proprio e fixture de metricas propria."""

    def __init__(self, **extra):
        self.dir = Path(tempfile.mkdtemp())
        self.metrics = self.dir / "metrics.txt"
        self.extra = extra
        self.daemon = "1:100"

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run(self, queued, dropped, daemon=None, **override):
        self.metrics.write_text(
            "# TYPE magicsock_send_derp counter\n"
            "magicsock_send_derp 999\n"
            f"magicsock_send_derp_queued {queued}\n"
            f"magicsock_send_derp_dropped {dropped}\n"
            "tailscaled_outbound_dropped_packets_total{reason=\"multicast\"} 647\n"
        )
        env = dict(os.environ)
        env.update({
            "DERP_METRICS_FILE": str(self.metrics),
            "DERP_STATE_DIR": str(self.dir),
            "DERP_OBSERVE_ONLY": "0",
            "DERP_DAEMON_ID": daemon if daemon is not None else self.daemon,
        })
        env.update({k: str(v) for k, v in self.extra.items()})
        env.update({k: str(v) for k, v in override.items()})
        r = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True,
                           text=True, env=env)
        return r.stdout

    def state(self):
        return json.loads((self.dir / "derp-loss.json").read_text())

    def history(self):
        p = self.dir / "derp-loss.jsonl"
        return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []

    def seed_history(self, entries):
        p = self.dir / "derp-loss.jsonl"
        with p.open("a") as fh:
            for e in entries:
                fh.write(json.dumps(e) + "\n")


print("== monitor de perda DERP ==")

# ---------------------------------------------------------------------------
# T1 — primeira execucao grava baseline e fica em silencio
# ---------------------------------------------------------------------------
e = Env()
silent("T1 primeira execucao e silenciosa", e.run(1_000_000, 10_000))
eq("T1 grava baseline", e.state()["queued"], 1_000_000)
eq("T1 historico marca a primeira", e.history()[0].get("reset"), "primeira-execucao")

# ---------------------------------------------------------------------------
# T2 — a razao ACUMULADA e alta (1%) mas nao ha crescimento: silencio
# ---------------------------------------------------------------------------
silent("T2 sem crescimento e silencioso", e.run(1_000_000, 10_000))
eq("T2 delta zerado no historico", e.history()[-1]["dq"], 0)
e.close()

# ---------------------------------------------------------------------------
# T3 — restart do tailscaled: contador MENOR vira baseline, nunca alerta
# ---------------------------------------------------------------------------
e = Env()
e.run(5_000_000, 50_000)
out = e.run(120, 3, daemon="2:200")
silent("T3 restart nao alerta", out)
eq("T3 vira baseline nova", e.state()["queued"], 120)
eq("T3 historico marca o restart", e.history()[-1].get("reset"), "restart-tailscaled")
eq("T3 zera as janelas acumuladas", e.state()["consecutive_breaches"], 0)
e.close()

# ---------------------------------------------------------------------------
# T4 — uma janela acima do limiar nao basta (rajada de PTY)
# ---------------------------------------------------------------------------
e = Env()
e.run(1_000_000, 10_000)
silent("T4 uma janela ruim nao alerta", e.run(1_100_000, 15_000))   # 5% em 100k
eq("T4 registra a janela", e.state()["consecutive_breaches"], 1)

# ---------------------------------------------------------------------------
# T5 — duas janelas consecutivas alertam uma vez
# ---------------------------------------------------------------------------
speaks("T5 duas janelas consecutivas alertam", e.run(1_200_000, 20_000),
       "perda sustentada")
eq("T5 marca estado de alerta", e.state()["alerting"], True)

# ---------------------------------------------------------------------------
# T6 — histerese: terceira janela ruim nao repete o alerta
# ---------------------------------------------------------------------------
silent("T6 histerese evita repetir", e.run(1_300_000, 25_000))

# ---------------------------------------------------------------------------
# T7 — janela normal rearma; duas ruins voltam a alertar
# ---------------------------------------------------------------------------
silent("T7 janela normal rearma em silencio", e.run(1_400_000, 25_100))  # 0.1%
silent("T7 primeira ruim pos-rearme", e.run(1_500_000, 30_100))
speaks("T7 segunda ruim volta a alertar", e.run(1_600_000, 35_100), "perda sustentada")
e.close()

# ---------------------------------------------------------------------------
# T8 — volume abaixo do piso nao alerta, mesmo com razao horrivel
# ---------------------------------------------------------------------------
e = Env()
e.run(1_000, 10)
silent("T8 volume baixo nao alerta (1a)", e.run(1_050, 35))   # 50% em 50 pacotes
silent("T8 volume baixo nao alerta (2a)", e.run(1_100, 60))
eq("T8 nao conta como janela ruim", e.state()["consecutive_breaches"], 0)
e.close()

# ---------------------------------------------------------------------------
# T9 — observe-only (padrao da fase 0) nunca alerta, mas acumula historico
# ---------------------------------------------------------------------------
e = Env()
e.run(1_000_000, 10_000, DERP_OBSERVE_ONLY="1")
e.run(1_100_000, 15_000, DERP_OBSERVE_ONLY="1")
silent("T9 observe-only nao alerta", e.run(1_200_000, 20_000, DERP_OBSERVE_ONLY="1"))
eq("T9 mesmo assim acumula historico", len(e.history()), 3)
e.close()

# ---------------------------------------------------------------------------
# T10 — braco cronico: 24h piores que os 7 dias anteriores
# ---------------------------------------------------------------------------
e = Env()
now = int(time.time())
# 7 dias anteriores saudaveis: 0.1%
e.seed_history([
    {"ts": "x", "epoch": now - 2 * 86400 - i * 3600, "dq": 500_000, "dd": 500,
     "ratio": 0.001}
    for i in range(40)
])
# ultimas 24h em 0.6% -- nenhuma janela isolada estoura o limiar agudo de 3%
e.seed_history([
    {"ts": "x", "epoch": now - i * 1800, "dq": 300_000, "dd": 1_800, "ratio": 0.006}
    for i in range(1, 20)
])
e.run(1_000_000, 10_000)
speaks("T10 deriva cronica alerta", e.run(1_010_000, 10_050), "deriva cronica")
e.close()

# ---------------------------------------------------------------------------
# T11 — cronico nao dispara quando 24h ~ 7 dias
# ---------------------------------------------------------------------------
e = Env()
now = int(time.time())
e.seed_history([
    {"ts": "x", "epoch": now - 2 * 86400 - i * 3600, "dq": 500_000, "dd": 3_000,
     "ratio": 0.006}
    for i in range(40)
])
e.seed_history([
    {"ts": "x", "epoch": now - i * 1800, "dq": 300_000, "dd": 1_800, "ratio": 0.006}
    for i in range(1, 20)
])
e.run(1_000_000, 10_000)
silent("T11 sem deriva nao alerta", e.run(1_010_000, 10_050))
e.close()

# ---------------------------------------------------------------------------
# T12 — le o contador certo, ignorando o parecido de `metrics print`
# ---------------------------------------------------------------------------
e = Env()
e.run(1_000_000, 10_000)
st = e.state()
eq("T12 le magicsock_send_derp_queued", st["queued"], 1_000_000)
eq("T12 le magicsock_send_derp_dropped", st["dropped"], 10_000)
e.close()

# ---------------------------------------------------------------------------
# T13 — metricas ilegiveis nao viram alerta de rede
# ---------------------------------------------------------------------------
d = Path(tempfile.mkdtemp())
env = dict(os.environ)
env.update({"DERP_METRICS_FILE": str(d / "inexistente.txt"),
            "DERP_STATE_DIR": str(d), "DERP_OBSERVE_ONLY": "0"})
r = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, env=env)
silent("T13 falha de leitura nao alerta", r.stdout)
ok("T13 sinaliza por exit code") if r.returncode != 0 else bad("T13 sinaliza por exit code")
shutil.rmtree(d, ignore_errors=True)

print()
print(f"passou: {PASSED}   falhou: {FAILED}")
sys.exit(1 if FAILED else 0)
