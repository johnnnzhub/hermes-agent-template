#!/usr/bin/env python3
"""Focused tests for the feature-flagged G2 Terminal runtime integration."""

from __future__ import annotations

import asyncio
import ast
import json
import os
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("ADMIN_PASSWORD", "terminal-runtime-test-only")
sys.path.insert(0, str(ROOT))

try:
    import server  # type: ignore  # noqa: E402
    FULL_SERVER_IMPORTED = True
except ModuleNotFoundError:
    # The production image installs requirements.txt. A bare macOS system
    # Python may not have Starlette/websockets, so load the manager class alone
    # and still exercise its real source rather than replacing it with a mock.
    tree = ast.parse((ROOT / "server.py").read_text())
    class_node = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "TerminalModeSidecar"
    )
    isolated = ast.Module(body=[class_node], type_ignores=[])
    namespace = {
        "asyncio": asyncio,
        "os": os,
        "time": time,
        "Path": Path,
        "HERMES_HOME": str(ROOT / ".test-hermes"),
        "IRIS_TERMINAL_ENABLED": False,
        "IRIS_TERMINAL_HOST": "127.0.0.1",
        "IRIS_TERMINAL_PORT": 3456,
        "IRIS_TERMINAL_ENTRYPOINT": ROOT / "terminal-mode" / "src" / "server.mjs",
    }
    exec(compile(isolated, str(ROOT / "server.py"), "exec"), namespace)
    server = types.SimpleNamespace(
        TerminalModeSidecar=namespace["TerminalModeSidecar"],
    )
    FULL_SERVER_IMPORTED = False


