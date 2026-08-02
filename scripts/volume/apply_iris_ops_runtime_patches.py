#!/usr/bin/env python3
from pathlib import Path

import os
# Raizes parametrizaveis: sem isso este patcher so roda dentro do container, que
# e exatamente onde nao se quer descobrir que ele parou de casar com o upstream.
# Com elas, o harness aponta para copias descartaveis de 0.18.2 e 0.19.1 e mede
# efeito real -- arquivos alterados, idempotencia, sintaxe, pos-condicao.
CORE = Path(os.environ.get("IRIS_CORE_ROOT", "/opt/hermes-agent"))
APP = Path(os.environ.get("IRIS_APP_ROOT", "/app"))

# Keep cron deliveries clean by default even if config cannot be read during startup.
config_py = CORE / 'hermes_cli/config.py'
if config_py.exists():
    text = config_py.read_text()
    text2 = text.replace('"wrap_response": True', '"wrap_response": False')
    if '"suppress_notices"' not in text2:
        text2 = text2.replace('"codex_gpt55_autoraise": True,', '"codex_gpt55_autoraise": True,\n        "suppress_notices": True,')
    if text2 != text:
        config_py.write_text(text2)
        print('patched Hermes config defaults')

scheduler = CORE / 'cron/scheduler.py'
if scheduler.exists():
    text = scheduler.read_text()
    text2 = text.replace('    wrap_response = True\n', '    wrap_response = False\n')
    text2 = text2.replace('        wrap_response = user_cfg.get("cron", {}).get("wrap_response", True)\n', '        wrap_response = user_cfg.get("cron", {}).get("wrap_response", False)\n')
    text2 = text2.replace('get("wrap_response", True)', 'get("wrap_response", False)')
    if text2 != text:
        scheduler.write_text(text2)
        print('patched cron scheduler wrap_response default false')

# Belt-and-suspenders: if a future config misses the key, don't replay the Codex notice.
agent_init = CORE / 'agent/agent_init.py'
if agent_init.exists():
    text = agent_init.read_text()
    text2 = text
    # Do not disable Codex gpt-5.5 autoraise. It preserves usable context. Notices are
    # suppressed separately via compression.suppress_notices.
    if 'compression_suppress_notices = is_truthy_value(' not in text2:
        text2 = text2.replace(
            '    agent._compression_threshold_autoraised = None\n',
            '    compression_suppress_notices = is_truthy_value(\n'
            '        _compression_cfg.get("suppress_notices"), default=False\n'
            '    )\n'
            '    agent.compression_suppress_notices = compression_suppress_notices\n'
            '    agent._compression_threshold_autoraised = None\n',
            1,
        )
    text2 = text2.replace(
        'if _autoraise and compression_enabled:\n        print(_build_codex_gpt55_autoraise_notice(_autoraise))',
        'if _autoraise and compression_enabled and not getattr(agent, "compression_suppress_notices", False):\n        print(_build_codex_gpt55_autoraise_notice(_autoraise))',
    )
    text2 = text2.replace(
        'if _autoraise and compression_enabled:\n        agent._compression_warning = _build_codex_gpt55_autoraise_notice(_autoraise)',
        'if _autoraise and compression_enabled and not getattr(agent, "compression_suppress_notices", False):\n        agent._compression_warning = _build_codex_gpt55_autoraise_notice(_autoraise)',
    )
    if text2 != text:
        agent_init.write_text(text2)
        print('patched Codex gpt55 notice suppression')

conversation_compression = CORE / 'agent/conversation_compression.py'
if conversation_compression.exists():
    text = conversation_compression.read_text()
    text2 = text
    if 'def _compression_notices_suppressed(agent: Any) -> bool:' not in text2:
        text2 = text2.replace(
            'logger = logging.getLogger(__name__)\n',
            'logger = logging.getLogger(__name__)\n\n'
            'def _compression_notices_suppressed(agent: Any) -> bool:\n'
            '    return bool(getattr(agent, "compression_suppress_notices", False))\n',
            1,
        )
    text2 = text2.replace(
        '    msg = getattr(agent, "_compression_warning", None)\n    if msg:',
        '    if _compression_notices_suppressed(agent):\n        return\n    msg = getattr(agent, "_compression_warning", None)\n    if msg:',
    )
    text2 = text2.replace(
        '            agent._compression_warning = msg\n            agent._emit_status(msg)',
        '            if not _compression_notices_suppressed(agent):\n                agent._compression_warning = msg\n                agent._emit_status(msg)',
    )
    text2 = text2.replace(
        '        agent._compression_warning = msg\n        agent._emit_status(msg)',
        '        if not _compression_notices_suppressed(agent):\n            agent._compression_warning = msg\n            agent._emit_status(msg)',
    )
    text2 = text2.replace(
        '            agent._compression_warning = _cc_msg\n            agent._emit_status(_cc_msg)',
        '            if not _compression_notices_suppressed(agent):\n                agent._compression_warning = _cc_msg\n                agent._emit_status(_cc_msg)',
    )
    if text2 != text:
        conversation_compression.write_text(text2)
        print('patched compression notice suppression')

