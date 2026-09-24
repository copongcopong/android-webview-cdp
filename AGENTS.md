# AGENTS.md — Pi WebView Shell

## What this is

A single-Activity Android app that hosts a **WebView whose Chrome DevTools Protocol
socket is reachable from Termux**, plus the Termux-side tooling to drive it.
Built on-device with a **hand-rolled build** (`build.sh`) — **no Gradle, no Android
SDK package, no Kotlin**; the app is plain Java.

## Build & install

On a new machine, run the read-only checkup first — it prints what is missing and the exact
command to fix each item, and writes nothing:

```bash
bash ./setup.sh --pre-install-checkup    # pre-install checkup (no changes)
bash ./setup.sh                          # then: install pkgs, build, install, verify
```

By hand, the same thing is:

```bash
./build.sh                       # aapt2 -> javac -> d8 -> alignment check -> apksigner
adb install -r out/pi-webview.apk
adb shell am start -n com.pi.webview/.MainActivity            # optionally --display <id>
```

`build.sh` needs `sdk/platforms/android-36/android.jar` (27 MB, not in the repo — `setup.sh`
fetches it). `keystore.jks` (signing key), `out/`, `build/` are gitignored.

Everything needed before this is in the README's *Prerequisites — setting up a fresh Android
device*: Termux package list (`aapt2 d8 apksigner openjdk-21 android-tools nodejs-lts python3
zip unzip curl` — **`zip` is easy to miss and `build.sh` needs it to add `classes.dex`**),
the platform jar, and wireless-ADB pairing.

Two traps for a fresh checkout:

- **No signing key is committed.** `build.sh` generates `keystore.jks` on first use, so a fresh
  clone signs with a new key and Android will refuse to update an app installed from someone
  else's build: `adb uninstall com.pi.webview` first (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`
  otherwise).
- **Off-device (laptop + USB phone):** run the scripts as `bash build.sh` — their shebangs are
  absolute Termux paths — and reach the relay with `adb forward tcp:9334 tcp:9334`, which
  forwards to the device's loopback where the relay listens.

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
| `display.sh` | runs the app on a simulated phone-sized secondary display, off-screen |
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

## Displays

`display.sh overlay [WxH@DPI]` writes the `overlay_display_devices` global setting (shell holds
`WRITE_SECURE_SETTINGS`, so adb suffices), which makes system_server create a simulated
secondary display. Phone-sized by construction — 1080×2340/420 gives the shell 411×851 CSS px
at dpr 2.625 — and it renders off-screen at native resolution. No root, no Shizuku, no
accessibility service, no other app.

Six things that will bite:

- **`settings put global overlay_display_devices ""` fails** (`Bad arguments`). Clear with
  `settings delete global overlay_display_devices` — what `overlay-off` runs. The setting
  persists, so the display returns after a reboot until deleted.
- **The setting wants `WxH/DPI`, not `WxH@DPI`.** Normalise before writing it, or you write
  `2340/420` as the height and nothing is created.
- **Force-stop before launching onto the display.** `am start --display N` on a running
  activity *moves* the task: it keeps the old window size and carries the previous display's
  density, so you get 480×993 CSS at dpr 2.25 instead of 411×851 at 2.625. Launch fresh, then
  `am task resize <taskId> 0 0 <w> <h>`.
- **Screenshots need a surface.** The window must be on a display that is ON and *has a render
  target*. A surface-less display (headless, `state=OFF`) produces no frames by any route — all
  four capture APIs fail (`captureScreenshot` default / `fromSurface:false` /
  `captureBeyondViewport:true` time out, `startScreencast` yields 0 frames) — and a `hidden`
  page behaves the same way. JS, DOM, network, timers and CDP input injection still work there,
  so a surface-less display is for logic/DOM/network assertions only.
  `overlay_display_devices` always renders, so this path always has pixels.
- **Window sizing, not the display, is the device-specific part.** This device ships freeform
  window management, so a task on a secondary display can arrive small and *keeps its bounds*
  when it moves displays — which is why `overlay` force-stops and then resizes unconditionally.
  On a non-DeX phone expect fullscreen and a no-op resize; `--windowingMode 1` is the knob if a
  device does not fill. (Inferred — never measured on a non-DeX device.)
- **`screencap` cannot see simulated displays** — `-a` lists only physical ones, `-d` takes
  the SurfaceFlinger token and rejects a virtual display's. Capture with CDP `--shot`.

### Stopping

- `display.sh overlay-off` / `display.sh none` close the displays; `cdp-webview.sh down`
  removes the adb forward. **None of them stop the app.**
- **A dead Activity with a live process is expected**: `KeepAliveService` outlives the
  Activity, so the FGS notification stays and the relay keeps listening on 9334. `status`
  showing `relay UP` with an empty `app display` is correct, not a bug — don't "fix" it by
  tying the relay to the Activity lifecycle.
- Only `adb shell am force-stop com.pi.webview` stops everything (process, notification, port).

## Known behaviours / gotchas

- `aapt2 link` needs `-A assets`, or the HTML silently isn't in the APK.
- The devtools server keeps **a target per WebView ever created**; after Activity
  recreations `/json/list` shows several identical pages. Never pick `list[0]` — probe
  for the target whose `document.visibilityState` is `visible` (what `cdp.mjs` does).
- The relay is **bind-once per process** (static flag) — Activity recreation re-runs
  `onCreate` and a second bind would fail with `EADDRINUSE`.
- A backgrounded app cannot show a Toast (Android 11+).
- `Target.createTarget` / `/json/new` are blocked on Android; attach to an existing target.
- **Emulated device pixels must fit the display surface.** Beyond it,
  `captureScreenshot` returns the requested size with the page drawn twice.
  `cdp.mjs` clamps the scale factor to 3 / 2.625 / 2 / 1.5 / 1 accordingly, so size the
  display to the device you are testing when you need native-resolution captures.

## Verification status

Confirmed on SM-F936B, One UI, Android 16 / API 36. Keep this honest — do not move
rows up without re-testing.

**Verified:** socket name; `/json/version` package identity; `Runtime.evaluate`;
`Input.dispatchMouseEvent`/`insertText`/`dispatchKeyEvent`; `Page.navigate` to external
sites; `Network.*` events; `Page.captureScreenshot`; relay on 9334 with an empty
`adb forward` table; the Java bridge crossing (`pi.info()` matched `pidof`); running on
display 17 (XREAL) and an `overlay_display_devices` simulated display (411x851 CSS @2.625,
native 1082x2237 captures, and a full-retina 1170x2532 when the display is sized 1200x2700).
A real network site is navigated and asserted as part of `setup.sh`'s verification.

**Not verified:** multiple simultaneous CDP clients on one target; a WebSocket held open
for hours through the relay; a WebView in a `TYPE_ACCESSIBILITY_OVERLAY` window.
