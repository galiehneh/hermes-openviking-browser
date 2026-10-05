/**
 * OpenViking Browser — Hermes dashboard plugin (read-only).
 * Status cards, viking:// tree, content reader, find/grep/glob search, sessions, observers.
 * All data comes from /api/plugins/openviking-browser/*; no external assets, no innerHTML.
 */
(function () {
  "use strict";

  const registry = window.__HERMES_PLUGINS__;
  const sdk = window.__HERMES_PLUGIN_SDK__;
  if (!registry || !registry.register || !sdk) return;

  const { React, fetchJSON } = sdk;
  const { useState, useEffect, useRef, useCallback } = React;
  const h = React.createElement;

  const BASE = "/api/plugins/openviking-browser";
  const ROOT = "viking://";
  const READ_LINES = 500;
  const REFRESH_MS = 30000;
  const OBSERVERS = ["system", "vikingdb", "queue", "models", "retrieval", "filesystem", "lock"];

  // ─── API helpers ──────────────────────────────────────────────────
  function get(path, params) {
    const q = params ? "?" + new URLSearchParams(params).toString() : "";
    return fetchJSON(BASE + path + q);
  }
  function post(path, body) {
    return fetchJSON(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  function errMsg(e) {
    const m = String((e && e.message) || e);
    const i = m.indexOf("{");
    if (i >= 0) {
      try {
        const d = JSON.parse(m.slice(i)).detail;
        if (d && d.message) return d.message;
      } catch (_) { /* fall through to the raw message */ }
    }
    return m.slice(0, 300);
  }
  const result = (r) => (r && typeof r === "object" && "result" in r ? r.result : r);

  // ─── small utils ──────────────────────────────────────────────────
  function trimSlash(uri) { return uri.length > ROOT.length ? uri.replace(/\/+$/, "") : uri; }
  function decodeSafe(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }
  function baseName(uri) {
    const t = trimSlash(uri);
    return t === ROOT ? ROOT : decodeSafe(t.slice(t.lastIndexOf("/") + 1));
  }
  function parentUri(uri) {
    const t = trimSlash(uri);
    const i = t.lastIndexOf("/");
    return i <= ROOT.length - 1 ? ROOT : t.slice(0, i);
  }
  function crumbs(uri) {
    const parts = trimSlash(uri).slice(ROOT.length).split("/").filter(Boolean);
    const out = [{ label: "viking://", uri: ROOT }];
    parts.forEach((p, i) => out.push({ label: p, uri: ROOT + parts.slice(0, i + 1).join("/") }));
    return out;
  }
  function fmtBytes(n) {
    if (typeof n !== "number" || n <= 0) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function fmtDate(s) {
    const d = s ? new Date(s) : null;
    return d && !isNaN(d) ? d.toLocaleString() : "";
  }
  function fmtNum(n) { return typeof n === "number" ? n.toLocaleString() : "–"; }
  function entryUri(e) { return typeof e === "string" ? e : e && e.uri; }

  function useLoad(fn, deps) {
    const [state, setState] = useState({ loading: true, data: null, error: null });
    useEffect(() => {
      let live = true;
      setState((s) => ({ loading: true, data: s.data, error: null }));
      fn().then(
        (data) => live && setState({ loading: false, data, error: null }),
        (e) => live && setState({ loading: false, data: null, error: errMsg(e) }),
      );
      return () => { live = false; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return state;
  }

  // ─── styles (scoped by .ovb) ──────────────────────────────────────
  const CSS = `
.ovb{--s:rgba(255,255,255,.04);--b:rgba(255,255,255,.1);--t:#e5e5e5;--d:rgba(255,255,255,.5);--a:#60a5fa;--ok:#a8e619;--bad:#ff4d6d;--warn:#f59e0b;
  color:var(--t);font-size:13px;display:flex;flex-direction:column;gap:12px;min-width:0}
.ovb *{box-sizing:border-box}
.ovb-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ovb-head h2{margin:0;font-size:18px;font-weight:700;flex:1;min-width:140px}
.ovb button,.ovb select,.ovb input{font:inherit;color:var(--t);background:var(--s);border:1px solid var(--b);border-radius:6px;padding:6px 10px;min-height:34px}
.ovb button{cursor:pointer}.ovb button:hover{background:rgba(255,255,255,.09)}
.ovb button.on{background:rgba(96,165,250,.18);border-color:var(--a);color:var(--a)}
.ovb button:disabled{opacity:.5;cursor:default}
.ovb-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.ovb-card{background:var(--s);border:1px solid var(--b);border-radius:8px;padding:10px 12px;min-width:0}
.ovb-card .k{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--d)}
.ovb-card .v{font-size:20px;font-weight:700;margin-top:2px;overflow-wrap:anywhere}
.ovb-card .sub{font-size:11px;color:var(--d);margin-top:2px;overflow-wrap:anywhere}
.ovb-card.ok .v{color:var(--ok)}.ovb-card.bad .v{color:var(--bad)}.ovb-card.warn .v{color:var(--warn)}
.ovb-tabs{display:flex;gap:6px;flex-wrap:wrap}
.ovb-split{display:flex;gap:10px;align-items:stretch;min-width:0}
.ovb-pane{background:var(--s);border:1px solid var(--b);border-radius:8px;min-width:0;display:flex;flex-direction:column}
.ovb-list{flex:0 0 340px;max-height:70vh;overflow:auto}
.ovb-read{flex:1;max-height:70vh;overflow:auto;padding:12px}
.ovb-crumbs{display:flex;gap:2px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--b);font-size:12px}
.ovb-crumbs button{border:0;background:none;padding:2px 4px;min-height:0;color:var(--a)}
.ovb-row{display:flex;align-items:stretch;border-bottom:1px solid var(--b)}
.ovb-row.sel{background:rgba(96,165,250,.1)}
.ovb-row .main{flex:1;min-width:0;padding:8px 10px;cursor:pointer;background:none;border:0;border-radius:0;text-align:left}
.ovb-row .nm{font-weight:600;overflow-wrap:anywhere}
.ovb-row .ab{font-size:11px;color:var(--d);margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ovb-row .go{border:0;border-left:1px solid var(--b);border-radius:0;min-width:44px}
.ovb pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.ovb-muted{color:var(--d)}.ovb-err{color:var(--bad);padding:8px 0;overflow-wrap:anywhere}
.ovb-meta{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--d);margin:4px 0 10px}
.ovb-meta span{border:1px solid var(--b);border-radius:4px;padding:1px 6px}
.ovb-search{display:flex;gap:6px;flex-wrap:wrap}
.ovb-search .q{flex:1 1 220px;min-width:0}
.ovb-hit{padding:8px 10px;border-bottom:1px solid var(--b);cursor:pointer}
.ovb-hit:hover{background:rgba(255,255,255,.05)}
.ovb-hit .u{color:var(--a);overflow-wrap:anywhere;font-size:12px}
.ovb-hit .c{font-size:12px;margin-top:3px;overflow-wrap:anywhere}
.ovb-badge{font-size:10px;border:1px solid var(--b);border-radius:4px;padding:0 5px;margin-left:6px;color:var(--d)}
@media (max-width:800px){
  .ovb-split{flex-direction:column}
  .ovb-list{flex:none;max-height:45vh}.ovb-read{max-height:none}
  .ovb input,.ovb select{font-size:16px}
}`;

  // ─── status cards ─────────────────────────────────────────────────
  function Card({ k, v, sub, tone }) {
    return h("div", { className: "ovb-card" + (tone ? " " + tone : "") },
      h("div", { className: "k" }, k),
      h("div", { className: "v" }, v),
      sub ? h("div", { className: "sub" }, sub) : null);
  }

  function StatusCards({ tick }) {
    const st = useLoad(() => get("/status"), [tick]);
    const d = st.data;
    if (!d) {
      return st.error
        ? h("div", { className: "ovb-err" }, "Status unavailable: " + st.error)
        : h("div", { className: "ovb-muted" }, "Loading status…");
    }
    const hl = d.health || {};
    const q = d.queue_totals;
    const sum = d.summary || {};
    const cc = sum.context_counts || {};
    const tk = sum.today_tokens || {};
    const rt = sum.today_retrievals || {};
    const healthy = hl.healthy === true;
    const qTone = !q ? "" : q.errors > 0 ? "bad" : q.pending + q.in_progress > 0 ? "warn" : "ok";
    return h("div", null,
      h("div", { className: "ovb-cards" },
        h(Card, { k: "Server", v: d.health ? (healthy ? "Healthy" : "Unhealthy") : "Down", tone: healthy ? "ok" : "bad",
          sub: [hl.version, hl.auth_mode, hl.account_id && hl.user_id ? hl.account_id + "/" + hl.user_id : ""].filter(Boolean).join(" · ") }),
        h(Card, { k: "Queue", v: q ? q.pending + q.in_progress + " active" : "–", tone: qTone,
          sub: q ? "pending " + q.pending + " · in progress " + q.in_progress + " · errors " + q.errors + " · done " + q.processed : "" }),
        h(Card, { k: "Vectors", v: fmtNum(d.vector_count) }),
        h(Card, { k: "Contexts", v: fmtNum(cc.total),
          sub: "files " + fmtNum(cc.files) + " · skills " + fmtNum(cc.skills) + " · memories " + fmtNum(cc.memories) }),
        h(Card, { k: "Tokens today", v: fmtNum(tk.total), sub: "in " + fmtNum(tk.vlm_input) + " · out " + fmtNum(tk.vlm_output) }),
        h(Card, { k: "Retrievals today", v: fmtNum(rt.total), sub: "find " + fmtNum(rt.find) + " · search " + fmtNum(rt.search) })),
      d.errors && d.errors.length
        ? h("div", { className: "ovb-err" }, "Partial data, failed: " + d.errors.join(", ")) : null);
  }

  // ─── reader ───────────────────────────────────────────────────────
  // OpenViking stores every document as a directory holding the real file, and /read on a directory fails.
  // So the content tab is only offered once the URI is known to be a file: from the listing entry when there
  // is one, else from fs/stat (the selection can be a directory's own URI via › / breadcrumbs, a search hit, ...).
  const NOT_A_FILE = /not readable as a file/i;

  function knownKind(uri, entry) {
    if (trimSlash(uri) === ROOT) return true;
    return entry && typeof entry === "object" && typeof entry.isDir === "boolean" ? entry.isDir : null;
  }

  function DirNotice({ uri, browsing, onNavigate }) {
    const ls = useLoad(() => get("/ls", { uri }), [uri]);
    const items = Array.isArray(result(ls.data)) ? result(ls.data) : [];
    const only = items.length === 1 && items[0] && items[0].isDir === false ? items[0] : null;
    let msg = "This is a directory, not a file.";
    if (ls.loading) msg += " Loading its files\u2026";
    else if (!ls.error && only) msg += " It holds one file.";
    else if (!ls.error && items.length === 0) msg += " It is empty.";
    else if (!ls.error) msg += " It holds " + items.length + (items.length === 1 ? " entry" : " entries") + "; select a file from its list to read it.";
    return h("div", { className: "ovb-muted" },
      h("div", null, msg),
      only ? h("button", { style: { marginTop: 8 }, onClick: () => onNavigate(uri, entryUri(only)) },
        "Open " + baseName(entryUri(only))) : null,
      !only && !browsing ? h("button", { style: { marginTop: 8 }, onClick: () => onNavigate(uri, uri) }, "Open directory") : null);
  }

  // Remounted per selection (see Browse): a new uri starts from a clean abstract tab with no stale state.
  function Reader({ uri, entry, browsing, onNavigate }) {
    const [mode, setMode] = useState("abstract");
    const [forcedDir, setForcedDir] = useState(false);
    const [content, setContent] = useState({ text: "", offset: 0, done: false, loading: false, error: null });
    const reqId = useRef(0);

    const known = knownKind(uri, entry);
    const st = useLoad(() => (known === null ? get("/stat", { uri }) : Promise.resolve(null)), [uri, known]);
    const stat = result(st.data);
    const statKind = stat && typeof stat === "object" && typeof stat.isDir === "boolean" ? stat.isDir : null;
    const kind = forcedDir ? true : known !== null ? known : statKind;
    const probing = kind === null && st.loading;
    // kind === null after a failed stat: stay usable; a failing read is turned into the directory hint below.
    const canRead = kind === false || (kind === null && !probing);
    const isDir = kind === true;

    const ab = useLoad(
      () => (mode === "content" ? Promise.resolve(null) : get("/" + mode, { uri })),
      [uri, mode],
    );

    const loadMore = useCallback((fromStart) => {
      const id = ++reqId.current;
      const offset = fromStart ? 0 : content.offset;
      setContent((c) => ({ ...(fromStart ? { text: "", offset: 0, done: false } : c), loading: true, error: null }));
      get("/read", { uri, offset: String(offset), limit: String(READ_LINES) }).then(
        (r) => {
          if (id !== reqId.current) return;
          const chunk = typeof result(r) === "string" ? result(r) : "";
          const lines = chunk === "" ? 0 : chunk.split("\n").length;
          setContent((c) => ({
            text: (fromStart ? "" : c.text) + chunk, offset: offset + lines,
            done: lines < READ_LINES, loading: false, error: null,
          }));
        },
        (e) => {
          if (id !== reqId.current) return;
          const m = errMsg(e);
          if (NOT_A_FILE.test(m)) setForcedDir(true);
          setContent((c) => ({ ...c, loading: false, error: NOT_A_FILE.test(m) ? null : m }));
        },
      );
    }, [uri, content.offset]);

    useEffect(() => () => { reqId.current++; }, []);

    useEffect(() => {
      if (mode === "content" && canRead) loadMore(true);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, canRead]);

    let body;
    if (mode === "content" && isDir) {
      body = null; // the directory notice above the tabs already explains
    } else if (mode === "content" && probing) {
      body = h("div", { className: "ovb-muted" }, "Checking\u2026");
    } else if (mode === "content") {
      body = h("div", null,
        content.error ? h("div", { className: "ovb-err" }, content.error) : null,
        content.text ? h("pre", null, content.text)
          : (!content.loading && !content.error ? h("div", { className: "ovb-muted" }, "(empty)") : null),
        content.loading ? h("div", { className: "ovb-muted" }, "Loading…") : null,
        !content.done && !content.loading && content.text
          ? h("button", { onClick: () => loadMore(false), style: { marginTop: 8 } }, "Load more") : null);
    } else if (ab.loading) {
      body = h("div", { className: "ovb-muted" }, "Loading…");
    } else if (ab.error) {
      body = h("div", { className: "ovb-err" }, ab.error);
    } else {
      const text = result(ab.data);
      body = h("pre", null, typeof text === "string" && text ? text : "(empty)");
    }

    const e = entry && typeof entry === "object" ? entry : stat && typeof stat === "object" ? stat : {};
    return h("div", null,
      h("div", { style: { fontWeight: 700, fontSize: 15, overflowWrap: "anywhere" } }, baseName(uri)),
      h("div", { className: "ovb-muted", style: { fontSize: 11, overflowWrap: "anywhere" } }, uri),
      h("div", { className: "ovb-meta" },
        isDir ? h("span", null, "directory") : kind === false ? h("span", null, "file") : null,
        kind === false && fmtBytes(e.size) ? h("span", null, fmtBytes(e.size)) : null,
        e.modTime ? h("span", null, fmtDate(e.modTime)) : null),
      isDir ? h("div", { style: { marginBottom: 10 } }, h(DirNotice, { uri, browsing, onNavigate })) : null,
      h("div", { className: "ovb-tabs", style: { marginBottom: 10 } },
        (canRead ? ["abstract", "overview", "content"] : ["abstract", "overview"]).map((m) =>
          h("button", { key: m, className: mode === m ? "on" : "", onClick: () => setMode(m) }, m))),
      body);
  }

  // ─── browse ───────────────────────────────────────────────────────
  function Browse({ dir, setDir, selected, setSelected, tick }) {
    const ls = useLoad(() => get("/ls", { uri: dir }), [dir, tick]);
    const entries = (Array.isArray(result(ls.data)) ? result(ls.data) : [])
      .slice()
      .sort((a, b) => {
        const da = a && a.isDir ? 0 : 1, db = b && b.isDir ? 0 : 1;
        return da - db || baseName(entryUri(a) || "").localeCompare(baseName(entryUri(b) || ""));
      });
    const selEntry = entries.find((e) => entryUri(e) === selected);
    const navigate = (d, s) => { setDir(d); setSelected(s); };

    return h("div", { className: "ovb-split" },
      h("div", { className: "ovb-pane ovb-list" },
        h("div", { className: "ovb-crumbs" },
          crumbs(dir).map((c, i) => h("button", { key: i, onClick: () => navigate(c.uri, c.uri) }, c.label))),
        ls.loading ? h("div", { className: "ovb-muted", style: { padding: 10 } }, "Loading…") : null,
        ls.error ? h("div", { className: "ovb-err", style: { padding: 10 } }, ls.error) : null,
        !ls.loading && !ls.error && entries.length === 0 ? h("div", { className: "ovb-muted", style: { padding: 10 } }, "Empty") : null,
        entries.map((e) => {
          const u = entryUri(e);
          const isDir = !!(e && e.isDir);
          return h("div", { key: u, className: "ovb-row" + (u === selected ? " sel" : "") },
            h("button", { className: "main", onClick: () => setSelected(u) },
              h("div", { className: "nm" }, (isDir ? "📁 " : "📄 ") + baseName(u)),
              e && e.abstract ? h("div", { className: "ab" }, e.abstract) : null),
            isDir ? h("button", { className: "go", title: "Open", "aria-label": "Open " + baseName(u),
              onClick: () => navigate(u, u) }, "›") : null);
        })),
      h("div", { className: "ovb-pane ovb-read" },
        selected ? h(Reader, { key: selected, uri: selected, entry: selEntry, browsing: selected === dir, onNavigate: navigate })
          : h("div", { className: "ovb-muted" }, "Select an item to read it.")));
  }

  // ─── search ───────────────────────────────────────────────────────
  function flattenHits(mode, raw) {
    const r = result(raw) || {};
    if (mode === "find") {
      const out = [];
      ["memories", "resources", "skills"].forEach((k) => (r[k] || []).forEach((x) =>
        out.push({ uri: x.uri, text: x.abstract || "",
          badge: k.slice(0, -1) + (typeof x.score === "number" ? " " + x.score.toFixed(2) : "") })));
      return out;
    }
    if (mode === "grep") {
      return (r.matches || []).map((m) => ({ uri: m.uri, text: m.content || "", badge: "line " + m.line }));
    }
    return (r.matches || []).map((u) => ({ uri: u, text: "", badge: "" }));
  }

  function Search({ dir, onOpen }) {
    const [mode, setMode] = useState("find");
    const [q, setQ] = useState("");
    const [scope, setScope] = useState(dir);
    const [state, setState] = useState({ loading: false, hits: null, error: null });

    useEffect(() => setScope(dir), [dir]);

    const run = (ev) => {
      if (ev) ev.preventDefault();
      const text = q.trim();
      if (!text) return;
      setState({ loading: true, hits: null, error: null });
      const req = mode === "find"
        ? post("/find", { query: text, target_uri: scope || ROOT, limit: 20 })
        : mode === "grep"
          ? post("/grep", { uri: scope || ROOT, pattern: text, case_insensitive: true, node_limit: 100 })
          : post("/glob", { pattern: text, uri: scope || ROOT, node_limit: 200 });
      req.then(
        (r) => setState({ loading: false, hits: flattenHits(mode, r), error: null }),
        (e) => setState({ loading: false, hits: null, error: errMsg(e) }),
      );
    };

    return h("div", { className: "ovb-pane" },
      h("form", { className: "ovb-search", style: { padding: 10 }, onSubmit: run },
        h("select", { value: mode, onChange: (e) => setMode(e.target.value), "aria-label": "Search mode" },
          h("option", { value: "find" }, "find (semantic)"),
          h("option", { value: "grep" }, "grep (text)"),
          h("option", { value: "glob" }, "glob (path)")),
        h("input", { className: "q", type: "text", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Query",
          placeholder: mode === "glob" ? "**/*.md" : mode === "grep" ? "text or regex" : "ask in natural language" }),
        h("input", { className: "q", type: "text", value: scope, onChange: (e) => setScope(e.target.value),
          "aria-label": "Scope", title: "Search scope" }),
        h("button", { type: "submit", disabled: state.loading || !q.trim() }, state.loading ? "Searching…" : "Search")),
      state.error ? h("div", { className: "ovb-err", style: { padding: "0 10px 10px" } }, state.error) : null,
      state.hits && state.hits.length === 0 ? h("div", { className: "ovb-muted", style: { padding: 10 } }, "No results") : null,
      (state.hits || []).map((x, i) =>
        h("div", { key: i, className: "ovb-hit", onClick: () => onOpen(x.uri) },
          h("div", { className: "u" }, x.uri, x.badge ? h("span", { className: "ovb-badge" }, x.badge) : null),
          x.text ? h("div", { className: "c" }, x.text.length > 300 ? x.text.slice(0, 300) + "…" : x.text) : null)));
  }

  // ─── sessions + observers ─────────────────────────────────────────
  function Sessions({ tick }) {
    const st = useLoad(() => get("/sessions"), [tick]);
    const items = Array.isArray(result(st.data)) ? result(st.data) : [];
    return h("div", { className: "ovb-pane", style: { padding: 12 } },
      st.loading ? h("div", { className: "ovb-muted" }, "Loading…") : null,
      st.error ? h("div", { className: "ovb-err" }, st.error) : null,
      !st.loading && !st.error && items.length === 0 ? h("div", { className: "ovb-muted" }, "No sessions") : null,
      items.map((s, i) => h("div", { key: i, className: "ovb-hit", style: { cursor: "default" } },
        h("div", { className: "u" }, typeof s === "string" ? s : String(s.session_id || s.id || "session " + (i + 1))),
        typeof s === "object" ? h("pre", null, JSON.stringify(s, null, 2)) : null)));
  }

  function Observers() {
    const [name, setName] = useState("system");
    const st = useLoad(() => get("/observer/" + name), [name]);
    const r = result(st.data);
    return h("div", { className: "ovb-pane", style: { padding: 12, gap: 8 } },
      h("div", { className: "ovb-tabs" },
        OBSERVERS.map((n) => h("button", { key: n, className: name === n ? "on" : "", onClick: () => setName(n) }, n))),
      st.loading ? h("div", { className: "ovb-muted" }, "Loading…") : null,
      st.error ? h("div", { className: "ovb-err" }, st.error) : null,
      r ? h("div", null,
        h("div", { className: "ovb-meta" },
          h("span", null, r.is_healthy === false ? "unhealthy" : "healthy"),
          r.has_errors ? h("span", null, "has errors") : null),
        h("pre", null, typeof r.status === "string" ? r.status : JSON.stringify(r, null, 2))) : null);
  }

  // ─── root ─────────────────────────────────────────────────────────
  function OpenVikingPlugin() {
    const [tab, setTab] = useState("browse");
    const [dir, setDir] = useState(ROOT);
    const [selected, setSelected] = useState(null);
    const [tick, setTick] = useState(0);

    useEffect(() => {
      const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
      return () => clearInterval(id);
    }, []);

    const openFromSearch = (uri) => {
      setDir(parentUri(uri));
      setSelected(uri);
      setTab("browse");
    };

    return h("div", { className: "ovb" },
      h("style", null, CSS),
      h("div", { className: "ovb-head" },
        h("h2", null, "OpenViking"),
        h("span", { className: "ovb-muted" }, "read-only"),
        h("button", { onClick: () => setTick((t) => t + 1) }, "↻ Refresh")),
      h(StatusCards, { tick }),
      h("div", { className: "ovb-tabs" },
        [["browse", "Browse"], ["search", "Search"], ["sessions", "Sessions"], ["observers", "Observers"]].map(([k, label]) =>
          h("button", { key: k, className: tab === k ? "on" : "", onClick: () => setTab(k) }, label))),
      tab === "browse" ? h(Browse, { dir, setDir, selected, setSelected, tick }) : null,
      tab === "search" ? h(Search, { dir, onOpen: openFromSearch }) : null,
      tab === "sessions" ? h(Sessions, { tick }) : null,
      tab === "observers" ? h(Observers, null) : null);
  }

  registry.register("openviking-browser", OpenVikingPlugin);
})();
