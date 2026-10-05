"""OpenViking Browser plugin API: strictly read-only proxy to an OpenViking server.

Security model
- No generic passthrough: every allowed operation is an explicit route that maps to a
  hard-coded (method, upstream path) pair in ``_UPSTREAM``. ``_call`` refuses anything else.
- All ``viking://`` URIs are validated (scheme, length, control chars, ``..`` segments,
  also after percent-decoding).
- The API key is resolved server-side (``OPENVIKING_API_KEY``, or the ``agent_user_key`` field of a
  credentials file), never logged and never returned (upstream text is scrubbed of it). A credentials
  file is only ever read for ``agent_user_key``, never for an admin/root key.
"""

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Literal, Optional
from urllib.parse import unquote

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

router = APIRouter(tags=["openviking-browser"])
_log = logging.getLogger("openviking_browser")

DEFAULT_URL = "http://127.0.0.1:1933"
DEFAULT_CREDENTIALS_RELPATH = Path(".openviking") / "credentials.json"  # relative to the home dir
KEY_FIELD = "agent_user_key"

CONNECT_TIMEOUT = 3.0
TOTAL_TIMEOUT = 20.0
MAX_URI_LEN = 2048
MAX_TEXT_LEN = 500
MAX_ERROR_TEXT = 300

# The ONLY upstream operations this plugin can perform. All read-only.
_UPSTREAM: dict[str, tuple[str, str]] = {
    "health": ("GET", "/health"),
    "summary": ("GET", "/api/v1/console/dashboard/summary"),
    "vector_count": ("GET", "/api/v1/debug/vector/count"),
    "sessions": ("GET", "/api/v1/sessions"),
    "ls": ("GET", "/api/v1/fs/ls"),
    "tree": ("GET", "/api/v1/fs/tree"),
    "stat": ("GET", "/api/v1/fs/stat"),
    "abstract": ("GET", "/api/v1/content/abstract"),
    "overview": ("GET", "/api/v1/content/overview"),
    "read": ("GET", "/api/v1/content/read"),
    "find": ("POST", "/api/v1/search/find"),
    "grep": ("POST", "/api/v1/search/grep"),
    "glob": ("POST", "/api/v1/search/glob"),
}
ObserverName = Literal["queue", "system", "vikingdb", "models", "retrieval", "filesystem", "lock"]
_OBSERVERS: tuple[str, ...] = ObserverName.__args__  # type: ignore[attr-defined]
_ALLOWED: frozenset[tuple[str, str]] = frozenset(
    list(_UPSTREAM.values()) + [("GET", f"/api/v1/observer/{n}") for n in _OBSERVERS]
)

# Test seam: tests set an httpx.MockTransport here. None means the real network.
_TRANSPORT: Optional[httpx.AsyncBaseTransport] = None

_CONTROL_OR_BACKSLASH = re.compile(r"[\x00-\x1f\x7f\\]")
_creds_cache: dict[str, Any] = {"sig": None, "key": None}


