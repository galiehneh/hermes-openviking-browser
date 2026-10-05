/**
 * Render test for dashboard/plugin.js using jsdom + the Hermes React copy.
 *   node tests/render.test.cjs                       -> canned OpenViking-shaped responses
 *   OVB_API=http://127.0.0.1:9199 node tests/render.test.cjs   -> a running API (optional, manual)
 * Dev dependencies (jsdom, react, react-dom) come from package.json: `npm install`.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const { JSDOM } = require("jsdom");

// react-dom reads `window` at load time (canUseDOM), so the DOM must exist before it is required.
const dom = new JSDOM('<!doctype html><div id="root"></div>', { runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
global.IS_REACT_ACT_ENVIRONMENT = true;
global.window = window;
global.document = window.document;

const React = require("react");
const { createRoot } = require("react-dom/client");
const { act } = React;

const PLUGIN = fs.readFileSync(path.join(__dirname, "..", "dashboard", "plugin.js"), "utf8");
const REAL_API = process.env.OVB_API || "";
const PFX = "/api/plugins/openviking-browser";
const XSS = '<img src=x onerror="window.__xss=1">';

const calls = [];
const ok = (result) => ({ status: "ok", result, error: null });

function canned(url, init) {
  const u = new URL(url, "http://x");
  const p = u.pathname.slice(PFX.length);
  const uri = u.searchParams.get("uri");
  if (p === "/status") {
    return {
      health: { status: "ok", healthy: true, version: "v0.4.23", auth_mode: "api_key", account_id: "default", user_id: "agent" },
      queue: { is_healthy: true }, queue_totals: { pending: 0, in_progress: 1, processed: 44, requeued: 0, errors: 0 },
      vector_count: 59,
      summary: { context_counts: { files: 25, skills: 2, memories: 2, total: 29 },
        today_tokens: { vlm_input: 10, vlm_output: 5, total: 15 }, today_retrievals: { find: 2, search: 0, total: 2 } },
      errors: [],
    };
  }
  if (p === "/ls") {
    if (uri === "viking://") return ok([{ uri: "viking://resources", size: 0, isDir: true, modTime: "2026-10-05T03:22:54.000Z", abstract: "Top " + XSS }]);
    if (uri === "viking://resources") return ok([
      { uri: "viking://resources/projects", size: 0, isDir: true, modTime: "2026-10-05T03:22:54.000Z", abstract: "Projects dir" },
      { uri: "viking://resources/a.md", size: 2048, isDir: false, abstract: "A file" },
    ]);
    return ok([]);
  }
  if (p === "/abstract") return ok("ABSTRACT of " + uri + " " + XSS);
  if (p === "/overview") return ok("OVERVIEW of " + uri);
  if (p === "/read") return ok("line1\nline2");
  if (p === "/find") return ok({ memories: [], resources: [{ uri: "viking://resources/projects/x.md/.abstract.md", abstract: "found it", score: 0.78 }], skills: [] });
  if (p === "/grep") return ok({ matches: [{ line: 3, uri: "viking://resources/a.md", content: "needle" }] });
  if (p === "/glob") return ok({ matches: ["viking://resources/a.md"] });
  if (p === "/sessions") return ok([]);
  if (p.startsWith("/observer/")) return ok({ name: p.slice(10), is_healthy: true, has_errors: false, status: "STATUS-" + p.slice(10) });
  throw new Error("404: unexpected " + p);
}

async function fetchJSON(url, init) {
  calls.push({ url, method: (init && init.method) || "GET", body: init && init.body });
  if (REAL_API) {
    const r = await fetch(REAL_API + url, init);
    const text = await r.text();
    if (!r.ok) throw new Error(r.status + ": " + text);
    return JSON.parse(text);
  }
  return canned(url, init);
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function settle() { for (let i = 0; i < 6; i++) await act(async () => { await tick(REAL_API ? 150 : 5); }); }

(async () => {
  let Component = null;
  window.__HERMES_PLUGINS__ = { register: (name, c) => { assert.strictEqual(name, "openviking-browser"); Component = c; } };
  window.__HERMES_PLUGIN_SDK__ = { React, fetchJSON };
  window.eval(PLUGIN);
  assert(Component, "plugin did not register a component");

  const root = createRoot(window.document.getElementById("root"));
  await act(async () => { root.render(React.createElement(Component)); });
  await settle();

  const text = () => window.document.body.textContent;
  const buttons = () => [...window.document.querySelectorAll("button")];
  const click = async (el) => { assert(el, "element to click exists"); await act(async () => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }); await settle(); };
  const byText = (t) => buttons().find((b) => b.textContent.trim() === t);
  const submitBtn = () => window.document.querySelector("button[type=submit]");

  // status cards
  assert(/Healthy/.test(text()), "health card");
  assert(/v0\.4\.23/.test(text()), "version");
  if (!REAL_API) assert(/59/.test(text()), "vector count");
  else assert(/Vectors/.test(text()), "vectors card (real)");

  // tree + XSS safety
  assert(/resources/.test(text()), "root listing shows resources");
  assert(!window.document.querySelector("img"), "no <img> injected from stored content");
  assert(!window.__xss, "no script executed");

  // navigate: open resources via the › button
  const openBtn = window.document.querySelector('button.go[aria-label="Open resources"]')
    || window.document.querySelector("button.go");
  assert(openBtn, "dir has an open button");
  const opened = openBtn.getAttribute("aria-label").replace(/^Open /, "");
  await click(openBtn);
  assert(calls.some((c) => c.url.includes("/ls?") && decodeURIComponent(c.url).includes("uri=viking://" + opened)),
    "ls of " + opened + " requested");

  if (!REAL_API) {
    assert(/projects/.test(text()) && /a\.md/.test(text()), "children listed");
    // select a file -> abstract shown, then overview and content
    await click(window.document.querySelector(".ovb-row .main"));
    assert(/ABSTRACT of/.test(text()), "abstract rendered");
    assert(!window.document.querySelector("img"), "abstract rendered as text only");
    await click(byText("overview"));
    assert(/OVERVIEW of/.test(text()), "overview rendered");
    await click(byText("content"));
    assert(/line1/.test(text()) && /line2/.test(text()), "content rendered");
    assert(calls.some((c) => c.url.includes("/read?")), "read requested");

    // search find / grep / glob
    await click(byText("Search"));
    const input = window.document.querySelector("input[aria-label=Query]");
    const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    for (const [mode, expect] of [["find", /found it/], ["grep", /needle/], ["glob", /viking:\/\/resources\/a\.md/]]) {
      const sel = window.document.querySelector("select");
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(sel, mode);
        sel.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
      await act(async () => { setVal.call(input, "q-" + mode); input.dispatchEvent(new window.Event("input", { bubbles: true })); });
      await act(async () => { submitBtn().form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
      await settle();
      assert(expect.test(text()), mode + " results rendered");
      const last = calls.filter((c) => c.method === "POST").pop();
      assert(last.url === PFX + "/" + mode, "POST to /" + mode);
    }
    // clicking a hit opens it in Browse
    await click(window.document.querySelector(".ovb-hit"));
    assert(window.document.querySelector(".ovb-split"), "back to browse after opening a hit");

    // sessions + observers
    await click(byText("Sessions"));
    assert(/No sessions/.test(text()), "empty sessions state");
    await click(byText("Observers"));
    assert(/STATUS-system/.test(text()), "observer shown");
    await click(byText("queue"));
    assert(/STATUS-queue/.test(text()), "observer switch");
  } else {
    await click(window.document.querySelector(".ovb-row .main"));
    await click(byText("Search"));
    await click(byText("Sessions"));
    await click(byText("Observers"));
    assert(/healthy|unhealthy/.test(text()), "observer shown (real)");
  }

  // read-only: UI only ever issues GETs plus find/grep/glob POSTs
  for (const c of calls) {
    assert(c.url.startsWith(PFX + "/"), "only plugin routes used: " + c.url);
    if (c.method !== "GET") assert(/\/(find|grep|glob)$/.test(c.url), "unexpected write-ish call " + c.method + " " + c.url);
  }
  console.log("RENDER OK (" + (REAL_API ? "real API" : "canned") + "), calls: " + calls.length);
  await act(async () => root.unmount());
  process.exit(0);
})().catch((e) => { console.error("RENDER FAIL:", e && e.stack || e); process.exit(1); });