# Keep the Railway admin server aligned with Iris ops preferences and the G2 API.
server = APP / 'server.py'
if server.exists():
    text = server.read_text()
    changed = False

    config_needle = '    merged["data_dir"] = HERMES_HOME\n\n    # Custom OpenAI-compatible endpoint'
    config_insert = '''    merged["data_dir"] = HERMES_HOME

    # Iris/John deployment defaults: keep operator-facing technical wrappers silent
    # even if the admin setup flow rewrites config.yaml after a gateway restart.
    merged_compression = dict(merged.get("compression") if isinstance(merged.get("compression"), dict) else {})
    merged_compression.setdefault("enabled", True)
    merged_compression.setdefault("threshold", 0.50)
    merged_compression["codex_gpt55_autoraise"] = True
    merged_compression["suppress_notices"] = True
    merged_compression.setdefault("in_place", True)
    merged["compression"] = merged_compression

    merged_cron = dict(merged.get("cron") if isinstance(merged.get("cron"), dict) else {})
    merged_cron["wrap_response"] = False
    merged["cron"] = merged_cron

    # Custom OpenAI-compatible endpoint'''
    if config_needle in text and 'Iris/John deployment defaults' not in text:
        text = text.replace(config_needle, config_insert, 1)
        changed = True

    cors_old = '''_GLASS_CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
}


async def route_glass_tasks(request: Request) -> Response:
'''
    cors_new = '''_GLASS_CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
}


async def route_glass_health(request: Request) -> Response:
    if request.method == "OPTIONS":
        return Response(status_code=204, headers=_GLASS_CORS)
    return JSONResponse({
        "ok": True,
        "service": "iris-glass",
        "glass_token_configured": bool(GLASS_TOKEN),
        "tasks_configured": bool(G2_TASKS_TOKEN),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }, headers=_GLASS_CORS)


def _glass_authorized(request: Request) -> bool:
    auth = request.headers.get("authorization", "")
    return bool(GLASS_TOKEN) and _hmac.compare_digest(auth, f"Bearer {GLASS_TOKEN}")


async def route_glass_intent(request: Request) -> Response:
    if request.method == "OPTIONS":
        return Response(status_code=204, headers=_GLASS_CORS)
    if not GLASS_TOKEN:
        return JSONResponse({"ok": False, "error": "glass API disabled — GLASS_TOKEN not configured"}, status_code=503, headers=_GLASS_CORS)
    if not _glass_authorized(request):
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401, headers=_GLASS_CORS)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    transcript = str(payload.get("transcript") or payload.get("text") or "").strip().lower()
    if any(term in transcript for term in ("tarefa", "tarefas", "task", "tasks", "listar", "lista")):
        return await route_glass_tasks(request)
    return JSONResponse({
        "ok": True,
        "action": "noop",
        "glass_short": "Iris conectada. Peça: listar tarefas.",
        "text": "Iris conectada. Peça: listar tarefas.",
    }, headers=_GLASS_CORS)


async def route_glass_tasks(request: Request) -> Response:
'''
    if cors_old in text and 'async def route_glass_health' not in text:
        text = text.replace(cors_old, cors_new, 1)
        changed = True

    auth_block = '''    if not GLASS_TOKEN or not G2_TASKS_TOKEN:
        return JSONResponse(
            {"ok": False, "error": "glass API disabled — GLASS_TOKEN/G2_TASKS_TOKEN not configured"},
            status_code=503,
            headers=_GLASS_CORS,
        )
    auth = request.headers.get("authorization", "")
    if not _hmac.compare_digest(auth, f"Bearer {GLASS_TOKEN}"):
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401, headers=_GLASS_CORS)
'''
    auth_new = '''    if not GLASS_TOKEN or not G2_TASKS_TOKEN:
        return JSONResponse(
            {"ok": False, "error": "glass API disabled — GLASS_TOKEN/G2_TASKS_TOKEN not configured"},
            status_code=503,
            headers=_GLASS_CORS,
        )
    if not _glass_authorized(request):
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401, headers=_GLASS_CORS)
'''
    # Atomico e de uma vez so. Duas coisas estavam erradas aqui:
    #
    # 1. A substituicao rodava sem exigir que _glass_authorized existisse. A
    #    definicao so entra junto com cors_new, acima, e cors_old parou de casar
    #    quando o _GLASS_CORS do server.py ganhou "GET,POST,OPTIONS". Resultado:
    #    o arquivo ficava com a CHAMADA e sem a FUNCAO -> NameError -> GET
    #    /glass/tasks respondendo 500 em producao de 2026-07-13 a 2026-08-02.
    #
    # 2. Substituia UMA ocorrencia por execucao. Como isto roda a cada boot, o
    #    segundo boot convertia a segunda rota e o arquivo mudava de novo --
    #    nao-idempotente, e cada passagem espalhava mais uma chamada sem
    #    definicao. Reproduzido do zero contra a arvore limpa: passagem 1
    #    deixava a chamada na linha 1645, passagem 2 acrescentava a 1701, e
    #    nenhuma das duas tinha a definicao.
    #
    # Agora: so troca se a funcao existir (ja no arquivo ou inserida por
    # cors_new nesta mesma execucao), e troca todas as ocorrencias juntas.
    tem_definicao = 'def _glass_authorized(' in text
    if auth_block in text and tem_definicao:
        text = text.replace(auth_block, auth_new)
        changed = True
    elif auth_block in text:
        print(
            'glass auth: _glass_authorized ausente, substituicao NAO aplicada '
            '(trocar aqui produziria NameError em runtime)'
        )

    route_needle = '    Route("/glass/tasks",                       route_glass_tasks,   methods=["GET", "OPTIONS"]),\n'
    route_insert = '    Route("/glass/health",                      route_glass_health,  methods=["GET", "OPTIONS"]),\n    Route("/glass/tasks",                       route_glass_tasks,   methods=["GET", "OPTIONS"]),\n    Route("/glass/intent",                      route_glass_intent,  methods=["POST", "OPTIONS"]),\n'
    if 'async def route_glass_health' in text and 'Route("/glass/health"' not in text and route_needle in text:
        text = text.replace(route_needle, route_insert, 1)
        changed = True

    # A stale drain task from a gateway restart used to set gw.state="error"
    # after a new child had started. Bind every drain to its own subprocess.
    drain_start_old = '            asyncio.create_task(self._drain())\n'
    drain_start_new = '            asyncio.create_task(self._drain(self.proc))\n'
    drain_def_old = '    async def _drain(self):\n        assert self.proc and self.proc.stdout\n        async for raw in self.proc.stdout:\n'
    drain_def_new = '    async def _drain(self, proc):\n        assert proc and proc.stdout\n        async for raw in proc.stdout:\n'
    drain_exit_old = '        if self.state == "running":\n            self.state = "error"\n            self.logs.append(f"[error] Gateway exited (code {self.proc.returncode})")\n'
    drain_exit_new = '        if self.proc is proc and self.state == "running":\n            self.state = "error"\n            self.logs.append(f"[error] Gateway exited (code {proc.returncode})")\n'
    if drain_start_old in text and drain_def_old in text and drain_exit_old in text:
        text = text.replace(drain_start_old, drain_start_new, 1)
        text = text.replace(drain_def_old, drain_def_new, 1)
        text = text.replace(drain_exit_old, drain_exit_new, 1)
        changed = True

    if changed:
        # Pos-condicao: falhar FECHADO. Este patcher ja gravou uma vez um
        # server.py que compilava e quebrava em runtime; sintaxe valida nao
        # basta como criterio. Nenhuma chamada pode apontar para nome que o
        # modulo nao define.
        import ast as _ast
        import builtins as _builtins

        _arvore = _ast.parse(text)
        _definidos = {
            n.name for n in _ast.walk(_arvore)
            if isinstance(n, (_ast.FunctionDef, _ast.AsyncFunctionDef, _ast.ClassDef))
        }
        for _n in _ast.walk(_arvore):
            if isinstance(_n, _ast.Import):
                _definidos.update(a.asname or a.name.split('.')[0] for a in _n.names)
            elif isinstance(_n, _ast.ImportFrom):
                _definidos.update(a.asname or a.name for a in _n.names)
            elif isinstance(_n, _ast.Name) and isinstance(_n.ctx, (_ast.Store, _ast.Del)):
                _definidos.add(_n.id)
            elif isinstance(_n, _ast.arg):
                _definidos.add(_n.arg)
            elif isinstance(_n, _ast.Global):
                _definidos.update(_n.names)
        _conhecidos = _definidos | set(dir(_builtins))
        _orfas = sorted({
            (_n.lineno, _n.func.id) for _n in _ast.walk(_arvore)
            if isinstance(_n, _ast.Call) and isinstance(_n.func, _ast.Name)
            and _n.func.id not in _conhecidos
        })
        if _orfas:
            raise RuntimeError(
                'server patch abortado, chamada a nome nao definido: '
                + ', '.join(f'{nome} (linha {linha})' for linha, nome in _orfas)
            )
        server.write_text(text)
        print('patched Railway server Iris ops/G2 routes')

