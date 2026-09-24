# Pi WebView Shell

A 16 KB single-Activity Android app that hosts a **WebView you can drive over the
Chrome DevTools Protocol from Termux** — plus the Termux-side tooling to do it.
Built on-device, no Gradle, no Android SDK (same hand-rolled pipeline as
`~/trackpad`).

Verified end-to-end on SM-F936B (One UI, Android 16 / API 36), 2026-09.

## How it works

```
Termux (node / python / curl)                     the app process (pid N)
  │                                                     │
  │ HTTP + WS on 127.0.0.1:9333                         │  WebView DevTools server
  ▼                                                     ▼
adb server (running INSIDE Termux) ── adb forward ──► @webview_devtools_remote_N
```

`WebView.setWebContentsDebuggingEnabled(true)` makes WebView expose CDP on an
**abstract unix socket** named `webview_devtools_remote_<pid>`.

You cannot connect to that socket from Termux directly: SELinux blocks one app
from connecting to another app's socket (`EACCES`), and the shell UID (i.e.
Shizuku) is refused too. `adbd` *is* allowed, so `adb forward` is the way in —
and because Termux's own adb server runs on the device, the forwarded port lands
on the **device's own loopback**.

## Three layers of control

| Layer | Channel | What it can do | Needs |
|---|---|---|---|
| **Transport** | `adb forward tcp:9333 localabstract:…` | reach the socket at all | adb (already connected to itself) |
| **Page** | CDP over the forwarded port | DOM/CSS/JS, real mouse + key input, navigation, network, screenshots, console | nothing in the app |
| **App** | `@JavascriptInterface` bridge (`pi.*`), driven *through* CDP | anything the Java side exposes: Android APIs, app state | rebuild the app |

CDP is the only layer that needs no app cooperation, which is why it's the useful
one: you can point the same tooling at any WebView/Chrome.

## Use

```bash
cd ~/webview-shell
./build.sh                                  # aapt2 -> javac -> d8 -> check -> apksigner
adb install -r out/pi-webview.apk

./cdp-webview.sh up                         # (re)launch + unfreeze + forward + verify
./cdp-webview.sh status                     # pid, frozen?, forward, HTTP
./cdp-webview.sh info                       # page targets
./cdp-webview.sh down                       # remove the forward

node cdp.mjs 'document.title'               # evaluate in the page
node cdp.mjs --click 'button'               # real mouse input (or --click 'text=tap me')
node cdp.mjs --type 'hello'                 # insertText into the focused element
node cdp.mjs --key Enter                    # Enter Tab Escape Backspace Arrow… PageUp/Down
node cdp.mjs --nav https://example.com      # navigate + wait for load
node cdp.mjs --wait '#ready'                # poll for a selector
node cdp.mjs --shot page.png                # screenshot the page
node cdp.mjs --repl                         # interactive: .help .click .nav .shot .exit
node cdp.mjs 'pi.info()'                    # cross into the Android layer
```

Actions run in a fixed order (`nav → wait → click → type → key → expression → shot`),
so a single invocation can perform a whole sequence. `DEBUG=1` streams CDP events.

## Files

| File | Role |
|---|---|
| `java/com/pi/webview/MainActivity.java` | debug flag, WebView, `pi` JS bridge (`ping`/`info`/`toast`) |
| `java/com/pi/webview/KeepAliveService.java` | foreground service — keeps the process out of the frozen cgroup |
| `java/com/pi/webview/RelayServer.java` | publishes the socket on `127.0.0.1:9334` (no adb needed) — **not yet verified on device** |
| `assets/index.html` | demo page; exposes `window.__pi` as a stable CDP handle |
| `build.sh` | on-device build (a `-A assets` variant of `~/trackpad/build.sh`) |
| `cdp-webview.sh` | pid discovery, freeze handling, `adb forward`, verification |
| `cdp.mjs` | dependency-free CDP client/CLI (Node 22+ global `WebSocket`) |

`keystore.jks` is copied from `~/trackpad` so both APKs share one dev key.

## The freeze problem (the thing that actually bites)

An Android app that is not the visible app gets **frozen** — its whole cgroup is
suspended. The process stays alive, and `/proc/net/unix` still lists the DevTools
socket, but the socket is never accepted again: clients hang instead of failing
cleanly. Measured here while the shell ran as a plain background app:

```
/proc/14178/cgroup → 5:freezer:/frozen
curl 127.0.0.1:9333/json/version → 000   (process alive, Forward in place)
```

`KeepAliveService` (a `specialUse` foreground service started in `onCreate`) makes
the process freeze-exempt. With it running:

- after **4 minutes** in the background: `cgroup unfrozen`, HTTP 200, CDP evaluating;
- `adb shell am freeze com.pi.webview` was requested explicitly — the app kept
  answering CDP (`isFrozen` never became true).

