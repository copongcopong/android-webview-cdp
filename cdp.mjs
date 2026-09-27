#!/usr/bin/env node
// Drive the So7o Android WebView shell over the Chrome DevTools Protocol.
// No dependencies — Node 22+ ships a global WebSocket.
//
//   node cdp.mjs '<js expression>'          evaluate in the page (default action)
//   node cdp.mjs --list                     show page targets
//   node cdp.mjs --click 'button'           real mouse input (CSS selector or text=…)
//   node cdp.mjs --type 'hello'             Input.insertText into the focused element
//   node cdp.mjs --key Enter                key press (Enter Tab Escape Backspace
//                                           Delete ArrowUp/Down/Left/Right Home End PageUp/Down)
//   node cdp.mjs --nav https://example.com  navigate + wait for load
//   node cdp.mjs --wait '#ready'            poll for a selector
//   node cdp.mjs --shot page.png            screenshot the page
//   node cdp.mjs --device pixel-7                emulate a common phone viewport
//                                                (scale factor is clamped to the display surface)
//   node cdp.mjs --list-devices                  available device profiles
//   node cdp.mjs --metrics 412x915x2.625         custom viewport (CSS px x dsf)
//   node cdp.mjs --reset-device                  drop the override
//   node cdp.mjs --repl                          interactive session (.help for meta commands)
//
//   PORT=9334 node cdp.mjs …                pin the endpoint (default: try 9334, then 9333)
//   DEBUG=1 node cdp.mjs …                  also stream CDP events (console, loads, …)
//
// Actions run in the order above (nav → wait → click → type → key → expression → shot),
// so one invocation can do a whole sequence.

import { writeFileSync } from 'node:fs';
import readline from 'node:readline';

const PORT = process.env.PORT || null;
// Relay (in-app) first, then the adb-forwarded port. Both are 127.0.0.1 on the
// device, so whichever path is up wins; set PORT to pin one explicitly.
const CANDIDATE_PORTS = PORT ? [PORT] : [9334, 9333];
let BASE = `http://127.0.0.1:${CANDIDATE_PORTS[0]}`;
const TIMEOUT = Number(process.env.CDP_TIMEOUT || 15000);

// ---------------------------------------------------------------- arg parsing
const argv = process.argv.slice(2);
const opt = { rest: [] };
const KEY_FLAGS = {
  '--click': 'click', '--type': 'type', '--key': 'key', '--nav': 'nav',
  '--wait': 'wait', '--shot': 'shot', '--screenshot': 'shot', '--target': 'target',
  '--device': 'device', '--metrics': 'metrics',
};

// CSS px + deviceScaleFactor. These describe the *test viewport*, independent of the
// physical display: the headless/floating virtual display only has to be big enough.
const DEVICES = {
  'iphone-se': { w: 375, h: 667, dsf: 2, ua: 'iphone' },
  'iphone-14': { w: 390, h: 844, dsf: 3, ua: 'iphone' },
  'iphone-15-pro': { w: 393, h: 852, dsf: 3, ua: 'iphone' },
  'pixel-7': { w: 412, h: 915, dsf: 2.625, ua: 'android' },
  'pixel-8-pro': { w: 448, h: 998, dsf: 2.625, ua: 'android' },
  'galaxy-s23': { w: 360, h: 780, dsf: 3, ua: 'android' },
  'galaxy-s24-ultra': { w: 384, h: 824, dsf: 3.5, ua: 'android' },
  'zfold-inner': { w: 805, h: 967, dsf: 2.25, ua: 'android' },   // this device, unfolded
  'ipad-mini': { w: 744, h: 1133, dsf: 2, ua: 'ipad' },
};
const UAS = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--repl') opt.repl = true;
  else if (a === '--list') opt.list = true;
  else if (a === '--list-devices') opt.listDevices = true;
  else if (a === '--reset-device') opt.resetDevice = true;
  else if (a === '--no-clamp') opt.noClamp = true;
  else if (a === '-h' || a === '--help') opt.help = true;
  else if (KEY_FLAGS[a]) opt[KEY_FLAGS[a]] = argv[++i];
  else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); process.exit(2); }
  else opt.rest.push(a);
}
const expression = opt.rest.join(' ');
// Console output is the interesting part of a REPL session, noise for one-shots.
const STREAM_CONSOLE = !!(opt.repl || process.env.DEBUG);

