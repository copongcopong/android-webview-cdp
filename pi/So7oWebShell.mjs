#!/usr/bin/env node
// Drive the installed So7o Android WebView shell over CDP: status, launch,
// web search, page read, and raw JS. Node 22+; no dependencies.
//
//   node So7oWebShell.mjs status
//   node So7oWebShell.mjs launch
//   node So7oWebShell.mjs search "query" [limit]
//   node So7oWebShell.mjs read https://example.com [maxChars]
//   node So7oWebShell.mjs js 'document.title'
//
// The app serves its relay on 127.0.0.1:9334; no adb is needed. If the relay is
// down, launch() asks the `55-so7o.owl` launcher tile (on home) to open the app.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const RELAY = "http://127.0.0.1:9334";
const LAUNCH_WIDGET = "So7oWebShell.owl";
const LAUNCH_STATE = "launch";
const DEFAULT_LIMIT = 6;
const MAX_TEXT = 20000;

async function fetchJson(path, timeout = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(RELAY + path, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function visibleOf(t) {
  try {
    return !!JSON.parse(t.description || "{}").visible;
  } catch {
    return false;
  }
}

// Size of the payload the model will see. Not a billing figure: model
// tokenizers differ, and the JSON is pretty-printed by the MCP server.
function usageOf(text) {
  const chars = text.length;
  const words = (text.match(/\S+/g) || []).length;
  return { chars, words, approx_tokens: Math.ceil(chars / 3.5) };
}

async function relayUp() {
  try {
    await fetchJson("/json/version", 1500);
    return true;
  } catch {
    return false;
  }
}

export async function status() {
  try {
    const v = await fetchJson("/json/version");
    let targets = [];
    try {
      targets = await fetchJson("/json");
    } catch {
      // The relay was up for /json/version; targets are a bonus.
    }
    return {
      running: true,
      package: v["Android-Package"] ?? null,
      browser: v.Browser ?? null,
      targets: targets
        .filter((t) => t.type === "page")
        .map((t) => ({ id: t.id, title: t.title, url: t.url, visible: visibleOf(t) })),
    };
  } catch (e) {
    return { running: false, error: String(e.message || e) };
  }
}

export async function launch({ waitMs = 12000 } = {}) {
  if (await relayUp()) return { running: true, launched: false };
  const stamp = String(Date.now());
  try {
    await exec("owl-send", [LAUNCH_WIDGET, "set", LAUNCH_STATE, stamp], { timeout: 5000 });
  } catch (e) {
    throw new Error(
      `could not ask ${LAUNCH_WIDGET} to launch So7o (${e.stderr || e.message}); ` +
        "is the so7o tile on home? If not, open So7o from the app drawer."
    );
  }
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    if (await relayUp()) return { running: true, launched: true };
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    "So7o did not come up: its CDP relay 127.0.0.1:9334 is not reachable. " +
      "Open So7o from the so7o tile or the app drawer, then retry."
  );
}

async function ensure() {
  const s = await status();
  if (!s.running) await launch();
}

class CDP {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket timeout")), 8000);
      this.ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      this.ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CDP websocket error"));
        },
        { once: true }
      );
    });
    this.ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id != null && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error)));
        else resolve(m.result);
      } else if (m.method) {
        for (const fn of this.listeners.get(m.method) || []) fn(m.params);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, 20000);
    });
  }

  once(method, timeout = 20000) {
    return new Promise((resolve) => {
      const fn = (params) => {
        clearTimeout(timer);
        this.off(method, fn);
        resolve(params);
      };
      const timer = setTimeout(() => {
        this.off(method, fn);
        resolve(null);
      }, timeout);
      this.on(method, fn);
    });
  }

  on(method, fn) {
    const a = this.listeners.get(method) || [];
    a.push(fn);
    this.listeners.set(method, a);
  }

  off(method, fn) {
    const a = this.listeners.get(method) || [];
    this.listeners.set(
      method,
      a.filter((x) => x !== fn)
    );
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

async function target() {
  const s = await status();
  if (!s.running) throw new Error("So7o is not running");
  if (!s.targets.length) throw new Error("So7o has no page target yet");
  return s.targets.find((t) => t.visible) || s.targets[0];
}

async function connect() {
  await ensure();
  const t = await target();
  const c = new CDP(`ws://127.0.0.1:9334/devtools/page/${t.id}`);
  await c.open();
  await c.send("Page.enable").catch(() => {});
  await c.send("Runtime.enable").catch(() => {});
  return { c, t };
}

async function evaluate(c, expression) {
  const r = await c.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ||
        r.exceptionDetails.text ||
        "page exception"
    );
  }
  return r.result?.value;
}

