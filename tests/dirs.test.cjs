/**
 * Regression tests: the reader must never call /read on a directory.
 *   node tests/dirs.test.cjs
 * The fake backend mirrors live OpenViking shapes: every document is a directory (isDir:true)
 * that contains the real file, `fs/stat` knows the truth, and `content/read` on a directory fails with
 * "Directory URI is not readable as a file". Each scenario asserts the UI never trips that error.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const { JSDOM } = require("jsdom");

const dom = new JSDOM('<!doctype html><div id="root"></div>', { runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
global.IS_REACT_ACT_ENVIRONMENT = true;
global.window = window;
global.document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true, writable: true });

const React = require("react");
const { createRoot } = require("react-dom/client");
const { act } = React;

const PLUGIN = fs.readFileSync(path.join(__dirname, "..", "dashboard", "plugin.js"), "utf8");
const PFX = "/api/plugins/openviking-browser";
const ok = (result) => ({ status: "ok", result, error: null });

const PROJ = "viking://resources/projects";
const DR = PROJ + "/digital-receipt";
const BUILD = DR + "/build-and-versioning.md"; // directory holding exactly one file
const BUILD_FILE = BUILD + "/Digital_Receipt_-_Build_Versioning.md";
const SSO = DR + "/multi-tenancy-and-sso.md"; // directory holding two files
const SSO_FILE_A = SSO + "/Plan.md";
const SSO_FILE_B = SSO + "/Notes.md";
const INVENTORY = PROJ + "/web-apps-inventory.md"; // directory whose stat can be made to fail

const dirEntry = (uri) => ({ uri, size: 0, isDir: true, modTime: "2026-10-05T02:45:04.000Z", abstract: "dir " + uri });
const fileEntry = (uri, size) => ({ uri, size, isDir: false, modTime: "2026-10-05T02:44:43.000Z", abstract: "" });
const TREE = {
  "viking://": [dirEntry("viking://resources")],
  "viking://resources": [dirEntry(PROJ)],
  [PROJ]: [dirEntry(DR), dirEntry(INVENTORY)],
  [DR]: [dirEntry(BUILD), dirEntry(SSO)],
  [BUILD]: [fileEntry(BUILD_FILE, 603)],
  [SSO]: [fileEntry(SSO_FILE_A, 120), fileEntry(SSO_FILE_B, 80)],
  [INVENTORY]: [fileEntry(INVENTORY + "/Inventory.md", 50)],
};
const FILES = new Set([BUILD_FILE, SSO_FILE_A, SSO_FILE_B, INVENTORY + "/Inventory.md"]);

function makeBackend({ statFails = [] } = {}) {
  const b = { calls: [], dirReads: [], reads: [], lsHold: null };
  const upstreamError = (msg) => new Error("400: " + JSON.stringify({ detail: { code: "INVALID_ARGUMENT", message: msg } }));
  b.fetchJSON = async (url, init) => {
    const u = new URL(url, "http://x");
    const p = u.pathname.slice(PFX.length);
    const uri = u.searchParams.get("uri");
    b.calls.push(p + (uri ? " " + uri : ""));
    if (p === "/status") return { health: { healthy: true }, queue_totals: null, vector_count: 1, summary: {}, errors: [] };
    if (p === "/ls") {
      if (b.lsHold && uri === b.lsHold.uri) await b.lsHold.promise;
      return ok(TREE[uri] || []);
    }
    if (p === "/stat") {
      if (statFails.includes(uri)) throw new Error("500: upstream down");
      if (uri === "viking://" || TREE[uri]) return ok({ name: uri, size: 4096, isDir: true, uri, count: (TREE[uri] || []).length });
      if (FILES.has(uri)) return ok({ name: uri, size: 603, isDir: false, uri });
      throw new Error("404: " + JSON.stringify({ detail: { code: "NOT_FOUND", message: "File not found: " + uri } }));
    }
    if (p === "/abstract") return ok("ABSTRACT " + uri);
    if (p === "/overview") return ok("OVERVIEW " + uri);
    if (p === "/read") {
      b.reads.push(uri);
      if (uri === "viking://" || TREE[uri]) {
        b.dirReads.push(uri);
        throw upstreamError("Directory URI is not readable as a file: " + uri + ". List it first, then read a file URI.");
      }
      return ok("CONTENT OF " + uri);
    }
    if (p === "/find") {
      return ok({ memories: [], skills: [], resources: [
        { uri: BUILD, abstract: "dir hit", score: 0.9 },
        { uri: BUILD_FILE, abstract: "file hit", score: 0.8 },
      ] });
    }
    throw new Error("404: unexpected " + p);
  };
  return b;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function settle() { for (let i = 0; i < 6; i++) await act(async () => { await tick(5); }); }

async function mount(backend) {
  let Component = null;
  window.__HERMES_PLUGINS__ = { register: (_name, c) => { Component = c; } };
  window.__HERMES_PLUGIN_SDK__ = { React, fetchJSON: backend.fetchJSON };
  window.eval(PLUGIN);
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Component)); });
  await settle();
  const ui = {
    text: () => { const c = host.cloneNode(true); c.querySelectorAll("style").forEach((n) => n.remove()); return c.textContent; },
    buttons: () => [...host.querySelectorAll("button")],
    byText: (t) => ui.buttons().find((b) => b.textContent.trim() === t),
    byPrefix: (t) => ui.buttons().find((b) => b.textContent.trim().startsWith(t)),
    row: (name) => [...host.querySelectorAll(".ovb-row .main")].find((r) => r.textContent.includes(name)),
    openBtn: (name) => host.querySelector('button.go[aria-label="Open ' + name + '"]'),
    crumb: (label) => [...host.querySelectorAll(".ovb-crumbs button")].find((b) => b.textContent === label),
    hit: (label) => [...host.querySelectorAll(".ovb-hit")].find((h) => h.textContent.includes(label)),
    click: async (el) => {
      assert(el, "element to click exists");
      await act(async () => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
      await settle();
    },
    hasContentTab: () => !!ui.byText("content"),
    search: async (query) => {
      await ui.click(ui.byText("Search"));
      const input = host.querySelector("input[aria-label=Query]");
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, query);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await act(async () => { host.querySelector("button[type=submit]").form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
      await settle();
    },
    unmount: async () => { await act(async () => root.unmount()); host.remove(); },
  };
  return ui;
}

async function gotoDigitalReceipt(ui) {
  await ui.click(ui.openBtn("resources"));
  await ui.click(ui.openBtn("projects"));
  await ui.click(ui.openBtn("digital-receipt"));
  assert(/build-and-versioning\.md/.test(ui.text()), "digital-receipt listing shown");
}

const NOT_READABLE = /not readable as a file/i;
const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

scenario("select a directory entry in the list: no content tab, no read", async () => {
  const b = makeBackend();
  const ui = await mount(b);
  await gotoDigitalReceipt(ui);
  await ui.click(ui.row("build-and-versioning.md"));
  assert(!ui.hasContentTab(), "no content tab for dir entry");
  assert.deepStrictEqual(b.reads, []);
  assert(!NOT_READABLE.test(ui.text()));
  await ui.unmount();
});

scenario("open a directory with the > button: selected dir is not in its own listing, still no content tab", async () => {
  const b = makeBackend();
  const ui = await mount(b);
  await gotoDigitalReceipt(ui);
  await ui.click(ui.openBtn("build-and-versioning.md"));
  assert(b.calls.includes("/stat " + BUILD), "dir-ness resolved through /stat");
  assert(!ui.hasContentTab(), "no content tab for the opened directory");
  assert.deepStrictEqual(b.dirReads, []);
  assert(!NOT_READABLE.test(ui.text()));
  await ui.unmount();
});

scenario("breadcrumb click selects a directory: no content tab, no read (also the viking:// root)", async () => {
  const b = makeBackend();
  const ui = await mount(b);
  await gotoDigitalReceipt(ui);
  for (const label of ["digital-receipt", "projects", "viking://"]) {
    await ui.click(ui.crumb(label));
    assert(!ui.hasContentTab(), "no content tab for crumb " + label);
  }
  assert.deepStrictEqual(b.reads, []);
  await ui.unmount();
});

scenario("a directory holding exactly one file offers 'open nested file'", async () => {
  const b = makeBackend();
  const ui = await mount(b);
  await gotoDigitalReceipt(ui);
  await ui.click(ui.openBtn("build-and-versioning.md"));
  const open = ui.byPrefix("Open Digital_Receipt_-_Build_Versioning.md");
  assert(open, "nested-file button offered; text: " + ui.text());
  await ui.click(open);
  assert(ui.hasContentTab(), "file has content tab");
  assert.strictEqual(b.reads.length, 0, "nothing read before the user asks");
  await ui.click(ui.byText("content"));
  assert.deepStrictEqual(b.reads, [BUILD_FILE]);
  assert(ui.text().includes("CONTENT OF " + BUILD_FILE), "nested file content rendered");
  await ui.unmount();
});

scenario("the nested-file offer also shows when the directory is only selected from the list", async () => {
  const b = makeBackend();
  const ui = await mount(b);
  await gotoDigitalReceipt(ui);
  await ui.click(ui.row("build-and-versioning.md"));
  const open = ui.byPrefix("Open Digital_Receipt_-_Build_Versioning.md");
  assert(open, "nested-file button offered on a plain selection");
  await ui.click(open);
  assert(ui.hasContentTab());
  assert.deepStrictEqual(b.dirReads, []);
  await ui.unmount();
});

scenario("a directory with several files offers no single-file shortcut", async () => {
  const b = makeBackend();
  const ui = await mount(b);
  await gotoDigitalReceipt(ui);
  await ui.click(ui.openBtn("multi-tenancy-and-sso.md"));
  assert(!ui.hasContentTab());
  assert(!ui.byPrefix("Open Plan.md") && !ui.byPrefix("Open Notes.md"), "no single-file shortcut");
  assert(ui.row("Plan.md") && ui.row("Notes.md"), "both files visible in the listing");
  assert.deepStrictEqual(b.dirReads, []);
  await ui.unmount();
});

scenario("search hit for a directory URI (entry unknown): no content tab, no read", async () => {
  const b = makeBackend();
  const ui = await mount(b);
  await ui.search("build");
  await ui.click(ui.hit("dir hit"));
  assert(window.document.querySelector(".ovb-split"), "Browse opened");
  assert(!ui.hasContentTab(), "no content tab for a directory coming from search");
  assert.deepStrictEqual(b.dirReads, []);
  assert(!NOT_READABLE.test(ui.text()));
  await ui.unmount();
});

scenario("search hit for a directory while its parent listing is still loading: no content tab, no read", async () => {
  const b = makeBackend();
  const ui = await mount(b);
  await ui.search("build");
  let release;
  b.lsHold = { uri: DR, promise: new Promise((r) => { release = r; }) };
  await ui.click(ui.hit("dir hit"));
  assert(!ui.hasContentTab(), "no content tab before the listing arrives");
  assert.deepStrictEqual(b.dirReads, []);
  release();
  await settle();
  assert(!ui.hasContentTab(), "no content tab after the listing arrives");
  assert.deepStrictEqual(b.dirReads, []);
  await ui.unmount();
});

scenario("search hit for a file URI (entry unknown): content tab appears once stat says file", async () => {
  const b = makeBackend();
  const ui = await mount(b);
  await ui.search("build");
  await ui.click(ui.hit("file hit"));
  assert(ui.hasContentTab(), "file from search is readable");
  await ui.click(ui.byText("content"));
  assert.deepStrictEqual(b.reads, [BUILD_FILE]);
  await ui.unmount();
});

scenario("content mode does not leak into the next selection (file after file, directory after file)", async () => {
  const b = makeBackend();
  const ui = await mount(b);
  await gotoDigitalReceipt(ui);
  await ui.click(ui.openBtn("multi-tenancy-and-sso.md"));
  await ui.click(ui.row("Plan.md"));
  await ui.click(ui.byText("content"));
  assert.deepStrictEqual(b.reads, [SSO_FILE_A], "read the file once");
  await ui.click(ui.row("Notes.md"));
  assert(/ABSTRACT /.test(ui.text()), "next selection starts on the abstract tab");
  assert.strictEqual(b.reads.length, 1, "no read fired for the next selection");
  // a directory replaces a file while the previous reader was in content mode
  await ui.click(ui.row("Plan.md"));
  await ui.click(ui.byText("content"));
  const before = b.reads.length;
  await ui.click(ui.crumb("digital-receipt"));
  await ui.click(ui.row("build-and-versioning.md"));
  assert.strictEqual(b.reads.length, before, "no read when a directory replaces a file in content mode");
  assert.deepStrictEqual(b.dirReads, []);
  assert(!ui.hasContentTab());
  await ui.unmount();
});

scenario("stat failure on an unknown directory: raw backend error becomes a friendly hint", async () => {
  const b = makeBackend({ statFails: [INVENTORY] });
  const ui = await mount(b);
  await ui.click(ui.openBtn("resources"));
  await ui.click(ui.openBtn("projects"));
  await ui.click(ui.openBtn("web-apps-inventory.md"));
  // stat failed, so dir-ness is unknown: the tab may be offered, but using it must not show the raw error
  assert(ui.hasContentTab(), "content tab stays available when dir-ness is unknown");
  await ui.click(ui.byText("content"));
  assert(!NOT_READABLE.test(ui.text()), "raw 'not readable as a file' error is never shown: " + ui.text());
  assert(/This is a directory/.test(ui.text()), "friendly directory hint shown");
  assert(!ui.hasContentTab(), "content tab withdrawn once the backend says directory");
  await ui.unmount();
});

(async () => {
  let failed = 0;
  for (const [name, fn] of scenarios) {
    try {
      await fn();
      console.log("  ok   " + name);
    } catch (e) {
      failed++;
      console.log("  FAIL " + name + "\n       " + String((e && e.message) || e).split("\n").slice(0, 3).join(" | ").slice(0, 400));
    }
  }
  console.log(failed ? "DIRS FAIL (" + failed + "/" + scenarios.length + ")" : "DIRS OK (" + scenarios.length + " scenarios)");
  process.exit(failed ? 1 : 0);
})();
