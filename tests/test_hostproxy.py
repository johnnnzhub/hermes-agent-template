#!/usr/bin/env python3
"""test_hostproxy.py — testes do hostproxy (Host-rewrite, Origin-rewrite, connect-first).

Sobe um upstream stub que imita as validacoes do `hermes dashboard`
(hermes_cli/web_server.py): Host so loopback, Origin so loopback no WebSocket, e
token de sessao. Poe o hostproxy na frente e exercita o caminho real.

A regressao central coberta aqui: a versao anterior chamava ws.prepare() ANTES de
conectar o upstream, entao um 401/403 real do dashboard virava um 101 seguido de
close -- que o cliente le como timeout/sessao recusada, sem nunca ver o status
verdadeiro. Este arquivo falha se isso voltar.

So depende de aiohttp (que o hostproxy ja importa). Sem pytest, sem plugins.

Uso: python3 tests/test_hostproxy.py
"""
import asyncio
import importlib
import os
import sys
from pathlib import Path

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

TOKEN = "token-de-teste"
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


# ---------------------------------------------------------------------------
# upstream stub — imita o dashboard
# ---------------------------------------------------------------------------
seen = {}


def build_upstream():
    async def ws_handler(request):
        seen["ws_host"] = request.headers.get("Host")
        seen["ws_origin"] = request.headers.get("Origin")
        # o dashboard valida Host (so loopback) e responde 400 em TODA rota
        if not (request.headers.get("Host") or "").startswith("127.0.0.1"):
            return web.json_response({"detail": "Invalid Host header"}, status=400)
        # anti-DNS-rebinding: Origin nao-loopback e recusado no WS
        origin = request.headers.get("Origin")
        if origin is not None and not origin.startswith("http://127.0.0.1"):
            return web.json_response({"detail": "Invalid Origin"}, status=403)
        if request.headers.get("X-Hermes-Session-Token") != TOKEN:
            return web.json_response({"detail": "unauthorized"}, status=401)
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                await ws.send_str("echo:" + msg.data)
            elif msg.type == aiohttp.WSMsgType.BINARY:
                await ws.send_bytes(b"echo:" + msg.data)
            elif msg.type == aiohttp.WSMsgType.ERROR:
                break
        return ws

    async def http_handler(request):
        seen["http_host"] = request.headers.get("Host")
        if not (request.headers.get("Host") or "").startswith("127.0.0.1"):
            return web.json_response({"detail": "Invalid Host header"}, status=400)
        body = await request.read()
        resp = web.Response(status=201, body=b"corpo:" + body,
                            content_type="application/x-custom")
        resp.headers.add("Set-Cookie", "a=1; Path=/")
        resp.headers.add("Set-Cookie", "b=2; Path=/")
        resp.headers.add("X-Marcador", "presente")
        return resp

    app = web.Application()
    app.router.add_route("*", "/api/ws", ws_handler)
    app.router.add_route("*", "/{tail:.*}", http_handler)
    return app