# ─── errors ─────────────────────────────────────────────────────────
def _fail(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


# ─── credentials ────────────────────────────────────────────────────
def _base_url() -> str:
    return os.environ.get("OPENVIKING_URL", DEFAULT_URL).rstrip("/")


def _credentials_path() -> Optional[Path]:
    explicit = os.environ.get("OPENVIKING_CREDENTIALS_FILE", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    try:
        return Path.home() / DEFAULT_CREDENTIALS_RELPATH
    except RuntimeError:  # no resolvable home directory
        return None


def _load_key() -> str:
    """Return the API key.

    Order: ``OPENVIKING_API_KEY`` -> JSON file named by ``OPENVIKING_CREDENTIALS_FILE`` ->
    ``~/.openviking/credentials.json``. The file is cached until it changes. Raises 503 if none
    yields a non-empty key.
    """
    direct = os.environ.get("OPENVIKING_API_KEY", "").strip()
    if direct:
        return direct
    path = _credentials_path()
    key = None
    sig = None
    try:
        if path is not None:
            st = path.stat()
            sig = (str(path), st.st_mtime_ns, st.st_size)
            if _creds_cache["sig"] == sig and _creds_cache["key"]:
                return _creds_cache["key"]
            key = json.loads(path.read_text(encoding="utf-8")).get(KEY_FIELD)
    except (OSError, ValueError, AttributeError):
        key = None
    if not isinstance(key, str) or not key.strip():
        _creds_cache.update(sig=None, key=None)
        raise _fail(
            503,
            "NO_CREDENTIALS",
            "No OpenViking API key configured: set OPENVIKING_API_KEY, or point "
            "OPENVIKING_CREDENTIALS_FILE (or ~/.openviking/credentials.json) at a JSON file "
            "with an agent_user_key field",
        )
    _creds_cache.update(sig=sig, key=key.strip())
    return key.strip()


# ─── validation ─────────────────────────────────────────────────────
def _validate_uri(uri: Any) -> str:
    bad = _fail(400, "INVALID_URI", "uri must be a plain viking:// path")
    if not isinstance(uri, str) or len(uri) > MAX_URI_LEN or not uri.startswith("viking://"):
        raise bad
    if "?" in uri or "#" in uri or _CONTROL_OR_BACKSLASH.search(uri):
        raise bad
    decoded = uri[len("viking://"):]
    for _ in range(4):  # catch double/triple percent-encoding
        nxt = unquote(decoded)
        if nxt == decoded:
            break
        decoded = nxt
    if _CONTROL_OR_BACKSLASH.search(decoded):
        raise bad
    if any(seg in (".", "..") for seg in decoded.split("/")):
        raise bad
    return uri


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FindBody(_Body):
    query: str = Field(min_length=1, max_length=MAX_TEXT_LEN)
    target_uri: Optional[str] = None
    limit: int = Field(10, ge=1, le=50)
    score_threshold: Optional[float] = Field(None, ge=0, le=1)


class GrepBody(_Body):
    uri: str
    pattern: str = Field(min_length=1, max_length=MAX_TEXT_LEN)
    case_insensitive: bool = False
    node_limit: int = Field(100, ge=1, le=500)


class GlobBody(_Body):
    pattern: str = Field(min_length=1, max_length=MAX_TEXT_LEN)
    uri: str = "viking://"
    node_limit: int = Field(200, ge=1, le=1000)


# ─── upstream call ──────────────────────────────────────────────────
def _scrub(text: str, key: str) -> str:
    return text.replace(key, "***") if key else text


def _error_detail(resp: httpx.Response, key: str) -> dict:
    """Only upstream error code/message survive, as truncated, scrubbed strings."""
    code, message = "UPSTREAM_ERROR", "OpenViking returned an error"
    try:
        err = resp.json().get("error")
        if isinstance(err, dict):
            code = str(err.get("code") or code)[:60]
            message = str(err.get("message") or message)[:MAX_ERROR_TEXT]
    except (ValueError, AttributeError):
        pass
    return {"code": _scrub(code, key), "message": _scrub(message, key)}


async def _call(
    method: str, path: str, *, params: Optional[dict] = None, json_body: Optional[dict] = None
) -> Any:
    if (method, path) not in _ALLOWED:
        raise _fail(403, "FORBIDDEN", "operation not allowed (read-only plugin)")
    key = _load_key()
    clean = {k: v for k, v in (params or {}).items() if v is not None}
    try:
        async with httpx.AsyncClient(
            transport=_TRANSPORT,
            timeout=httpx.Timeout(TOTAL_TIMEOUT, connect=CONNECT_TIMEOUT),
            follow_redirects=False,  # never forward the key to another location
        ) as client:
            resp = await client.request(
                method, _base_url() + path, params=clean, json=json_body, headers={"X-API-Key": key}
            )
    except httpx.HTTPError as exc:
        _log.warning("OpenViking request failed: %s", type(exc).__name__)
        raise _fail(502, "UPSTREAM_UNREACHABLE", "OpenViking is unreachable") from None
    if resp.status_code in (401, 403):
        # Never relay 401: the dashboard's fetchJSON treats it as an expired session and
        # redirects to /login. This is a plugin->OpenViking credential problem, i.e. a bad gateway.
        raise HTTPException(status_code=502, detail=_error_detail(resp, key))
    if 400 <= resp.status_code < 500:
        raise HTTPException(status_code=resp.status_code, detail=_error_detail(resp, key))
    if resp.status_code != 200:
        _log.warning("OpenViking returned HTTP %s for %s", resp.status_code, path)
        raise _fail(502, "UPSTREAM_ERROR", "OpenViking returned an error")
    try:
        return json.loads(_scrub(resp.text, key))
    except ValueError:
        raise _fail(502, "UPSTREAM_BAD_RESPONSE", "OpenViking returned a non-JSON response") from None


def _unwrap(payload: Any) -> Any:
    return payload.get("result") if isinstance(payload, dict) and "result" in payload else payload


_QUEUE_ROW = re.compile(r"^\|\s*([A-Za-z]\w*)\s*" + r"\|\s*(\d+)\s*" * 6 + r"\|$")


def _queue_totals(queue: Any) -> Optional[dict]:
    """Sum the observer's ASCII queue table: Pending, In Progress, Processed, Requeued, Errors."""
    text = queue.get("status") if isinstance(queue, dict) else None
    if not isinstance(text, str):
        return None
    totals = {"pending": 0, "in_progress": 0, "processed": 0, "requeued": 0, "errors": 0}
    rows = 0
    for line in text.splitlines():
        m = _QUEUE_ROW.match(line.strip())
        if m and m.group(1).lower() != "queue":
            rows += 1
            for name, val in zip(totals, m.groups()[1:6]):
                totals[name] += int(val)
    return totals if rows else None


# ─── routes ─────────────────────────────────────────────────────────
@router.get("/status")
async def status():
    """Health, queue, vector count and context summary in one call; partial failures tolerated."""
    _load_key()  # 503 up front when credentials are missing
    names = ["health", "queue", "vector_count", "summary"]
    results = await asyncio.gather(
        _call(*_UPSTREAM["health"]),
        _call("GET", "/api/v1/observer/queue"),
        _call(*_UPSTREAM["vector_count"]),
        _call(*_UPSTREAM["summary"]),
        return_exceptions=True,
    )
    errors = [n for n, r in zip(names, results) if isinstance(r, BaseException)]
    health, queue, count, summary = (None if isinstance(r, BaseException) else r for r in results)
    queue = _unwrap(queue) if queue is not None else None
    count = _unwrap(count) if count is not None else None
    return {
        "health": health,
        "queue": queue,
        "queue_totals": _queue_totals(queue),
        "vector_count": count.get("count") if isinstance(count, dict) else None,
        "summary": _unwrap(summary) if summary is not None else None,
        "errors": errors,
    }


@router.get("/health")
async def health():
    return await _call(*_UPSTREAM["health"])


@router.get("/summary")
async def summary():
    return await _call(*_UPSTREAM["summary"])


@router.get("/sessions")
async def sessions():
    return await _call(*_UPSTREAM["sessions"])


@router.get("/observer/{name}")
async def observer(name: ObserverName):
    return await _call("GET", f"/api/v1/observer/{name}")


@router.get("/ls")
async def ls(
    uri: str = Query(...),
    limit: int = Query(500, ge=1, le=1000),
    offset: int = Query(0, ge=0, le=100000),
):
    return await _call(*_UPSTREAM["ls"], params={"uri": _validate_uri(uri), "node_limit": limit, "offset": offset})


@router.get("/tree")
async def tree(
    uri: str = Query(...),
    level_limit: int = Query(3, ge=1, le=10),
    node_limit: int = Query(200, ge=1, le=1000),
    directories_only: bool = Query(False),
):
    return await _call(
        *_UPSTREAM["tree"],
        params={
            "uri": _validate_uri(uri), "level_limit": level_limit, "node_limit": node_limit,
            "directories_only": str(directories_only).lower(),
        },
    )


@router.get("/stat")
async def stat(uri: str = Query(...)):
    return await _call(*_UPSTREAM["stat"], params={"uri": _validate_uri(uri)})


@router.get("/abstract")
async def abstract(uri: str = Query(...)):
    return await _call(*_UPSTREAM["abstract"], params={"uri": _validate_uri(uri)})


@router.get("/overview")
async def overview(uri: str = Query(...)):
    return await _call(*_UPSTREAM["overview"], params={"uri": _validate_uri(uri)})


@router.get("/read")
async def read(
    uri: str = Query(...),
    offset: int = Query(0, ge=0, le=10_000_000),
    limit: int = Query(500, ge=1, le=2000),  # lines; -1 ("to end") is deliberately not allowed
):
    return await _call(*_UPSTREAM["read"], params={"uri": _validate_uri(uri), "offset": offset, "limit": limit})


@router.post("/find")
async def find(body: FindBody):
    if body.target_uri is not None:
        _validate_uri(body.target_uri)
    return await _call(*_UPSTREAM["find"], json_body=body.model_dump(exclude_none=True))


@router.post("/grep")
async def grep(body: GrepBody):
    _validate_uri(body.uri)
    return await _call(*_UPSTREAM["grep"], json_body=body.model_dump())


@router.post("/glob")
async def glob(body: GlobBody):
    _validate_uri(body.uri)
    return await _call(*_UPSTREAM["glob"], json_body=body.model_dump())