if (opt.listDevices) {
  for (const [name, d] of Object.entries(DEVICES)) {
    console.log(`${name.padEnd(18)} ${String(d.w).padStart(4)}x${String(d.h).padEnd(5)} @${d.dsf}x  mobile  ${d.ua}`);
  }
  process.exit(0);
}

/** Returns the profile to apply, or null. */
function deviceProfile() {
  if (opt.resetDevice) return null;
  if (opt.metrics) {
    const m = /^(\d+)x(\d+)(?:x([\d.]+))?$/.exec(opt.metrics);
    if (!m) throw new Error('--metrics wants WxH or WxHxDSF, e.g. 412x915x2.625');
    return { w: +m[1], h: +m[2], dsf: m[3] ? +m[3] : 1, ua: 'android' };
  }
  if (opt.device) {
    const d = DEVICES[opt.device];
    if (!d) throw new Error(`unknown device '${opt.device}' — try --list-devices`);
    return d;
  }
  return null;
}

if (opt.help) {
  console.log(await (await import('node:fs')).promises.readFile(new URL(import.meta.url), 'utf8')
    .then((s) => s.split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')));
  process.exit(0);
}

// ---------------------------------------------------------------- transport
const KEYCODES = {
  Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'],
  Delete: [46, 'Delete'], Home: [36, 'Home'], End: [35, 'End'],
  ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'],
  ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
  PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], Space: [32, 'Space'],
};

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  let waiters = [];
  const state = { ws, url: wsUrl, endReplay: () => { replayed = false; } };
  let replayed = true;

  state.ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('websocket failed: is the forward up? (./cdp-webview.sh up)')); });

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.rej(new Error(`${m.method || ''} ${JSON.stringify(m.error)}`)) : p.res(m.result);
      return;
    }
    // events
    if (m.method === 'Runtime.consoleAPICalled') {
      // Runtime.enable replays buffered console entries; skip them, they are
      // history from before this connection, not live output.
      if (!STREAM_CONSOLE || replayed) return;
      const text = (m.params.args || []).map((a) => (a.value !== undefined ? JSON.stringify(a.value) : a.description ?? a.type)).join(' ');
      console.error(`  [${m.params.type}] ${text}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      if (replayed && !STREAM_CONSOLE) return;
      console.error(`  [exception] ${m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text}`);
    } else if (m.method === 'Log.entryAdded') {
      if (!STREAM_CONSOLE || replayed) return;
      console.error(`  [log:${m.params.entry.level}] ${m.params.entry.text}`);
    } else if (process.env.DEBUG) {
      console.error(`  [event] ${m.method}`);
    }
    for (const w of waiters.filter((w) => w.method === m.method)) { w.done = true; w.res(m.params); }
    waiters = waiters.filter((w) => !w.done);
  };

  state.send = (method, params = {}) => {
    const myId = ++id;
    return new Promise((res, rej) => {
      pending.set(myId, { res, rej });
      ws.send(JSON.stringify({ id: myId, method, params }));
      setTimeout(() => { if (pending.delete(myId)) rej(new Error(`timeout after ${TIMEOUT}ms: ${method}`)); }, TIMEOUT);
    });
  };
  state.waitEvent = (method, ms = TIMEOUT) => new Promise((res, rej) => {
    const w = { method, res };
    waiters.push(w);
    setTimeout(() => { if (!w.done) { waiters = waiters.filter((x) => x !== w); rej(new Error(`no ${method} within ${ms}ms`)); } }, ms);
  });
  return state;
}

const evaluate = async (c, expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

async function pageTargets() {
  let list;
  let lastErr;
  for (const port of CANDIDATE_PORTS) {
    try {
      list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) })).json();
      BASE = `http://127.0.0.1:${port}`;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!list) {
    throw new Error(`no CDP endpoint on ${CANDIDATE_PORTS.map((p) => '127.0.0.1:' + p).join(' or ')}`
      + `\n  run ./cdp-webview.sh up  (or start the app, which relays on 9334)`
      + `\n  (${lastErr && lastErr.message})`);
  }
  return list.filter((t) => t.type === 'page');
}

