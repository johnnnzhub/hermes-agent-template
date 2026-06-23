#!/usr/bin/env python3
# hostproxy.py — reverse proxy loopback com Host-rewrite (HTTP + WebSocket).
#
# Por que existe: o `hermes dashboard` escuta em 127.0.0.1:9119 e VALIDA o header
# Host (hermes_cli/web_server.py::_is_accepted_host) — so aceita loopback. O
# `tailscale serve` repassa "Host: hermes-g2.tail390702.ts.net" -> o dashboard
# responde 400 {"detail":"Invalid Host header..."} em TODA rota (inclusive
# /api/status e o WebSocket /api/ws), o que impede o Hermes Desktop de conectar.
#
# Este proxy escuta SO em loopback (127.0.0.1:HOSTPROXY_PORT), reescreve o Host
# para o do upstream (127.0.0.1:9119) e encaminha HTTP e WebSocket. O
# `tailscale serve` passa a apontar para este proxy em vez do dashboard direto.
#
# Seguranca: escuta apenas em loopback -> alcancavel so via `tailscale serve`
# (tailnet) e pelo proprio loopback; nunca exposto publicamente (a 9119/9200 nao
# sao roteadas pelo Railway, que so publica $PORT). NAO altera o dashboard nem o
# server.py — e um componente aditivo, removido ao reverter o hermes-boot.sh.
import os
import asyncio
import aiohttp
from aiohttp import web

UPSTREAM_HOST = os.environ.get("HOSTPROXY_UPSTREAM_HOST", "127.0.0.1")
UPSTREAM_PORT = int(os.environ.get("HERMES_DASHBOARD_PORT", "9119"))
LISTEN_HOST = os.environ.get("HOSTPROXY_LISTEN_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("HOSTPROXY_PORT", "9200"))

UPSTREAM_HTTP = f"http://{UPSTREAM_HOST}:{UPSTREAM_PORT}"
UPSTREAM_WS = f"ws://{UPSTREAM_HOST}:{UPSTREAM_PORT}"

# Hop-by-hop headers (RFC 7230 6.1) nao devem ser repassados por um proxy.
HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
}


def _forward_headers(headers):
    # Remove hop-by-hop + Host. Omitir o Host faz o aiohttp definir o Host do
    # destino (127.0.0.1:9119), que e o que o dashboard aceita — esse e o
    # host-rewrite. Mantem cookie/authorization/etc.
    return {k: v for k, v in headers.items()
            if k.lower() not in HOP and k.lower() != "host"}


async def _proxy_ws(request):
    ws_server = web.WebSocketResponse()
    await ws_server.prepare(request)
    target = f"{UPSTREAM_WS}{request.rel_url.raw_path_qs}"
    # Tira os headers de handshake que o aiohttp regenera no ws_connect.
    hdrs = {k: v for k, v in _forward_headers(request.headers).items()
            if not k.lower().startswith("sec-websocket")}
    session = aiohttp.ClientSession()
    try:
        async with session.ws_connect(target, headers=hdrs, max_msg_size=0,
                                      autoping=True, heartbeat=None) as up:
            async def pump(src, dst):
                async for msg in src:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        await dst.send_str(msg.data)
                    elif msg.type == aiohttp.WSMsgType.BINARY:
                        await dst.send_bytes(msg.data)
                    elif msg.type == aiohttp.WSMsgType.PING:
                        await dst.ping(msg.data)
                    elif msg.type == aiohttp.WSMsgType.PONG:
                        await dst.pong(msg.data)
                    else:  # CLOSE / CLOSING / CLOSED / ERROR
                        break

            t1 = asyncio.create_task(pump(up, ws_server))
            t2 = asyncio.create_task(pump(ws_server, up))
            done, pending = await asyncio.wait(
                {t1, t2}, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
    except Exception as e:
        print(f"[hostproxy] ws error {request.path}: {e!r}", flush=True)
    finally:
        await session.close()
        if not ws_server.closed:
            await ws_server.close()
    return ws_server


async def _proxy_http(request):
    target = f"{UPSTREAM_HTTP}{request.rel_url.raw_path_qs}"
    body = await request.read()
    try:
        # auto_decompress=False: repassa o corpo exatamente como veio (mantemos
        # o content-encoding do upstream e nunca recomprimimos).
        async with aiohttp.ClientSession(auto_decompress=False) as sess:
            async with sess.request(
                request.method, target,
                headers=_forward_headers(request.headers),
                data=body if body else None,
                allow_redirects=False,
            ) as resp:
                payload = await resp.read()
                out = web.Response(status=resp.status, body=payload)
                # web.Response(body=...) ja definiu Content-Type/Content-Length;
                # remove os defaults e copia os reais do upstream (preservando
                # multiplos Set-Cookie via .add). Content-Length recomputado do
                # corpo; transfer-encoding/hop descartados.
                out.headers.popall("Content-Type", None)
                for k, v in resp.headers.items():
                    kl = k.lower()
                    if kl in HOP or kl == "content-length":
                        continue
                    out.headers.add(k, v)
                return out
    except aiohttp.ClientError as e:
        print(f"[hostproxy] upstream error {request.method} {request.path}: {e!r}",
              flush=True)
        return web.Response(status=502, text="hostproxy: upstream unavailable")


async def handle(request):
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return await _proxy_ws(request)
    return await _proxy_http(request)


def main():
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", handle)
    print(f"[hostproxy] listening {LISTEN_HOST}:{LISTEN_PORT} -> {UPSTREAM_HTTP} "
          f"(Host rewritten to {UPSTREAM_HOST}:{UPSTREAM_PORT})", flush=True)
    web.run_app(app, host=LISTEN_HOST, port=LISTEN_PORT)


if __name__ == "__main__":
    main()