async def main():
    upstream = TestServer(build_upstream())
    await upstream.start_server()

    # o hostproxy le as portas do ambiente no import -> setar ANTES de importar
    os.environ["HERMES_DASHBOARD_PORT"] = str(upstream.port)
    os.environ["HOSTPROXY_UPSTREAM_HOST"] = "127.0.0.1"
    import hostproxy
    importlib.reload(hostproxy)

    papp = web.Application()
    papp.router.add_route("*", "/{tail:.*}", hostproxy.handle)
    proxy = TestServer(papp)
    await proxy.start_server()
    wsbase = f"ws://127.0.0.1:{proxy.port}"
    # Host que o `tailscale serve` repassaria, e que o dashboard recusa com 400
    tailnet_host = "hermes-g2.tail390702.ts.net"

    print("== hostproxy ==")

    # -- T1: WS sem sessao devolve o status REAL, nunca 101 falso ---------------
    async with aiohttp.ClientSession() as s:
        try:
            await s.ws_connect(f"{wsbase}/api/ws", headers={"Host": tailnet_host})
            bad("T1 WS sem sessao nao completa upgrade", "conectou (101 falso)")
        except aiohttp.WSServerHandshakeError as e:
            eq("T1 WS sem sessao reflete 401 do upstream", e.status, 401)
        except Exception as e:  # noqa: BLE001
            bad("T1 WS sem sessao reflete 401 do upstream", repr(e))

    # -- T2: WS com sessao valida conecta e faz pump bidirecional ---------------
    async with aiohttp.ClientSession() as s:
        try:
            async with s.ws_connect(
                f"{wsbase}/api/ws",
                headers={"Host": tailnet_host, "X-Hermes-Session-Token": TOKEN},
            ) as ws:
                ok("T2 WS com sessao valida completa o upgrade")
                await ws.send_str("ping-texto")
                eq("T2 pump de texto", (await ws.receive()).data, "echo:ping-texto")
                await ws.send_bytes(b"ping-bin")
                eq("T2 pump de binario", (await ws.receive()).data, b"echo:ping-bin")
        except Exception as e:  # noqa: BLE001
            bad("T2 WS com sessao valida completa o upgrade", repr(e))

    eq("T2 Host reescrito para loopback no WS",
       (seen.get("ws_host") or "").startswith("127.0.0.1"), True)

    # -- T3: Origin externo reescrito para loopback ----------------------------
    async with aiohttp.ClientSession() as s:
        try:
            async with s.ws_connect(
                f"{wsbase}/api/ws",
                headers={
                    "Host": tailnet_host,
                    "Origin": f"https://{tailnet_host}",
                    "X-Hermes-Session-Token": TOKEN,
                },
            ) as ws:
                ok("T3 WS com Origin externo conecta (rewrite aplicado)")
                await ws.send_str("x")
                await ws.receive()
        except aiohttp.WSServerHandshakeError as e:
            bad("T3 WS com Origin externo conecta (rewrite aplicado)",
                f"upstream recusou com {e.status} -> Origin nao foi reescrito")
        except Exception as e:  # noqa: BLE001
            bad("T3 WS com Origin externo conecta (rewrite aplicado)", repr(e))

    eq("T3 upstream viu Origin loopback",
       (seen.get("ws_origin") or "").startswith("http://127.0.0.1"), True)

    # -- T4: upstream indisponivel -> 502, sem 101 falso -----------------------
    dead = web.Application()
    dead_srv = TestServer(dead)
    await dead_srv.start_server()
    dead_port = dead_srv.port
    await dead_srv.close()  # porta agora fechada

    os.environ["HERMES_DASHBOARD_PORT"] = str(dead_port)
    importlib.reload(hostproxy)
    dapp = web.Application()
    dapp.router.add_route("*", "/{tail:.*}", hostproxy.handle)
    dproxy = TestServer(dapp)
    await dproxy.start_server()

    async with aiohttp.ClientSession() as s:
        try:
            await s.ws_connect(f"ws://127.0.0.1:{dproxy.port}/api/ws",
                               headers={"Host": tailnet_host})
            bad("T4 upstream morto nao vira 101", "conectou (101 falso)")
        except aiohttp.WSServerHandshakeError as e:
            eq("T4 upstream morto vira 502", e.status, 502)
        except Exception as e:  # noqa: BLE001
            bad("T4 upstream morto vira 502", repr(e))
    await dproxy.close()

    # volta o proxy para o upstream vivo
    os.environ["HERMES_DASHBOARD_PORT"] = str(upstream.port)
    importlib.reload(hostproxy)
    happ = web.Application()
    happ.router.add_route("*", "/{tail:.*}", hostproxy.handle)
    hproxy = TestServer(happ)
    await hproxy.start_server()
    hbase = f"http://127.0.0.1:{hproxy.port}"

    # -- T5: HTTP preserva status, corpo e headers -----------------------------
    async with aiohttp.ClientSession() as s:
        async with s.post(f"{hbase}/api/status", data=b"payload",
                          headers={"Host": tailnet_host}) as r:
            eq("T5 status preservado", r.status, 201)
            eq("T5 corpo preservado", await r.read(), b"corpo:payload")
            eq("T5 content-type preservado",
               r.headers.get("Content-Type"), "application/x-custom")
            eq("T5 header custom preservado", r.headers.get("X-Marcador"), "presente")
            cookies = r.headers.getall("Set-Cookie", [])
            eq("T5 multiplos Set-Cookie preservados", len(cookies), 2)

    eq("T5 Host reescrito para loopback no HTTP",
       (seen.get("http_host") or "").startswith("127.0.0.1"), True)

    await hproxy.close()
    await proxy.close()
    await upstream.close()

    print()
    print(f"passou: {PASSED}   falhou: {FAILED}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