/**
 * The WebView DevTools server keeps a target per WebView ever created in the
 * process, so an Activity that has been recreated (display move, rotation) leaves
 * dead targets behind. Picking `list[0]` would then read one page and click
 * another, so probe each and prefer the one that is actually visible.
 */
async function chooseTarget(pages) {
  if (opt.target) {
    const pinned = pages.find((p) => p.id === opt.target);
    if (!pinned) throw new Error(`no page target with id ${opt.target}`);
    return pinned;
  }
  let firstLive = null;
  for (const p of pages) {
    const probe = connect(p.webSocketDebuggerUrl);
    try {
      await Promise.race([probe.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('no ws')), 2500))]);
      const r = await probe.send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true });
      if (!firstLive) firstLive = p;
      if (r.result.value === 'visible') { if (pages.length > 1) console.error(`# ${pages.length} page targets; using visible one (${p.id})`); return p; }
    } catch (e) {
      // dead target — expected after an Activity recreation
    } finally {
      try { probe.ws.close(); } catch (e) {}
    }
  }
  if (firstLive) {
    if (pages.length > 1) console.error(`# ${pages.length} page targets, none visible; using ${firstLive.id} (pin with --target)`);
    return firstLive;
  }
  throw new Error(`${pages.length} page targets, none answered. ids: ${pages.map((p) => p.id).join(', ')}`);
}

// ---------------------------------------------------------------- actions
const selectorExpr = (sel) => sel.startsWith('text=')
  ? `(()=>{const n=${JSON.stringify(sel.slice(5).toLowerCase())};
      const hits=[...document.querySelectorAll('body *')].filter(e=>e.textContent.trim().toLowerCase().includes(n));
      hits.sort((a,b)=>a.textContent.length-b.textContent.length); return hits[0];})()`
  : `document.querySelector(${JSON.stringify(sel)})`;

async function click(c, sel) {
  const rect = await evaluate(c, `(()=>{const e=${selectorExpr(sel)};
    if(!e) return null; const r=e.getBoundingClientRect();
    return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), tag:e.tagName};})()`);
  if (!rect) throw new Error(`no element matches ${sel}`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await c.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
  }
  console.log(`clicked ${rect.tag} at ${rect.x},${rect.y}`);
}

async function pressKey(c, name) {
  const k = KEYCODES[name];
  if (!k) throw new Error(`unknown key ${name}; known: ${Object.keys(KEYCODES).join(' ')}`);
  const [code, key] = k;
  for (const type of ['keyDown', 'keyUp']) {
    await c.send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, key, code: key });
  }
  console.log(`pressed ${name}`);
}

