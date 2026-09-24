# AGENTS.md — Pi WebView Shell

## What this is

A single-Activity Android app that hosts a **WebView whose Chrome DevTools Protocol
socket is reachable from Termux**, plus the Termux-side tooling to drive it.
Built on-device with a **hand-rolled build** (`build.sh`) — **no Gradle, no Android
SDK package, no Kotlin**; the app is plain Java.

Companion to `~/trackpad` (Pi Trackpad) and a `-A assets` variant of its `build.sh`.

## Build & install

```bash
./build.sh                       # aapt2 -> javac -> d8 -> alignment check -> apksigner
adb install -r out/pi-webview.apk
adb shell am start -n com.pi.webview/.MainActivity            # optionally --display <id>
```

`build.sh` looks for `sdk/platforms/android-36/android.jar` and falls back to
`~/trackpad/sdk/...`. `keystore.jks` (signing key), `out/`, `build/` are gitignored.

## Architecture

| File | Role |
|---|---|
| `java/.../MainActivity.java` | debug flag, WebView, `pi` JS bridge (`ping`/`info`/`toast`) |
| `java/.../RelayServer.java` | byte-pumps the app's own DevTools socket to `127.0.0.1:9334` |
| `java/.../KeepAliveService.java` | `specialUse` foreground service — keeps the process out of the frozen cgroup |
| `assets/index.html` | demo page; exposes `window.__pi` as a stable CDP handle |
| `build.sh` | the hand-rolled build pipeline |
| `cdp-webview.sh` | `up` / `direct` / `status` / `info` / `down` |
| `cdp.mjs` | dependency-free CDP client (Node 22+ global `WebSocket`), incl. `--device` profiles |
| `display.sh` | drives pi-trackpad's `vdisplay` to run this app on a virtual display |

### Two mechanisms worth understanding before changing anything

1. **Why adb, and why a relay.** The DevTools server listens on the abstract unix
   socket `webview_devtools_remote_<pid>`. SELinux blocks one app from connecting to
   another app's socket (Termux gets `EACCES`), and the shell UID — i.e. Shizuku — is
   refused too. `adbd` is allowed, hence `adb forward`. A process *may* connect to an
   abstract socket **it created itself**, which is what makes `RelayServer` possible —
   and why that relay has to live inside the WebView's process, not outside it.
2. **Why the foreground service exists.** A backgrounded app is put in the frozen
   cgroup: the process stays alive and `/proc/net/unix` still lists the socket, but it
   is never accepted, so CDP clients *hang* rather than failing. `KeepAliveService`
   makes the process freeze-exempt. `cdp-webview.sh up` also `am start`s, which
   unfreezes an already-parked app.

## Conventions

- **Java 8 syntax**, no lambdas (d8 desugaring risk) — anonymous classes.
- No third-party dependencies; the CDP client uses Node's built-in `WebSocket`.
- Ports: **9333** = `adb forward`, **9334** = in-app relay, **9222/9223** = Chrome
  (someone else's — do not take them). Both 9333 and 9334 bind the *same* device
  loopback, so they can never be the same port.

## Known behaviours / gotchas

- `aapt2 link` needs `-A assets`, or the HTML silently isn't in the APK.
- The devtools server keeps **a target per WebView ever created**; after Activity
  recreations `/json/list` shows several identical pages. Never pick `list[0]` — probe
  for the target whose `document.visibilityState` is `visible` (what `cdp.mjs` does).
- The relay is **bind-once per process** (static flag) — Activity recreation re-runs
  `onCreate` and a second bind would fail with `EADDRINUSE`.
- A backgrounded app cannot show a Toast (Android 11+).
- `Target.createTarget` / `/json/new` are blocked on Android; attach to an existing target.
- `screencap -d` wants the SurfaceFlinger token (not the display id), defaults to the
  cover screen, and cannot capture virtual displays — capture via CDP `--shot` instead.
- **A headless (`state=OFF`) display gives no pixels**: `visibilityState` is `hidden`,
  `requestAnimationFrame` never fires, and `Page.captureScreenshot` times out. JS, DOM,
  network, timers and CDP input injection all still work. For anything visual use the
  surface-backed display (`display.sh visible`, and `show` to attach the surface).
- **Emulated device pixels must fit the display surface.** Beyond it,
  `captureScreenshot` returns the requested size with the page drawn twice.
  `cdp.mjs` clamps the scale factor to 3 / 2.625 / 2 / 1.5 / 1 accordingly.

## Verification status

Confirmed on SM-F936B, One UI, Android 16 / API 36. Keep this honest — do not move
rows up without re-testing.

**Verified:** socket name; `/json/version` package identity; `Runtime.evaluate`;
`Input.dispatchMouseEvent`/`insertText`/`dispatchKeyEvent`; `Page.navigate` to
external sites; `Network.*` events; `Page.captureScreenshot`; relay on 9334 with an
empty `adb forward` table; the Java bridge crossing (`pi.info()` matched `pidof`);
running on display 17 (XREAL) and display 24 (virtual, dpr 2.25) with input injection.

**Not verified:** multiple simultaneous CDP clients on one target; a WebSocket held
open for hours through the relay; a WebView in a `TYPE_ACCESSIBILITY_OVERLAY` window.
