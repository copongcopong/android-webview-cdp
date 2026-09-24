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

## Screenshots

All of these are produced **by the tool itself** — `node cdp.mjs --shot`, i.e. the same
`Page.captureScreenshot` path documented below, not a phone screenshot:

**The shell on a surface-backed virtual display** (1247×1398 px — pi-trackpad's float surface):

![Pi WebView Shell running on a virtual display, showing the bundled demo page](docs/img/shell-on-display.png)

**The same page under `--device pixel-7`** — the page lays out at 412×915 CSS px with touch
and a mobile UA (scale factor clamped to 1.5 here; see *Phone-sized viewports*):

![The demo page laid out at a Pixel 7 viewport](docs/img/phone-viewport-pixel7.png)

**A real site at `--device iphone-14`** — 390×844 CSS px, driven and captured over the relay
with no adb forward:

![example.com rendered at an iPhone 14 viewport](docs/img/example-com-iphone-14.png)

## Prerequisites — setting up a fresh Android device

### The device

- **Android 14+ (API 34+).** `build.sh` declares `minSdk 30`, but the keep-alive service
  uses `foregroundServiceType="specialUse"`, which only exists from API 34 — treat 14 as the
  real floor. Verified on Android 16 / One UI (SM-F936B); **not tested on anything older.**
- **A current WebView provider** (Chrome, or Google's standalone WebView). The CDP version
  you get comes from it — this device reports `Chrome/153`, protocol 1.3.
- Nothing else. No root, no accessibility service, no Shizuku: those are only needed for the
  optional virtual-display mode. The relay means you never even need adb *after launch*.

### Termux and the build tools

Install **Termux from F-Droid or GitHub releases** — the Play Store build is deprecated and stale.

```bash
pkg update && pkg upgrade
pkg install aapt2 d8 apksigner openjdk-21 android-tools nodejs-lts python3 unzip
```

| need | package | provides |
|---|---|---|
| resource/manifest compiler | `aapt2` | `aapt2` |
| dexer | `d8` | `d8` |
| signing | `apksigner` | `apksigner` |
| javac / keytool | `openjdk-21` | `javac`, `keytool` (21.0.12 here) |
| adb | `android-tools` | `adb` 1.0.41 / 35.0.2 |
| CDP client | `nodejs-lts` | `node` (needs **22+** for the built-in `WebSocket`) |
| helper scripts | `python3`, `unzip` | `python3`, `unzip` |

`aidl` is **not** needed here (only pi-trackpad needs it).

### The platform jar (27 MB, not in this repo)

```bash
curl -LO https://dl.google.com/android/repository/platform-36_r02.zip   # HTTP 200, verified
unzip -j platform-36_r02.zip android-36/android.jar -d sdk/platforms/android-36/
```

Sanity check: that jar is ~27,768,000 bytes. `build.sh` also falls back to
`~/trackpad/sdk/platforms/android-36/android.jar` if you have pi-trackpad checked out.

### Wireless ADB, from Termux on the same device

Because Termux runs *on* the phone, its **adb server runs inside Termux** — which is why
`adb forward` lands on the device's own loopback and every CDP path here is `127.0.0.1`.

1. Settings → About phone → tap **Build number** 7× → Developer options.
2. **Wireless debugging** → on → *Pair device with pairing code*; note the IP:port **and the code**.
3. `adb pair 192.168.x.y:<pair-port>` — asks for the code; once per device.
4. `adb connect 192.168.x.y:<connect-port>` — the port shown on the Wireless debugging screen,
   which **changes every time you toggle it**.

Notes worth having in advance:
- On the same device, `adb connect 127.0.0.1:<port>` also works (verified) — no IP needed.
- `adb mdns services` does **not** work with Termux's `android-tools` build
  (`error: unknown host service 'mdns:services'`). Read the port off the screen, or discover
  it over mDNS (`_adb-tls-connect._tcp`) with any zeroconf client.
- Transports are ambiguous with more than one connection — use `adb -s <host:port>`.

### Build, install, first run

```bash
./build.sh
adb install -r out/pi-webview.apk
adb shell am start -n com.pi.webview/.MainActivity          # or --display <id>
./cdp-webview.sh direct                                     # relay on 9334, no forward
node cdp.mjs --device pixel-7 'document.title'
```

Android 13+ will ask for **notification permission**: it belongs to the keep-alive foreground
service, which is what stops the platform freezing the process (see *The freeze problem*).

### Optional: virtual displays

Needs **[pi-trackpad](https://github.com/jan5o7o/pi-trackpad)** installed with (a) its
accessibility service enabled and (b) Shizuku running and granted — creating a PUBLIC,
task-hosting display requires shell UID, so it is that app's job, not this one's. Start
Shizuku with its own wireless-debugging instructions, then grant it the
`moe.shizuku.manager.permission.API_V23` permission. After that:

```bash
./display.sh visible      # or: headless
```

Without pi-trackpad you can still run the shell on the phone's own screen and drive it over
the relay — the only thing you lose is the second, off-screen display.

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
| `display.sh` | put the shell on a virtual display — headless or surface-backed |

`keystore.jks` is copied from `~/trackpad` so both APKs share one dev key.

## Running it on a virtual display (and testing at phone sizes)

Display creation is **not** done here: a PUBLIC task-hosting display needs
`ADD_TRUSTED_DISPLAY` / `CAPTURE_VIDEO_OUTPUT`, which normal apps don't hold. That
machinery lives in **pi-trackpad** (`~/trackpad`), which owns one virtual-display slot
via its Shizuku shell service. `display.sh` drives its `vdisplay` script over a
broadcast and launches this app onto the result.

```bash
./display.sh status        # what exists, where the app is, is the relay up
./display.sh headless      # OFF display, app runs there, no pixels
./display.sh visible       # surface-backed display: renders
./display.sh show | hide   # attach/detach that surface (hide = back to no pixels)
./display.sh phone         # visible + device profile + screenshot
./display.sh none          # destroy, app back to the phone screen
```

The two kinds are **not** interchangeable — measured on SM-F936B / Android 16:

| | headless (state OFF) | visible (surface-backed) |
|---|---|---|
| JS / DOM / network / timers | yes | yes |
| CDP input injection (`--click`, `--type`) | yes | yes |
| the relay (no adb) | yes | yes |
| `document.visibilityState` | `hidden` | `visible` |
| `requestAnimationFrame` | **never fires** (0 frames in 800 ms) | runs (~84 frames / 700 ms) |
| `Page.captureScreenshot` | **times out** | works |
| good for | logic, DOM, network, a background browser | anything visual |

### Phone-sized viewports

The display's own size is pi-trackpad's (the surface-backed one is 1245×1397 px).
Don't fight it — set the **test viewport** with CDP device emulation:

```bash
node cdp.mjs --list-devices
node cdp.mjs --device pixel-7 --nav https://example.com --wait h1 --shot shot.png
node cdp.mjs --device iphone-14 'JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})'
node cdp.mjs --metrics 412x915x2.625 …     # custom; --reset-device to clear
```

The page then sees an exact phone viewport (e.g. `412x915 @2.625`, touch enabled,
mobile UA) whatever the physical display is.

**One trap, caught by looking at the output instead of trusting the file size:** the
WebView composites into its window's surface, so the emulated *device-pixel* size must
fit inside that surface. `--device iphone-14` (390×844 @3x = 1170×2532 px) does **not**
fit 1397 px, and `captureScreenshot` still returns a 1170×2532 PNG — with **the page
drawn twice**. `cdp.mjs` therefore clamps the scale factor to the largest standard value
(3, 2.625, 2, 1.5, 1) that fits, and says so on stderr: iPhone-14 becomes 1.5x →
585×1266. `--no-clamp` reproduces the tiling deliberately.

Consequence: on this device a **retina phone-sized screenshot is not achievable** —
neither the float surface (1245×1397) nor the phone's own screen (1812×2176) is tall
enough for 1170×2532. CSS layout is exact regardless (which is what layout tests care
about); for pixel-perfect retina captures, drive **real Chrome** over CDP (~9222 built),
which composites off-screen at any size.

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

## Environment notes

- A **surface-backed** display only produces pixels while its surface is attached:
  `vdisplay show` (and the phone screen on). `hide`, or the screen going off, returns
  you to the headless situation with the apps still running.
- Virtual-display creation requires **pi-trackpad running, its accessibility service
  enabled, and Shizuku granted**; `display.sh` reports whatever it gets back.
- pi-trackpad requests 1920×1080 for the display, but the surface-backed size follows
  its float window (1245×1397). Making the *display itself* phone-shaped would mean
  adding w/h/dpi to pi-trackpad's `VDisplayReceiver` + `TrackpadService` (its AIDL
  already takes them) — not done here, because that needs rebuilding that app.