async function waitFor(c, sel, ms = TIMEOUT) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await evaluate(c, `!!${selectorExpr(sel)}`)) { console.log(`found ${sel}`); return true; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${sel}`);
}

async function navigate(c, url) {
  const loaded = c.waitEvent('Page.loadEventFired', TIMEOUT).catch(() => null);
  await c.send('Page.navigate', { url });
  await loaded;
  console.log(`navigated -> ${await evaluate(c, 'location.href')}`);
}

async function applyDevice(c, d) {
  if (opt.resetDevice) {
    await c.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await c.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
    await c.send('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
    console.log('device emulation: cleared');
    return;
  }
  if (!d) return;

  // The Android WebView composites into its window's surface, so the emulated
  // *device-pixel* size has to fit inside that surface. If it does not,
  // Page.captureScreenshot still returns an image of the requested size — but the
  // compositor repeats the visible content to fill it (the page appears twice).
  // So clamp the scale factor rather than hand back a plausible-looking lie.
  const surf = JSON.parse(await evaluate(c, 'JSON.stringify({w:Math.round(screen.width*devicePixelRatio),h:Math.round(screen.height*devicePixelRatio)})'));
  let dsf = d.dsf;
  const maxDsf = Math.min(surf.w / d.w, surf.h / d.h);
  if (!opt.noClamp && dsf > maxDsf) {
    // prefer a recognisable scale factor over "as big as possible"
    const ladder = [3, 2.625, 2, 1.5, 1];
    dsf = ladder.find((s) => s <= maxDsf) ?? Math.max(0.5, Math.floor(maxDsf * 100) / 100);
    console.error(`! display surface is only ${surf.w}x${surf.h} px, but ${d.w}x${d.h} CSS @${d.dsf}x needs ${Math.round(d.w * d.dsf)}x${Math.round(d.h * d.dsf)} px.`);
    console.error(`  clamping dsf ${d.dsf} -> ${dsf} (→ ${Math.round(d.w * dsf)}x${Math.round(d.h * dsf)} px); beyond the surface, screenshots repeat the page.`);
    console.error(`  override with --no-clamp, or --metrics ${d.w}x${d.h}x${dsf} to pin this deliberately.`);
  }
  if (dsf < 1) console.error(`! dsf ${dsf} < 1: even this may not fit (${Math.round(d.w * dsf)}x${Math.round(d.h * dsf)} px)`);

  await c.send('Emulation.setDeviceMetricsOverride', {
    width: d.w, height: d.h, deviceScaleFactor: dsf, mobile: true,
    screenWidth: d.w, screenHeight: d.h, screenOrientation: { type: 'portraitPrimary', angle: 0 },
  });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await c.send('Emulation.setUserAgentOverride', { userAgent: UAS[d.ua] });
  const got = await evaluate(c, 'JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})');
  console.log(`device: ${opt.device || opt.metrics} -> ${got}  (surface ${surf.w}x${surf.h})`);
}

async function shot(c, file) {
  const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`screenshot -> ${file}`);
}

// ---------------------------------------------------------------- run
const target = await chooseTarget(await pageTargets());
if (opt.list) {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  console.error(`# via ${BASE}`);
  for (const t of list) console.log(`${t.type}\t${t.id}\t${(t.title || '').slice(0, 40)}\t${(t.url || '').slice(0, 70)}`);
  process.exit(0);
}
if (process.env.DEBUG) console.error(`target ${target.id} — ${target.title || '(untitled)'} — ${target.url}`);

const c = connect(target.webSocketDebuggerUrl);
await c.ready;
await c.send('Runtime.enable');
await c.send('Page.enable');
await c.send('Log.enable').catch(() => {});
// let the buffered console replay finish before live streaming starts
await new Promise((r) => setTimeout(r, 250));
c.endReplay();

const profile = deviceProfile();
await applyDevice(c, profile);

async function runOnce() {
  if (opt.nav) await navigate(c, opt.nav);
  if (opt.wait) await waitFor(c, opt.wait);
  if (opt.click) await click(c, opt.click);
  if (opt.type) { await c.send('Input.insertText', { text: opt.type }); console.log(`typed ${JSON.stringify(opt.type)}`); }
  if (opt.key) await pressKey(c, opt.key);
  if (expression) {
    const value = await evaluate(c, expression);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  if (opt.shot) await shot(c, opt.shot);
}

if (opt.repl) {
  console.error(`CDP repl — ${target.title || target.url}; .help for commands, .exit to leave`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'cdp> ' });
  // Guard every prompt: on piped/closed stdin the interface is already closed and
  // rl.prompt() calls resume() on a dead stream, throwing ERR_USE_AFTER_CLOSE.
  const prompt = () => { if (!rl.closed) rl.prompt(); };
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) { prompt(); continue; }
    try {
      if (line === '.exit' || line === '.quit') break;
      else if (line === '.help') console.log('.help .exit .click <sel> .nav <url> .shot <file> .target   — anything else is evaluated as JS');
      else if (line === '.target') console.log(`${target.title} — ${target.url}`);
      else if (line.startsWith('.click ')) await click(c, line.slice(7).trim());
      else if (line.startsWith('.nav ')) await navigate(c, line.slice(5).trim());
      else if (line.startsWith('.shot ')) await shot(c, line.slice(6).trim());
      else {
        const value = await evaluate(c, line);
        console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      }
    } catch (e) { console.error(`! ${e.message}`); }
    prompt();
  }
  if (!rl.closed) rl.close();
} else {
  await runOnce();
}

c.ws.close();