async function navigate(c, url) {
  const loaded = c.once("Page.loadEventFired", 20000);
  await c.send("Page.navigate", { url });
  await loaded;
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate(c, "document.readyState").catch(() => null);
    if (ready === "complete") break;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitFor(c, selector, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const ok = await evaluate(c, `!!document.querySelector(${JSON.stringify(selector)})`).catch(
      () => false
    );
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const BING_EXTRACT = `(() => {
  const out = [];
  const seen = new Set();
  const decode = (href) => {
    try {
      const u = new URL(href, location.href);
      const p = u.searchParams.get("u");
      if (p && p.startsWith("a1")) {
        let s = p.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        while (s.length % 4) s += "=";
        return atob(s);
      }
    } catch {}
    return href;
  };
  for (const li of document.querySelectorAll("li.b_algo")) {
    const a = li.querySelector("h2 a");
    if (!a) continue;
    const title = (li.querySelector("h2")?.innerText || a.innerText || "").trim();
    const url = decode(a.href);
    const cite = (li.querySelector("cite")?.innerText || "").trim();
    const snippet = (li.querySelector(".b_caption p, .b_snippet, p")?.innerText || "").trim();
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, cite, snippet });
  }
  return JSON.stringify(out);
})()`;

export async function search(query, { limit = DEFAULT_LIMIT } = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("empty query");
  const n = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 10));
  // Keep the URL bare: Bing serves junk when count/setlang are added here.
  const url = "https://www.bing.com/search?q=" + encodeURIComponent(q);
  const { c, t } = await connect();
  try {
    await navigate(c, url);
    await waitFor(c, "li.b_algo", 8000);
    let results = JSON.parse((await evaluate(c, BING_EXTRACT)) || "[]");
    if (!results.length) {
      const alt = await evaluate(
        c,
        `JSON.stringify([...document.querySelectorAll("h2 a")].slice(0, ${n * 2}).map(a => ({title:(a.innerText||"").trim(),url:a.href,snippet:""})).filter(x => x.title && x.url && !x.url.includes("bing.com")))`
      );
      results = JSON.parse(alt || "[]");
    }
    results = results.slice(0, n);
    const pageNote = results.length
      ? ""
      : (await evaluate(c, "document.body.innerText.slice(0,300)").catch(() => ""))
          .replace(/\s+/g, " ")
          .slice(0, 160);
    const payload = {
      query: q,
      engine: "bing",
      results,
      target: { id: t.id, title: t.title, url: t.url },
      ...(results.length ? {} : { note: pageNote ? `No results; page says: ${pageNote}` : "No results" }),
    };
    return { ...payload, usage: usageOf(JSON.stringify(payload)) };
  } finally {
    c.close();
  }
}

export async function readPage(url, { maxChars = MAX_TEXT } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error("read needs an http(s) URL");
  const cap = Math.max(1000, Math.min(Number(maxChars) || MAX_TEXT, 60000));
  const { c, t } = await connect();
  try {
    await navigate(c, url);
    await waitFor(c, "body", 8000);
    const raw = await evaluate(
      c,
      `(() => {
        const pick = document.querySelector("article, main, [role=main]") || document.body;
        const text = (pick?.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim();
        return JSON.stringify({ title: document.title, url: location.href, text: text.slice(0, ${cap}) });
      })()`
    );
    const payload = { ...JSON.parse(raw || "{}"), target: { id: t.id, title: t.title } };
    return { ...payload, usage: usageOf(JSON.stringify(payload)) };
  } finally {
    c.close();
  }
}

export async function js(expression) {
  const { c } = await connect();
  try {
    return await evaluate(c, expression);
  } finally {
    c.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...args] = process.argv.slice(2);
  const usage = `usage:
  node So7oWebShell.mjs status
  node So7oWebShell.mjs launch
  node So7oWebShell.mjs search "query" [limit]
  node So7oWebShell.mjs read URL [maxChars]
  node So7oWebShell.mjs js "expression"`;
  const out = (o) => console.log(JSON.stringify(o, null, 2));
  try {
    if (cmd === "status") out(await status());
    else if (cmd === "launch") out(await launch());
    else if (cmd === "search") {
      let limit;
      if (/^\d+$/.test(args.at(-1) || "")) limit = Number(args.pop());
      out(await search(args.join(" "), { limit }));
    } else if (cmd === "read") {
      out(await readPage(args[0], { maxChars: args[1] }));
    } else if (cmd === "js") {
      console.log(JSON.stringify(await js(args.join(" "))));
    } else {
      console.error(usage);
      process.exit(2);
    }
  } catch (e) {
    console.error("error:", e.message || e);
    process.exit(1);
  }
}
