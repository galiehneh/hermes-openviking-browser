"""Tests for the openviking-browser dashboard API (read-only proxy).

Run:
    pip install -r requirements-dev.txt
    python -m pytest tests -q
"""

import asyncio
import importlib.util
import json
import logging
import os
import re
import time
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

API_FILE = Path(__file__).resolve().parent.parent / "dashboard" / "api.py"
PREFIX = "/api/plugins/openviking-browser"
SECRET = "SECRET-KEY-do-not-leak-0123456789abcdef"
ROOT_SECRET = "ROOT-KEY-must-never-be-used-9999"


def _load_module():
    spec = importlib.util.spec_from_file_location("ov_browser_api_under_test", API_FILE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _client_for(mod):
    app = FastAPI()
    app.include_router(mod.router, prefix=PREFIX)
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _isolated_environment(tmp_path, monkeypatch):
    """Never touch the developer's real home, env or network: start every test from a clean slate."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    for name in ("OPENVIKING_API_KEY", "OPENVIKING_CREDENTIALS_FILE", "OPENVIKING_URL"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture()
def creds(tmp_path, monkeypatch):
    path = tmp_path / "openviking.json"
    path.write_text(json.dumps({
        "service": "openviking", "agent_user_key": SECRET, "root_api_key": ROOT_SECRET,
        "account": "default", "user": "agent",
    }))
    monkeypatch.setenv("OPENVIKING_CREDENTIALS_FILE", str(path))
    monkeypatch.setenv("OPENVIKING_URL", "http://ov.test:1933")
    return path


@pytest.fixture()
def env(creds):
    """(client, calls, set_handler). `calls` records every upstream request."""
    mod = _load_module()
    calls = []
    state = {}

    def default_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "ok", "result": {"echo": request.url.path}, "error": None})

    state["handler"] = default_handler

    def transport_fn(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return state["handler"](request)

    mod._TRANSPORT = httpx.MockTransport(transport_fn)
    client = _client_for(mod)
    client.mod = mod

    def set_handler(fn):
        state["handler"] = fn

    return client, calls, set_handler


# ─── allowed routes -> exact upstream mapping ──────────────────────────────
GET_CASES = [
    ("/health", "/health", {}),
    ("/summary", "/api/v1/console/dashboard/summary", {}),
    ("/sessions", "/api/v1/sessions", {}),
    ("/observer/queue", "/api/v1/observer/queue", {}),
    ("/observer/system", "/api/v1/observer/system", {}),
    ("/observer/vikingdb", "/api/v1/observer/vikingdb", {}),
    ("/observer/models", "/api/v1/observer/models", {}),
    ("/observer/retrieval", "/api/v1/observer/retrieval", {}),
    ("/observer/filesystem", "/api/v1/observer/filesystem", {}),
    ("/observer/lock", "/api/v1/observer/lock", {}),
    ("/ls?uri=viking://resources", "/api/v1/fs/ls", {"uri": "viking://resources"}),
    ("/tree?uri=viking://resources&level_limit=2", "/api/v1/fs/tree", {"uri": "viking://resources", "level_limit": "2"}),
    ("/stat?uri=viking://resources/projects", "/api/v1/fs/stat", {"uri": "viking://resources/projects"}),
    ("/abstract?uri=viking://resources/projects", "/api/v1/content/abstract", {"uri": "viking://resources/projects"}),
    ("/overview?uri=viking://resources/projects", "/api/v1/content/overview", {"uri": "viking://resources/projects"}),
    ("/read?uri=viking://resources/a.md&offset=0&limit=100", "/api/v1/content/read",
     {"uri": "viking://resources/a.md", "offset": "0", "limit": "100"}),
]


@pytest.mark.parametrize("route,upstream_path,params", GET_CASES)
def test_get_routes_map_to_upstream(env, route, upstream_path, params):
    client, calls, _ = env
    r = client.get(PREFIX + route)
    assert r.status_code == 200, r.text
    assert len(calls) == 1
    req = calls[0]
    assert req.method == "GET"
    assert req.url.path == upstream_path
    for k, v in params.items():
        assert req.url.params.get(k) == v
    assert req.headers["x-api-key"] == SECRET
    assert r.json()["result"]["echo"] == upstream_path


def test_find_grep_glob_post(env):
    client, calls, _ = env
    assert client.post(PREFIX + "/find", json={"query": "hello", "target_uri": "viking://resources", "limit": 5}).status_code == 200
    assert client.post(PREFIX + "/grep", json={"uri": "viking://resources", "pattern": "abc", "case_insensitive": True}).status_code == 200
    assert client.post(PREFIX + "/glob", json={"pattern": "**/*.md", "uri": "viking://resources"}).status_code == 200
    assert [(c.method, c.url.path) for c in calls] == [
        ("POST", "/api/v1/search/find"), ("POST", "/api/v1/search/grep"), ("POST", "/api/v1/search/glob"),
    ]
    assert json.loads(calls[0].content) == {"query": "hello", "target_uri": "viking://resources", "limit": 5}
    assert json.loads(calls[1].content)["pattern"] == "abc"
    assert all(c.headers["x-api-key"] == SECRET for c in calls)


def test_status_aggregates_and_tolerates_partial_failure(env):
    client, calls, set_handler = env

    def handler(request):
        p = request.url.path
        if p == "/health":
            return httpx.Response(200, json={"status": "ok", "healthy": True, "version": "v0.4.23", "auth_mode": "api_key"})
        if p == "/api/v1/debug/vector/count":
            return httpx.Response(200, json={"status": "ok", "result": {"count": 59}})
        if p == "/api/v1/observer/queue":
            return httpx.Response(500, text="boom")
        return httpx.Response(200, json={"status": "ok", "result": {"context_counts": {"files": 1}}})

    set_handler(handler)
    r = client.get(PREFIX + "/status")
    assert r.status_code == 200
    body = r.json()
    assert body["health"]["version"] == "v0.4.23"
    assert body["vector_count"] == 59
    assert body["queue"] is None
    assert body["errors"] == ["queue"]
    assert body["summary"]["context_counts"]["files"] == 1
    assert {c.method for c in calls} == {"GET"}


# ─── read-only enforcement ─────────────────────────────────────────────────
FORBIDDEN_PATHS = [
    "/fs", "/fs/mv", "/fs/cp", "/fs/mkdir", "/content/write", "/content/reindex",
    "/content/batch-write", "/resources", "/admin/accounts", "/api/v1/fs", "/api/v1/admin/accounts",
    "/sessions/abc/commit", "/sessions/abc", "/observer/../admin/accounts", "/observer/bogus",
    "/pack/restore", "/system/consistency", "/watches", "/skills",
]


@pytest.mark.parametrize("path", FORBIDDEN_PATHS)
@pytest.mark.parametrize("method", ["GET", "POST", "PUT", "PATCH", "DELETE"])
def test_non_whitelisted_paths_rejected(env, path, method):
    client, calls, _ = env
    r = client.request(method, PREFIX + path, json={} if method != "GET" else None)
    assert r.status_code in (404, 405, 422), (method, path, r.status_code)
    assert calls == []


@pytest.mark.parametrize("route", [g[0].split("?")[0] for g in GET_CASES])
@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_allowed_get_routes_reject_write_methods(env, route, method):
    client, calls, _ = env
    r = client.request(method, PREFIX + route + "?uri=viking://resources", json={})
    assert r.status_code == 405
    assert calls == []


@pytest.mark.parametrize("route", ["/find", "/grep", "/glob"])
@pytest.mark.parametrize("method", ["GET", "PUT", "PATCH", "DELETE"])
def test_search_routes_only_post(env, route, method):
    client, calls, _ = env
    assert client.request(method, PREFIX + route).status_code == 405
    assert calls == []


def test_call_guard_rejects_unlisted_method_path(env):
    client, calls, _ = env
    mod = client.mod
    for method, path in [
        ("DELETE", "/api/v1/fs"), ("POST", "/api/v1/fs/mv"), ("POST", "/api/v1/content/write"),
        ("GET", "/api/v1/admin/accounts"), ("POST", "/api/v1/search/find/../../fs/mkdir"),
        ("POST", "/api/v1/content/reindex"), ("GET", "/api/v1/fs/ls/../../admin/accounts"),
        ("GET", "/api/v1/fs/mkdir"), ("POST", "/api/v1/fs/ls"), ("GET", "/api/v1/search/find"),
    ]:
        with pytest.raises(Exception) as ei:
            asyncio.run(mod._call(method, path))
        assert getattr(ei.value, "status_code", None) == 403, (method, path)
    assert calls == []


# ─── URI validation ───────────────────────────────────────────────────────
BAD_URIS = [
    "file:///etc/passwd", "http://evil/x", "/etc/passwd", "resources", "", "viking:/resources",
    "viking://resources/../../etc", "viking://resources/..", "viking://../x", "viking://resources/%2e%2e/x",
    "viking://resources/%2E%2E", "viking://resources/./x", "viking://resources/a\x00b",
    "viking://resources\\x", "viking://resources/a?x=1", "viking://resources/a#frag",
    "viking://" + "a" * 3000, "viking://resources/a\nb", "VIKING://resources",
    "viking://resources/%252e%252e/x", "viking://resources/%00",
]


@pytest.mark.parametrize("uri", BAD_URIS)
@pytest.mark.parametrize("route", ["/ls", "/tree", "/stat", "/abstract", "/overview", "/read"])
def test_bad_uri_rejected_get(env, route, uri):
    client, calls, _ = env
    r = client.get(PREFIX + route, params={"uri": uri})
    assert r.status_code == 400, (route, repr(uri), r.status_code)
    assert calls == []


@pytest.mark.parametrize("uri", BAD_URIS)
def test_bad_uri_rejected_post(env, uri):
    client, calls, _ = env
    assert client.post(PREFIX + "/grep", json={"uri": uri, "pattern": "x"}).status_code == 400
    assert client.post(PREFIX + "/glob", json={"uri": uri, "pattern": "*"}).status_code == 400
    assert client.post(PREFIX + "/find", json={"query": "x", "target_uri": uri}).status_code == 400
    assert calls == []


def test_good_uris_accepted(env):
    client, calls, _ = env
    for uri in ("viking://", "viking://resources", "viking://resources/projects/a b.md",
                "viking://user/agent/memories/x_1-2.md", "viking://resources/ünï.md"):
        assert client.get(PREFIX + "/stat", params={"uri": uri}).status_code == 200, uri
    assert len(calls) == 5


def test_missing_uri_is_422(env):
    client, calls, _ = env
    assert client.get(PREFIX + "/ls").status_code == 422
    assert calls == []


def test_extra_body_fields_forbidden(env):
    client, calls, _ = env
    assert client.post(PREFIX + "/find", json={"query": "x", "telemetry": True, "filter": {"a": 1}}).status_code == 422
    assert client.post(PREFIX + "/grep", json={"uri": "viking://resources", "pattern": "x", "exclude_uri": "viking://x"}).status_code == 422
    assert calls == []


def test_limits_are_capped(env):
    client, calls, _ = env
    assert client.post(PREFIX + "/find", json={"query": "x", "limit": 100000}).status_code == 422
    assert client.post(PREFIX + "/grep", json={"uri": "viking://resources", "pattern": "x" * 5000}).status_code == 422
    assert client.get(PREFIX + "/read", params={"uri": "viking://resources/a", "limit": 10**9}).status_code == 422
    assert client.get(PREFIX + "/tree", params={"uri": "viking://resources", "node_limit": 10**9}).status_code == 422
    assert calls == []


# ─── secret handling ──────────────────────────────────────────────────────
def _assert_no_secret(resp):
    blob = resp.text + json.dumps(dict(resp.headers))
    assert SECRET not in blob
    assert ROOT_SECRET not in blob


def test_secret_not_in_success_response(env):
    client, _, _ = env
    for route in ("/health", "/summary", "/status", "/ls?uri=viking://resources"):
        _assert_no_secret(client.get(PREFIX + route))


def test_root_key_never_used(env):
    client, calls, _ = env
    client.get(PREFIX + "/health")
    assert calls and all(c.headers["x-api-key"] == SECRET for c in calls)
    assert all(ROOT_SECRET not in str(c.headers) for c in calls)


def test_secret_scrubbed_from_upstream_error_body(env):
    client, _, set_handler = env
    set_handler(lambda req: httpx.Response(
        400, json={"status": "error", "error": {"code": "BAD", "message": f"bad key {SECRET}"}}))
    r = client.get(PREFIX + "/ls", params={"uri": "viking://resources"})
    assert r.status_code == 400
    _assert_no_secret(r)
    assert r.json()["detail"]["code"] == "BAD"


def test_secret_not_in_error_when_upstream_echoes_raw_text(env):
    client, _, set_handler = env
    set_handler(lambda req: httpx.Response(500, text=f"internal error for {SECRET} <html>"))
    r = client.get(PREFIX + "/health")
    assert r.status_code == 502
    _assert_no_secret(r)
    assert "<html>" not in r.text


def test_upstream_down_generic_502(env):
    client, _, set_handler = env

    def boom(req):
        raise httpx.ConnectError(f"connect failed to {req.url} with {SECRET}")

    set_handler(boom)
    r = client.get(PREFIX + "/health")
    assert r.status_code == 502
    _assert_no_secret(r)
    assert "ov.test" not in r.text


def test_upstream_timeout_502(env):
    client, _, set_handler = env

    def slow(req):
        raise httpx.ReadTimeout("timeout")

    set_handler(slow)
    assert client.get(PREFIX + "/health").status_code == 502


@pytest.mark.parametrize("upstream_status", [401, 403])
def test_upstream_auth_failure_is_502_not_401(env, upstream_status):
    """A 401 from OpenViking must not reach the browser as 401: Hermes' fetchJSON treats a
    401 as 'dashboard session expired' and redirects to /login."""
    client, _, set_handler = env
    set_handler(lambda req: httpx.Response(
        upstream_status, json={"status": "error", "error": {"code": "UNAUTHENTICATED", "message": "nope"}}))
    r = client.get(PREFIX + "/health")
    assert r.status_code == 502
    assert r.json()["detail"]["code"] == "UNAUTHENTICATED"


def test_upstream_client_errors_passed_through(env):
    client, _, set_handler = env
    set_handler(lambda req: httpx.Response(404, json={"status": "error", "error": {"code": "NOT_FOUND", "message": "x"}}))
    r = client.get(PREFIX + "/stat", params={"uri": "viking://resources/zz"})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "NOT_FOUND"


def test_non_json_success_body_is_502(env):
    client, _, set_handler = env
    set_handler(lambda req: httpx.Response(200, text="plain"))
    assert client.get(PREFIX + "/health").status_code == 502


def test_logs_do_not_contain_secret(env, caplog):
    client, _, set_handler = env
    caplog.set_level(logging.DEBUG)

    def boom(req):
        raise httpx.ConnectError(f"x {SECRET}")

    set_handler(boom)
    client.get(PREFIX + "/health")
    set_handler(lambda req: httpx.Response(500, text=SECRET))
    client.get(PREFIX + "/health")
    assert SECRET not in caplog.text
    assert ROOT_SECRET not in caplog.text


# ─── credentials handling ─────────────────────────────────────────────────
def test_missing_credentials_file_503_and_import_ok(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENVIKING_CREDENTIALS_FILE", str(tmp_path / "nope.json"))
    mod = _load_module()  # import must not fail
    mod._TRANSPORT = httpx.MockTransport(lambda r: httpx.Response(200, json={}))
    r = _client_for(mod).get(PREFIX + "/health")
    assert r.status_code == 503
    assert str(tmp_path) not in r.text


def test_credentials_without_agent_key_503(tmp_path, monkeypatch):
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"root_api_key": ROOT_SECRET}))
    monkeypatch.setenv("OPENVIKING_CREDENTIALS_FILE", str(p))
    mod = _load_module()
    calls = []
    mod._TRANSPORT = httpx.MockTransport(lambda r: calls.append(r) or httpx.Response(200, json={}))
    r = _client_for(mod).get(PREFIX + "/health")
    assert r.status_code == 503
    assert calls == []  # root key must not be used as a fallback
    assert ROOT_SECRET not in r.text


def test_credentials_reload_on_change(env, creds):
    client, calls, _ = env
    client.get(PREFIX + "/health")
    assert calls[-1].headers["x-api-key"] == SECRET
    creds.write_text(json.dumps({"agent_user_key": "NEW-KEY-xyz"}))
    os.utime(creds, (time.time() + 5, time.time() + 5))
    client.get(PREFIX + "/health")
    assert calls[-1].headers["x-api-key"] == "NEW-KEY-xyz"


def _capture_calls(mod):
    calls = []
    mod._TRANSPORT = httpx.MockTransport(lambda r: calls.append(r) or httpx.Response(200, json={}))
    return calls


def test_env_api_key_used_directly(monkeypatch):
    monkeypatch.setenv("OPENVIKING_API_KEY", "  " + SECRET + "  ")
    mod = _load_module()
    calls = _capture_calls(mod)
    r = _client_for(mod).get(PREFIX + "/health")
    assert r.status_code == 200
    assert calls[0].headers["x-api-key"] == SECRET
    _assert_no_secret(r)


def test_env_api_key_beats_credentials_file(creds, monkeypatch):
    monkeypatch.setenv("OPENVIKING_API_KEY", "ENV-KEY-wins")
    mod = _load_module()
    calls = _capture_calls(mod)
    assert _client_for(mod).get(PREFIX + "/health").status_code == 200
    assert calls[0].headers["x-api-key"] == "ENV-KEY-wins"


def test_blank_env_api_key_falls_through_to_file(creds, monkeypatch):
    monkeypatch.setenv("OPENVIKING_API_KEY", "   ")
    mod = _load_module()
    calls = _capture_calls(mod)
    assert _client_for(mod).get(PREFIX + "/health").status_code == 200
    assert calls[0].headers["x-api-key"] == SECRET


def test_default_credentials_file_in_home(tmp_path):
    ov_dir = tmp_path / "home" / ".openviking"
    ov_dir.mkdir()
    (ov_dir / "credentials.json").write_text(json.dumps({"agent_user_key": SECRET}))
    mod = _load_module()
    calls = _capture_calls(mod)
    assert _client_for(mod).get(PREFIX + "/health").status_code == 200
    assert calls[0].headers["x-api-key"] == SECRET


def test_explicit_credentials_file_beats_home_default(creds, tmp_path):
    ov_dir = tmp_path / "home" / ".openviking"
    ov_dir.mkdir()
    (ov_dir / "credentials.json").write_text(json.dumps({"agent_user_key": "HOME-KEY"}))
    mod = _load_module()
    calls = _capture_calls(mod)
    assert _client_for(mod).get(PREFIX + "/health").status_code == 200
    assert calls[0].headers["x-api-key"] == SECRET


def test_no_credentials_anywhere_503_with_clear_message():
    mod = _load_module()
    calls = _capture_calls(mod)
    r = _client_for(mod).get(PREFIX + "/health")
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert detail["code"] == "NO_CREDENTIALS"
    assert "OPENVIKING_API_KEY" in detail["message"]
    assert calls == []


@pytest.mark.parametrize("content", ["not json", "[]", '{"agent_user_key": ""}', '{"agent_user_key": 5}'])
def test_malformed_credentials_file_503(tmp_path, monkeypatch, content):
    p = tmp_path / "bad.json"
    p.write_text(content)
    monkeypatch.setenv("OPENVIKING_CREDENTIALS_FILE", str(p))
    mod = _load_module()
    calls = _capture_calls(mod)
    assert _client_for(mod).get(PREFIX + "/health").status_code == 503
    assert calls == []


def test_default_url_is_loopback(creds, monkeypatch):
    monkeypatch.delenv("OPENVIKING_URL")
    mod = _load_module()
    calls = _capture_calls(mod)
    _client_for(mod).get(PREFIX + "/health")
    assert str(calls[0].url).startswith("http://127.0.0.1:1933/")


def test_url_override_strips_trailing_slash(creds, monkeypatch):
    monkeypatch.setenv("OPENVIKING_URL", "http://ov.example:9000/")
    mod = _load_module()
    calls = _capture_calls(mod)
    _client_for(mod).get(PREFIX + "/health")
    assert str(calls[0].url) == "http://ov.example:9000/health"


def test_source_has_no_hardcoded_key_and_never_reads_root_key():
    src = API_FILE.read_text()
    assert "root_api_key" not in src
    # OpenViking user keys look like base64.base64.hex
    assert not re.search(r"[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{40,}", src)
    assert re.search(r"agent_user_key", src)


# ─── directories (v1.0.2): the UI resolves dir-ness via /stat and expects the upstream read error verbatim ──
def test_stat_relays_is_dir_unchanged(env):
    client, _calls, set_handler = env
    seen = {}

    def handler(req):
        seen["path"], seen["uri"] = req.url.path, req.url.params.get("uri")
        return httpx.Response(200, json={"status": "ok", "result": {"isDir": True, "size": 4096, "uri": seen.get("uri")}})

    set_handler(handler)
    uri = "viking://resources/projects/digital-receipt/build-and-versioning.md"
    r = client.get(PREFIX + "/stat", params={"uri": uri})
    assert r.status_code == 200
    assert r.json()["result"]["isDir"] is True
    assert (seen["path"], seen["uri"]) == ("/api/v1/fs/stat", uri)


def test_read_of_directory_relays_upstream_message(env):
    """The UI turns this exact upstream message into its directory hint; the proxy must not rewrite it."""
    client, _calls, set_handler = env
    msg = "Directory URI is not readable as a file: viking://resources/x.md. List it first, then read a file URI."
    set_handler(lambda req: httpx.Response(400, json={
        "status": "error", "result": None,
        "error": {"code": "INVALID_ARGUMENT", "message": msg, "details": {"expected": "file", "actual": "directory"}}}))
    r = client.get(PREFIX + "/read", params={"uri": "viking://resources/x.md"})
    assert r.status_code == 400
    assert r.json()["detail"] == {"code": "INVALID_ARGUMENT", "message": msg}


def test_stat_uri_is_validated_and_root_allowed(env):
    client, _calls, _ = env
    assert client.get(PREFIX + "/stat", params={"uri": "viking://"}).status_code == 200
    assert client.get(PREFIX + "/stat", params={"uri": "viking://resources/../x"}).status_code == 400


# ─── release metadata ───────────────────────────────────────────────
def test_versions_agree_and_entry_is_cache_busted():
    root = API_FILE.parent.parent
    manifest = json.loads((root / "dashboard" / "manifest.json").read_text())
    version = manifest["version"]
    assert re.search(rf"^version: {re.escape(version)}$", (root / "plugin.yaml").read_text(), re.M)
    assert json.loads((root / "package.json").read_text())["version"] == version
    lock = json.loads((root / "package-lock.json").read_text())
    assert lock["version"] == version and lock["packages"][""]["version"] == version
    # Hermes loads plugin scripts from /dashboard-plugins/<name>/<entry> with no version of its own.
    assert manifest["entry"] == f"plugin.js?v={version}"
    assert (root / "dashboard" / "plugin.js").is_file()
    assert re.search(rf"^## \[{re.escape(version)}\]", (root / "CHANGELOG.md").read_text(), re.M)
