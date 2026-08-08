#!/usr/bin/env python3
"""Modo inerte da Iris — o caminho de rollback da migração para a Hetzner.

Sobe SÓ um servidor HTTP que responde 200, e nada mais: sem gateway, sem bridge
do WhatsApp, sem scheduler de cron, sem Tailscale. Existe para permitir
`railway ssh` no container sem acordar consumidor nenhum.

Por que o servidor HTTP é obrigatório e não um `sleep infinity`:
`railway.toml` declara `healthcheckPath = "/health"` com `healthcheckTimeout = 300`
e `restartPolicyType = "on_failure"` (10 tentativas). Um processo que não atende
`/health` faz o Railway declarar o deploy fracassado e reiniciar em laço — o modo
inerte nunca chegaria a ficar alcançável, que é justamente a sua única função.

Responde 200 em QUALQUER path de propósito: o healthcheck do Railway já mudou de
caminho antes, e um 404 no caminho errado reintroduz o modo de falha que este
arquivo existe para evitar. O corpo identifica o modo, para que ninguém confunda
um container inerte com uma Iris viva:

    {"status": "ok", "mode": "inert", "gateway": "stopped"}

O campo `gateway` é deliberado — o hábito da casa é ler `/health` pelo campo
`gateway`, não pelo status, e aqui ele diz a verdade.

Uso: `IRIS_INERT=1` no serviço Railway. O gate no topo do `hermes-boot.sh` faz
`exec` neste arquivo antes de qualquer outra coisa.
"""

import json
import os
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CORPO = json.dumps(
    {"status": "ok", "mode": "inert", "gateway": "stopped"}
).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _responder(self, com_corpo: bool) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(CORPO)))
        self.end_headers()
        if com_corpo:
            self.wfile.write(CORPO)

    def do_GET(self) -> None:      # noqa: N802 — assinatura da stdlib
        self._responder(True)

    def do_HEAD(self) -> None:     # noqa: N802
        self._responder(False)

    def log_message(self, *args) -> None:
        """Silêncio: o healthcheck bate a cada poucos segundos e encheria o log."""


def main() -> None:
    porta = int(os.environ.get("PORT", "8080"))
    servidor = ThreadingHTTPServer(("0.0.0.0", porta), Handler)
    servidor.daemon_threads = True

    def encerrar(signum, _frame):
        # Sem isto o `podman stop`/deploy espera o timeout inteiro.
        #
        # `shutdown()` bloqueia até `serve_forever()` retornar, e o handler de
        # sinal roda NA MESMA THREAD que o `serve_forever()` — chamá-lo aqui
        # direto trava o processo para sempre (medido: SIGTERM logava
        # "encerrando" e o PID seguia vivo). Tem de partir de outra thread.
        print(f"[iris-inert] sinal {signum} — encerrando", flush=True)
        threading.Thread(target=servidor.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, encerrar)
    signal.signal(signal.SIGINT, encerrar)

    print(f"[iris-inert] MODO INERTE — servindo :{porta}, nada mais no ar", flush=True)
    try:
        servidor.serve_forever()
    except BaseException:
        # NAO engolir: este e o unico processo do caminho de rollback, e tanto o
        # railway.toml quanto a unit systemd usam restartPolicy on_failure. Um
        # `sys.exit(0)` no finally substituiria a excecao ativa e o processo
        # morreria com rc 0 -- falha do respondedor de /health lida como sucesso,
        # sem reinicio e sem traceback.
        servidor.server_close()
        print("[iris-inert] FALHA no loop do servidor", flush=True)
        raise
    servidor.server_close()
    print("[iris-inert] encerrado", flush=True)


if __name__ == "__main__":
    main()