# Codex supports max through Hermes' transport mapping. Do not enable ultra:
# a live Codex canary returned HTTP 400 for reasoning.effort=ultra.
reasoning_patches = {
    CORE / 'hermes_constants.py': [
        (
            'VALID_REASONING_EFFORTS = ("minimal", "low", "medium", "high", "xhigh", "max")',
            'VALID_REASONING_EFFORTS = ("minimal", "low", "medium", "high", "xhigh", "max")',
        ),
        (
            'Valid levels: "none", "minimal", "low", "medium", "high", "xhigh", "max".',
            'Valid levels: "none", "minimal", "low", "medium", "high", "xhigh", "max".',
        ),
    ],
    CORE / 'gateway/run.py': [
        (
            '"minimal", "low", "medium", "high", "xhigh", "max". Returns None to use',
            '"minimal", "low", "medium", "high", "xhigh", "max". Returns None to use',
        ),
    ],
    CORE / 'gateway/slash_commands.py': [
        (
            'elif effort in {"minimal", "low", "medium", "high", "xhigh"}:',
            'elif effort in {"minimal", "low", "medium", "high", "xhigh", "max"}:',
        ),
    ],
    CORE / 'hermes_cli/cli_commands_mixin.py': [
        (
            'Set reasoning effort (none, minimal, low, medium, high, xhigh)',
            'Set reasoning effort (none, minimal, low, medium, high, xhigh, max)',
        ),
        (
            '<none|minimal|low|medium|high|xhigh|show|hide|full|clamp>',
            '<none|minimal|low|medium|high|xhigh|max|show|hide|full|clamp>',
        ),
    ],
    CORE / 'batch_runner.py': [
        (
            '["none", "minimal", "low", "medium", "high", "xhigh", "max"]',
            '["none", "minimal", "low", "medium", "high", "xhigh", "max"]',
        ),
    ],
    CORE / 'hermes_cli/config.py': [
        (
            '# reasoning effort for subagents: "xhigh", "high", "medium",',
            '# reasoning effort for subagents: "max", "xhigh", "high", "medium",',
        ),
    ],
}

