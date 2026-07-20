#!/usr/bin/env python3
"""Executable regression tests for the Hermes v0.18.2 native sidebar backport.

The suite copies the deployed release sources to a temporary directory, checks
that their hashes match the pinned release, applies the production patch there,
and exercises the patched SessionDB and FastAPI endpoint. It never edits
/opt/hermes-agent or starts a server.
"""

from __future__ import annotations

import ast
import contextlib
import hashlib
import importlib
import importlib.util
import logging
import os
import shutil

# The verifier uses subprocess only with fixed argv lists and never a shell.
import subprocess  # nosec B404
import sys
import tempfile
import time
import types
import typing
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[1]
PATCH = ROOT / "patches" / "hermes-native-sidebar.patch"
SOURCE = Path(os.environ.get("HERMES_BASE_SOURCE_DIR", "/opt/hermes-agent"))
BASE_HASHES = {
    "hermes_state.py": "d890f6f790037888cb48a03ff3f5b13f182cdad2ab8b3087314ff105587b825d",  # pragma: allowlist secret - public source SHA-256
    "hermes_cli/web_server.py": "ea79bfd62f1079fd43924fab508c20c2f1401208fb3bad249c9c7173c3ecc4a3",  # pragma: allowlist secret - public source SHA-256
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@contextlib.contextmanager
def _temporary_module(name: str, module):
    previous = sys.modules.get(name)
    sys.modules[name] = module
    try:
        yield
    finally:
        if previous is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = previous


def _load_sidebar_endpoint(web_server_path: Path):
    """Execute only the backported helper and endpoint in an isolated FastAPI app."""
    tree = ast.parse(web_server_path.read_text(encoding="utf-8"))
    wanted = {
        "_SIDEBAR_SESSION_HEAVY_FIELDS",
        "_strip_sidebar_session_rows",
        "get_profiles_sessions_sidebar",
    }
    body = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            names = {
                target.id for target in node.targets if isinstance(target, ast.Name)
            }
            if names & wanted:
                body.append(node)
        elif (
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name in wanted
        ):
            body.append(node)
    if len(body) != 3:
        raise AssertionError(f"expected three sidebar nodes, got {len(body)}")

    app = FastAPI()
    namespace = {
        "__name__": "_native_sidebar_endpoint_test",
        "Any": typing.Any,
        "Dict": typing.Dict,
        "List": typing.List,
        "Path": Path,
        "Tuple": typing.Tuple,
        "_log": logging.getLogger("native-sidebar-test"),
        "app": app,
        "time": time,
    }
    isolated = ast.Module(body=body, type_ignores=[])
    ast.fix_missing_locations(isolated)
    # The code is extracted from the SHA-verified, locally patched source above.
    exec(  # nosec B102
        compile(isolated, str(web_server_path), "exec"), namespace
    )
    return app, namespace["get_profiles_sessions_sidebar"]


class NativeSidebarBackportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="hermes-native-sidebar-test-")
        cls.patched = Path(cls._tmp.name)
        (cls.patched / "hermes_cli").mkdir(parents=True)

        for relative, expected in BASE_HASHES.items():
            source = SOURCE / relative
            if not source.is_file():
                raise AssertionError(f"missing pinned Hermes source: {source}")
            actual = _sha256(source)
            if actual != expected:
                raise AssertionError(
                    f"unexpected base hash for {relative}: {actual}; expected {expected}"
                )
            destination = cls.patched / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)

        git = shutil.which("git")
        if git is None:
            raise AssertionError("git executable not found")
        # Fixed argv and a SHA-verified local patch; shell execution is disabled.
        subprocess.run(  # nosec B603
            [git, "apply", "--check", str(PATCH)],
            cwd=cls.patched,
            check=True,
            capture_output=True,
            text=True,
        )
        # Fixed argv and a SHA-verified local patch; shell execution is disabled.
        subprocess.run(  # nosec B603
            [git, "apply", str(PATCH)],
            cwd=cls.patched,
            check=True,
            capture_output=True,
            text=True,
        )

        cls.state = _load_module(
            "_native_sidebar_backport_state", cls.patched / "hermes_state.py"
        )
        cls.app, endpoint = _load_sidebar_endpoint(
            cls.patched / "hermes_cli" / "web_server.py"
        )
        cls.endpoint = staticmethod(endpoint)

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop("_native_sidebar_backport_state", None)
        cls._tmp.cleanup()

    def test_patch_is_narrow_and_sources_compile(self):
        patch_text = PATCH.read_text(encoding="utf-8")
        self.assertEqual(
            [line for line in patch_text.splitlines() if line.startswith("--- a/")],
            ["--- a/hermes_state.py", "--- a/hermes_cli/web_server.py"],
        )
        ast.parse((self.patched / "hermes_state.py").read_text(encoding="utf-8"))
        ast.parse(
            (self.patched / "hermes_cli" / "web_server.py").read_text(encoding="utf-8")
        )

    def test_compact_rows_omits_system_prompt_at_sql_projection(self):
        with tempfile.TemporaryDirectory(prefix="sidebar-db-") as directory:
            db = self.state.SessionDB(db_path=Path(directory) / "state.db")
            try:
                db.create_session(
                    session_id="compact-one",
                    source="desktop",
                    system_prompt="large rendered prompt",
                    model_config={"model": "test"},
                )
                db.append_message("compact-one", "user", "hello")
                compact = db.list_sessions_rich(
                    min_message_count=1,
                    order_by_last_active=True,
                    compact_rows=True,
                )
                compact_started = db.list_sessions_rich(
                    min_message_count=1,
                    order_by_last_active=False,
                    compact_rows=True,
                )
                full = db.list_sessions_rich(
                    min_message_count=1,
                    order_by_last_active=True,
                    compact_rows=False,
                )
            finally:
                db.close()

        compact_row = next(row for row in compact if row["id"] == "compact-one")
        compact_started_row = next(
            row for row in compact_started if row["id"] == "compact-one"
        )
        full_row = next(row for row in full if row["id"] == "compact-one")
        self.assertNotIn("system_prompt", compact_row)
        self.assertNotIn("system_prompt", compact_started_row)
        self.assertEqual(full_row["system_prompt"], "large rendered prompt")

    def test_compact_projection_survives_compression_tip_projection(self):
        with tempfile.TemporaryDirectory(prefix="sidebar-compression-") as directory:
            db = self.state.SessionDB(db_path=Path(directory) / "state.db")
            try:
                db.create_session(
                    session_id="compression-root",
                    source="desktop",
                    system_prompt="root prompt",
                )
                db.append_message("compression-root", "user", "root")
                db.end_session("compression-root", "compression")
                db.create_session(
                    session_id="compression-tip",
                    source="desktop",
                    system_prompt="tip prompt",
                    parent_session_id="compression-root",
                )
                db.append_message("compression-tip", "user", "tip")
                compact = db.list_sessions_rich(
                    min_message_count=1,
                    order_by_last_active=True,
                    compact_rows=True,
                )
            finally:
                db.close()

        projected = next(row for row in compact if row["id"] == "compression-tip")
        self.assertEqual(projected["_lineage_root_id"], "compression-root")
        self.assertNotIn("system_prompt", projected)

    def test_endpoint_returns_three_native_slices_without_heavy_fields(self):
        profiles_mod = importlib.import_module("hermes_cli.profiles")

        with tempfile.TemporaryDirectory(prefix="sidebar-profile-") as directory:
            profile_dir = Path(directory) / "default"
            profile_dir.mkdir()
            db = self.state.SessionDB(db_path=profile_dir / "state.db")
            try:
                for session_id, source in (
                    ("native-desktop", "desktop"),
                    ("native-cron", "cron"),
                    ("native-telegram", "telegram"),
                ):
                    db.create_session(
                        session_id=session_id,
                        source=source,
                        system_prompt=f"secret-{session_id}",
                        model_config={"private": session_id},
                    )
                    db.append_message(session_id, "user", "hello")
            finally:
                db.close()

            info = types.SimpleNamespace(name="default", path=profile_dir)
            with (
                _temporary_module("hermes_state", self.state),
                mock.patch.object(profiles_mod, "list_profiles", return_value=[info]),
                mock.patch.object(
                    profiles_mod, "get_profile_dir", return_value=profile_dir
                ),
            ):
                result = self.endpoint(
                    recents_profile="all",
                    recents_limit=20,
                    recents_exclude="cron,telegram",
                    cron_limit=50,
                    messaging_limit=100,
                    messaging_exclude="cron,cli,codex,desktop,gateway,local,tui",
                )

        self.assertEqual(
            [row["id"] for row in result["recents"]["sessions"]],
            ["native-desktop"],
        )
        self.assertEqual(
            [row["id"] for row in result["cron"]["sessions"]], ["native-cron"]
        )
        self.assertEqual(
            [row["id"] for row in result["messaging"]["sessions"]],
            ["native-telegram"],
        )
        self.assertEqual(result["recents"]["total"], 1)
        self.assertEqual(result["messaging"]["total"], 1)
        self.assertEqual(result["errors"], [])
        for slice_name in ("recents", "cron", "messaging"):
            for row in result[slice_name]["sessions"]:
                self.assertNotIn("system_prompt", row)
                self.assertNotIn("model_config", row)
                self.assertEqual(row["profile"], "default")

    def test_count_failure_preserves_rows_and_stops_only_that_profile(self):
        profiles_mod = importlib.import_module("hermes_cli.profiles")

        with tempfile.TemporaryDirectory(prefix="sidebar-count-failure-") as directory:
            profile_dir = Path(directory) / "default"
            profile_dir.mkdir()
            (profile_dir / "state.db").touch()
            info = types.SimpleNamespace(name="default", path=profile_dir)

            class FailingCountDB:
                instances = []

                def __init__(self, **kwargs):
                    self.calls = []
                    self.closed = False
                    self.__class__.instances.append(self)

                def list_sessions_rich(self, **kwargs):
                    self.calls.append(("list", kwargs))
                    return [
                        {
                            "id": "row-survives",
                            "source": "desktop",
                            "started_at": 10.0,
                            "last_active": 20.0,
                            "ended_at": None,
                            "archived": 0,
                            "system_prompt": "must disappear",
                            "model_config": {"must": "disappear"},
                        }
                    ]

                def session_count(self, **kwargs):
                    self.calls.append(("count", kwargs))
                    raise RuntimeError("count failed")

                def close(self):
                    self.closed = True

            original = self.state.SessionDB
            setattr(self.state, "SessionDB", FailingCountDB)
            try:
                with (
                    _temporary_module("hermes_state", self.state),
                    mock.patch.object(
                        profiles_mod, "list_profiles", return_value=[info]
                    ),
                    mock.patch.object(
                        profiles_mod, "get_profile_dir", return_value=profile_dir
                    ),
                ):
                    result = self.endpoint()
            finally:
                setattr(self.state, "SessionDB", original)

        self.assertEqual(
            [row["id"] for row in result["recents"]["sessions"]],
            ["row-survives"],
        )
        self.assertEqual(result["cron"]["sessions"], [])
        self.assertEqual(result["messaging"]["sessions"], [])
        self.assertEqual(
            result["errors"], [{"profile": "default", "error": "count failed"}]
        )
        self.assertNotIn("system_prompt", result["recents"]["sessions"][0])
        self.assertNotIn("model_config", result["recents"]["sessions"][0])
        instance = FailingCountDB.instances[0]
        self.assertEqual([call[0] for call in instance.calls], ["list", "count"])
        self.assertTrue(instance.calls[0][1]["compact_rows"])
        self.assertTrue(instance.closed)

    def test_fastapi_keeps_integer_query_validation(self):
        client = TestClient(self.app)
        response = client.get(
            "/api/profiles/sessions/sidebar?recents_limit=not-an-integer"
        )
        self.assertEqual(response.status_code, 422)
        detail = response.json()["detail"]
        self.assertEqual(detail[0]["loc"], ["query", "recents_limit"])
        self.assertEqual(detail[0]["type"], "int_parsing")


if __name__ == "__main__":
    unittest.main(verbosity=2)