async def wait_until(predicate, timeout: float = 2.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("condition did not become true before timeout")
        await asyncio.sleep(0.01)


class TerminalSidecarTests(unittest.IsolatedAsyncioTestCase):
    async def test_flag_off_is_a_process_noop(self) -> None:
        sidecar = server.TerminalModeSidecar(
            enabled=False,
            command=(sys.executable, "-c", "raise SystemExit(99)"),
            working_dir=ROOT,
        )
        await sidecar.start()
        self.assertEqual(sidecar.state, "disabled")
        self.assertIsNone(sidecar.proc)
        self.assertEqual(sidecar.restarts, 0)
        await sidecar.stop()
        self.assertEqual(sidecar.state, "disabled")

    async def test_enabled_child_is_loopback_only_and_stops_cleanly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            observation = Path(tmp) / "bind.json"
            code = (
                "import json,os,pathlib,time;"
                "pathlib.Path(os.environ['TEST_OBSERVATION']).write_text("
                "json.dumps({'host':os.environ['IRIS_TERMINAL_HOST'],"
                "'port':os.environ['IRIS_TERMINAL_PORT']}));"
                "time.sleep(30)"
            )
            sidecar = server.TerminalModeSidecar(
                enabled=True,
                host="0.0.0.0",
                port=3456,
                command=(sys.executable, "-c", code),
                working_dir=ROOT,
            )
            with patch.dict(
                os.environ,
                {
                    "IRIS_TERMINAL_TOKEN": "test-token-not-a-secret",
                    "TEST_OBSERVATION": str(observation),
                },
            ):
                await sidecar.start()
                proc = sidecar.proc
                self.assertIsNotNone(proc)
                await wait_until(observation.exists)
                self.assertEqual(
                    json.loads(observation.read_text()),
                    {"host": "127.0.0.1", "port": "3456"},
                )
                self.assertEqual(sidecar.status()["state"], "running")
                await sidecar.stop()

            self.assertEqual(sidecar.state, "stopped")
            self.assertIsNone(sidecar.proc)
            self.assertIsNotNone(proc.returncode)

    async def test_crash_restart_budget_is_bounded(self) -> None:
        sidecar = server.TerminalModeSidecar(
            enabled=True,
            command=(sys.executable, "-c", "raise SystemExit(7)"),
            working_dir=ROOT,
            max_restarts=2,
            restart_delays=(0.01,),
        )
        with patch.dict(
            os.environ,
            {"IRIS_TERMINAL_TOKEN": "test-token-not-a-secret"},
        ):
            await sidecar.start()
            await wait_until(lambda: sidecar.state == "failed")
        self.assertEqual(sidecar.restarts, 2)
        self.assertIsNone(sidecar.proc)
        await sidecar.stop()

    async def test_missing_token_fails_closed_without_spawning(self) -> None:
        sidecar = server.TerminalModeSidecar(
            enabled=True,
            command=(sys.executable, "-c", "raise SystemExit(99)"),
            working_dir=ROOT,
        )
        with patch.dict(os.environ, {}, clear=False):
            old = os.environ.pop("IRIS_TERMINAL_TOKEN", None)
            try:
                await sidecar.start()
            finally:
                if old is not None:
                    os.environ["IRIS_TERMINAL_TOKEN"] = old
        self.assertEqual(sidecar.state, "error")
        self.assertIsNone(sidecar.proc)

    async def test_invalid_port_fails_closed_without_spawning(self) -> None:
        sidecar = server.TerminalModeSidecar(
            enabled=True,
            port=70000,
            command=(sys.executable, "-c", "raise SystemExit(99)"),
            working_dir=ROOT,
        )
        with patch.dict(
            os.environ,
            {"IRIS_TERMINAL_TOKEN": "test-token-not-a-secret"},
        ):
            await sidecar.start()
        self.assertEqual(sidecar.state, "error")
        self.assertIsNone(sidecar.proc)

    async def test_public_health_response_is_unchanged(self) -> None:
        if not FULL_SERVER_IMPORTED:
            self.skipTest("full runtime dependencies are not installed")
        response = await server.route_health(None)
        payload = json.loads(response.body)
        self.assertEqual(
            payload,
            {"status": "ok", "gateway": server.gw.state},
        )

    async def test_authenticated_status_has_safe_terminal_state(self) -> None:
        if not FULL_SERVER_IMPORTED:
            self.skipTest("full runtime dependencies are not installed")
        with (
            patch.object(server, "guard", return_value=None),
            patch.object(server, "read_env", return_value={}),
        ):
            response = await server.api_status(object())
        payload = json.loads(response.body)
        self.assertEqual(
            set(payload["terminal"]),
            {"enabled", "state", "uptime", "restarts"},
        )
        self.assertNotIn("token", json.dumps(payload).lower())

    def test_terminal_sidecar_has_no_public_starlette_route(self) -> None:
        if not FULL_SERVER_IMPORTED:
            source = (ROOT / "server.py").read_text()
            self.assertNotIn('Route("/healthz"', source)
            self.assertNotIn('Route("/terminal', source)
            return
        concrete_paths = {
            route.path
            for route in server.routes
            if getattr(route, "path", None) != "/{path:path}"
        }
        self.assertNotIn("/healthz", concrete_paths)
        self.assertFalse(any(path.startswith("/terminal") for path in concrete_paths))


class TailscaleServeTests(unittest.TestCase):
    def run_boot_route_hook(
        self,
        *,
        enabled: bool,
        health_ready: bool,
        ts_port: str = "8443",
        terminal_serve_ok: bool = True,
    ) -> tuple[subprocess.CompletedProcess[str], str]:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            bin_dir = tmp_path / "bin"
            bin_dir.mkdir()
            call_log = tmp_path / "tailscale.log"

            tailscale = bin_dir / "tailscale"
            tailscale.write_text(
                "#!/bin/sh\n"
                "printf '%s\\n' \"$*\" >> \"$TS_CALL_LOG\"\n"
                "case \"$*\" in\n"
                "  *\"serve --bg --https=${IRIS_TERMINAL_TS_PORT:-8443}\"*)\n"
                "    [ \"${MOCK_TERMINAL_SERVE_OK:-1}\" = 1 ] || exit 1;;\n"
                "esac\n"
                "exit 0\n"
            )
            tailscale.chmod(0o755)

            curl = bin_dir / "curl"
            curl.write_text(
                "#!/bin/sh\n"
                "[ \"${MOCK_HEALTH_READY:-0}\" = 1 ] && exit 0\n"
                "exit 22\n"
            )
            curl.chmod(0o755)

            env = {
                **os.environ,
                "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
                "HERMES_BOOT_TEST_SERVE_ONLY": "1",
                "IRIS_TERMINAL_ENABLED": "1" if enabled else "0",
                "IRIS_TERMINAL_TS_PORT": ts_port,
                "IRIS_TERMINAL_READY_ATTEMPTS": "1",
                "IRIS_TERMINAL_READY_DELAY": "0",
                "MOCK_HEALTH_READY": "1" if health_ready else "0",
                "MOCK_TERMINAL_SERVE_OK": "1" if terminal_serve_ok else "0",
                "TS_CALL_LOG": str(call_log),
            }
            result = subprocess.run(
                ["bash", str(ROOT / "hermes-boot.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                timeout=5,
                check=False,
            )
            calls = call_log.read_text() if call_log.exists() else ""
            return result, calls

    def test_enabled_route_preserves_443_and_adds_8443(self) -> None:
        result, calls = self.run_boot_route_hook(
            enabled=True,
            health_ready=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            "serve --bg --https=443 http://127.0.0.1:9200",
            calls,
        )
        self.assertIn("funnel --https=8443 off", calls)
        self.assertIn(
            "serve --bg --https=8443 http://127.0.0.1:3456",
            calls,
        )
        self.assertNotIn("serve --https=8443 off", calls)

    def test_disabled_route_explicitly_removes_8443(self) -> None:
        result, calls = self.run_boot_route_hook(
            enabled=False,
            health_ready=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            "serve --bg --https=443 http://127.0.0.1:9200",
            calls,
        )
        self.assertIn("funnel --https=8443 off", calls)
        self.assertIn("serve --https=8443 off", calls)
        self.assertNotIn("serve --bg --https=8443", calls)

    def test_unready_enabled_route_removes_stale_listener(self) -> None:
        result, calls = self.run_boot_route_hook(
            enabled=True,
            health_ready=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("serve --https=8443 off", calls)
        self.assertNotIn("serve --bg --https=8443", calls)

    def test_rejected_terminal_listener_is_rolled_back(self) -> None:
        result, calls = self.run_boot_route_hook(
            enabled=True,
            health_ready=True,
            terminal_serve_ok=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("serve --bg --https=8443", calls)
        self.assertIn("serve --https=8443 off", calls)

    def test_invalid_terminal_port_removes_default_without_touching_443(self) -> None:
        for bad_port in ("443", "not-a-port"):
            with self.subTest(port=bad_port):
                result, calls = self.run_boot_route_hook(
                    enabled=False,
                    health_ready=True,
                    ts_port=bad_port,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(
                    "serve --bg --https=443 http://127.0.0.1:9200",
                    calls,
                )
                self.assertIn("funnel --https=8443 off", calls)
                self.assertIn("serve --https=8443 off", calls)
                self.assertNotIn("serve --https=443 off", calls)


class DockerContractTests(unittest.TestCase):
    def test_terminal_dependencies_are_verified_then_pruned_in_one_layer(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text()
        self.assertIn(
            "COPY terminal-mode/package.json terminal-mode/package-lock.json "
            "terminal-mode/UPSTREAM.md terminal-mode/upstream-lock.json",
            dockerfile,
        )
        self.assertIn(
            "COPY terminal-mode/scripts/verify-upstream.mjs "
            "/app/terminal-mode/scripts/verify-upstream.mjs",
            dockerfile,
        )

        run_start = dockerfile.index("RUN cd /app/terminal-mode")
        source_copy = dockerfile.index(
            "COPY terminal-mode/src/ /app/terminal-mode/src/"
        )
        install_layer = dockerfile[run_start:source_copy]
        self.assertEqual(install_layer.count("\nRUN "), 0)
        self.assertIn("npm ci --no-audit --no-fund", install_layer)
        self.assertIn("npm run verify:upstream", install_layer)
        self.assertIn(
            "npm prune --omit=dev --no-audit --no-fund",
            install_layer,
        )
        self.assertLess(
            install_layer.index("npm ci --no-audit --no-fund"),
            install_layer.index("npm run verify:upstream"),
        )
        self.assertLess(
            install_layer.index("npm run verify:upstream"),
            install_layer.index("npm prune --omit=dev"),
        )
        self.assertIn("COPY terminal-mode/src/ /app/terminal-mode/src/", dockerfile)


if __name__ == "__main__":
    unittest.main()