for patch_path, replacements in reasoning_patches.items():
    if not patch_path.exists():
        continue
    before = patch_path.read_text()
    after = before
    for old, new in replacements:
        after = after.replace(old, new)
    if after != before:
        patch_path.write_text(after)
        print(f'patched GPT-5.6 reasoning compatibility: {patch_path}')

# Normalize any earlier Iris ultra forward-compat patch back to the actual Codex
# contract. Keep max, which Hermes transports successfully for this provider.
unsupported_ultra_replacements = {
    '"xhigh", "max", "ultra")': '"xhigh", "max")',
    '"xhigh", "max", "ultra". Returns None to use': '"xhigh", "max". Returns None to use',
    '"xhigh", "max", "ultra"}': '"xhigh", "max"}',
    'xhigh, max, ultra': 'xhigh, max',
    'xhigh|max|ultra': 'xhigh|max',
    '"ultra", "max", "xhigh", "high", "medium",': '"max", "xhigh", "high", "medium",',
    '["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]': '["none", "minimal", "low", "medium", "high", "xhigh", "max"]',
}
for patch_path in reasoning_patches:
    if not patch_path.exists():
        continue
    before = patch_path.read_text()
    after = before
    for old, new in unsupported_ultra_replacements.items():
        after = after.replace(old, new)
    while 'xhigh, max, max' in after:
        after = after.replace('xhigh, max, max', 'xhigh, max')
    while 'xhigh|max|max' in after:
        after = after.replace('xhigh|max|max', 'xhigh|max')
    if after != before:
        patch_path.write_text(after)
        print(f'removed unsupported ultra reasoning: {patch_path}')
