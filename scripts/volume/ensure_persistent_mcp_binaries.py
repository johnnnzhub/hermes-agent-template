#!/usr/bin/env python3
"""Point Notion and Perplexity MCPs at exact persistent Node entrypoints."""

from __future__ import annotations

import json
import os
import stat
import tempfile
from pathlib import Path

from ruamel.yaml import YAML

PREFIX = Path('/data/.hermes/mcp-node/node_modules')
SERVERS = {
    'notion': {
        'package': PREFIX / '@notionhq/notion-mcp-server/package.json',
        'version': '2.4.1',
        'entry': PREFIX / '@notionhq/notion-mcp-server/bin/cli.mjs',
    },
    'perplexity': {
        'package': PREFIX / '@perplexity-ai/mcp-server/package.json',
        'version': '0.9.0',
        'entry': PREFIX / '@perplexity-ai/mcp-server/dist/index.js',
    },
}
DEFAULT_CONFIGS = [
    Path('/app/deploy-config.yaml'),
    Path('/data/.hermes/config.yaml'),
    Path('/data/.hermes/profiles/foxy/config.yaml'),
]


def config_paths() -> list[Path]:
    raw = os.environ.get('IRIS_MCP_CONFIG_PATHS')
    return [Path(item) for item in raw.split(':') if item] if raw else DEFAULT_CONFIGS


def validate_packages() -> None:
    for name, spec in SERVERS.items():
        package = json.loads(spec['package'].read_text(encoding='utf-8'))
        if package.get('version') != spec['version']:
            raise SystemExit(
                f"{name} version mismatch: expected={spec['version']} actual={package.get('version')}"
            )
        if not spec['entry'].is_file():
            raise SystemExit(f"{name} entrypoint missing: {spec['entry']}")


def atomic_yaml_write(path: Path, data: object, yaml: YAML) -> None:
    current = path.stat()
    with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent, delete=False) as handle:
        yaml.dump(data, handle)
        tmp = Path(handle.name)
    try:
        os.chmod(tmp, stat.S_IMODE(current.st_mode))
        try:
            os.chown(tmp, current.st_uid, current.st_gid)
        except PermissionError:
            pass
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def patch_config(path: Path, yaml: YAML) -> list[str]:
    if not path.is_file():
        return []
    data = yaml.load(path.read_text(encoding='utf-8')) or {}
    configured = data.get('mcp_servers') or {}
    changed: list[str] = []
    for name, spec in SERVERS.items():
        server = configured.get(name)
        if not isinstance(server, dict):
            continue
        command = '/usr/bin/node'
        args = [str(spec['entry'])]
        env = server.setdefault('env', {})
        if not isinstance(env, dict):
            raise SystemExit(f"{path}: mcp_servers.{name}.env must be a mapping")
        desired_env = {
            'MALLOC_ARENA_MAX': '2',
            'MALLOC_TRIM_THRESHOLD_': '131072',
        }
        needs_change = server.get('command') != command or list(server.get('args') or []) != args
        needs_change = needs_change or any(str(env.get(key, '')) != value for key, value in desired_env.items())
        if not needs_change:
            continue
        server['command'] = command
        server['args'] = args
        for key, value in desired_env.items():
            env[key] = value
        changed.append(name)
    if changed:
        atomic_yaml_write(path, data, yaml)
    return changed


def main() -> int:
    validate_packages()
    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.width = 1000
    for path in config_paths():
        changed = patch_config(path, yaml)
        state = ','.join(changed) if changed else 'unchanged'
        print(f'persistent-mcp config={path} changed={state}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