`./cdp-webview.sh up` also calls `am start` unconditionally, which both launches a
dead app and unfreezes one the platform already parked.

## Two ways to get a port

| Path | Port | Status |
|---|---|---|
| `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` | 9333 | verified — needs adb; re-run `up` after every app restart |
| `RelayServer` inside the app (byte-pumps its own socket to loopback) | 9334 | **verified** — no adb at all |

They cannot share a port: both bind the device's *same* loopback. The relay has to
live inside the WebView's process, because SELinux lets a process connect to an
abstract socket it created itself but not to one owned by another app — which is
exactly why an external process cannot do this job.

With the relay, `adb forward --list` is empty and CDP still answers:

```
./cdp-webview.sh direct
relay UP on 127.0.0.1:9334 (no adb forward involved)
  com.pi.webview — Chrome/153.0.8010.36
```

So once the app is running, **control needs no adb at all** — wireless debugging
can be off entirely. The relay is bound per *process*, so an Activity recreation
(display move, rotation) does not disturb it; a second `onCreate` logs
`relay already running` instead of a failed re-bind.

## Verified

- Socket name is exactly `webview_devtools_remote_<pid>`, matching the app's own
  `Log.i` line and the name the Java side reports back through CDP.
- `/json/version` → `Android-Package: com.pi.webview`, `Browser: Chrome/153`,
  UA marked `; wv`; `/json/list` → the page target.
- `Runtime.evaluate` round-trips; `Page.captureScreenshot` renders the page.
- **Input works without a finger**: `Input.dispatchMouseEvent` clicks a button and
  the page's own tap counter increments; `Input.insertText` fills a focused field;
  `Input.dispatchKeyEvent` sends keys.
- `Page.navigate` reaches external sites (the shell has `INTERNET`) and back to the
  bundled asset page.
- `Network.enable` produces `Network.requestWillBeSent`; `DOM`, `CSS`, `Network.getCookies`
  respond.
- **CDP → Java**: `pi.info()` returns `{"pid":17493,"socket":"webview_devtools_remote_17493"}`,
  matching `adb shell pidof com.pi.webview` exactly. The bridge really crosses processes.
- A page left alone with no interaction stays at 0 taps — input only moves when
  something injects or taps it.
- **Relay works with no adb**: `adb forward --list` empty, CDP answering on
  `127.0.0.1:9334`.
- **Multi-display**: launched on display **17** (XREAL One, 1920×1080, density 213)
  and display **24** (a virtual display, 1245×1397, density 360 → dpr 2.25). On each,
  CDP read the viewport and `Input.dispatchMouseEvent` clicked the button.
  `Page.captureScreenshot` gave 1247×1398 on display 24 — the page really renders at
  the target display's resolution.

## Gotchas

- **Assets are a build change**: `aapt2 link` needs `-A <dir>`, or your HTML silently
  isn't in the APK.
- **The forward dies with the process** (new pid ⇒ re-run `up`), and
  `adb forward tcp:9333 …` silently *replaces* an existing forward on that port.
  `adb forward --list` shows what's wired; 9222/9223 are Chrome's.
- **`Runtime.enable` replays buffered `console.*`** from before the connection.
  `cdp.mjs` suppresses the replay; `DEBUG=1` shows everything.
- **The devtools server accumulates page targets.** Every WebView ever created in
  the process stays listed, so after a few Activity recreations `/json/list` shows
  several identical targets. Picking "the first page" then reads one page and clicks
  another (this bit me: a single click read back as `0 → 3`). `cdp.mjs` probes each
  target and uses the one reporting `visibilityState === 'visible'`; pin one with
  `--target <id>`.
- **`screencap -d N` does not take the Android display id** — it takes the
  SurfaceFlinger token from `dumpsys SurfaceFlinger --display-id` (and defaults to
  the *cover* screen otherwise). It also refuses the virtual display's token as
  "not valid", and `-a` only enumerates active *physical* displays. To see a WebView
  on an unusual display, capture through CDP (`--shot`) instead.
- **A backgrounded app cannot show a Toast** (Android 11+). `pi.toast()` still
  executes Java, but nothing appears unless the app is foreground or holds
  `SYSTEM_ALERT_WINDOW`.
- **`Target.createTarget` / `/json/new` are blocked on Android** — attach to an
  existing page target, don't try to create one (same restriction as Chrome).
- The forward binds **127.0.0.1 only** (verified in `/proc/net/tcp`), so it is not
  on the LAN — but any app on the phone holding `INTERNET` could drive the page.
  `./cdp-webview.sh down` when done.

## Not done yet (deliberately)

- No overlay/floating variant — this is an Activity. A `TYPE_ACCESSIBILITY_OVERLAY`
  WebView is the `~/trackpad` direction and needs a display context for DeX plus
  care with the click-through trick.
- Multiple simultaneous CDP *clients* on one target are untested (multiple targets
  definitely coexist; that is a different question).
