#!/data/data/com.termux/files/usr/bin/bash
# Put pi-webview-shell on a virtual display — headless or surface-backed — and say
# whether that display can produce pixels.
#
#   ./display.sh status            what display exists, which one the app is on
#   ./display.sh headless          create an OFF display and run the shell there
#   ./display.sh visible           create a surface-backed display (renders) + run there
#   ./display.sh show | hide       attach/detach the surface on the visible display
#   ./display.sh none              destroy the virtual display, app back to the phone
#   ./display.sh phone             visible + launch + apply the default device profile
#
# Virtual-display creation belongs to **pi-trackpad** (it needs shell UID via Shizuku:
# a PUBLIC, task-hosting display requires ADD_TRUSTED_DISPLAY / CAPTURE_VIDEO_OUTPUT,
# which normal apps do not hold). So this drives its `vdisplay` script over a
# broadcast. Override the path with VDISPLAY=/path/to/vdisplay.
#
# What each kind is actually good for (measured, SM-F936B / Android 16):
#
#   headless (surface=detached, state=OFF)
#     yes: JS, DOM, network, timers, CDP input injection, the relay
#     no:  screenshots (Page.captureScreenshot times out), requestAnimationFrame
#          (0 frames — the page reports visibilityState="hidden")
#     -> logic/DOM/network tests, a background "browser agent"
#
#   visible (surface=alive)
#     yes: everything above *plus* rendering: visibilityState="visible", rAF runs,
#          Page.captureScreenshot works. With --device emulation the PNG comes back
#          phone-sized (e.g. 1082x2402 for pixel-7).
#     no:  it is on-screen — pi-trackpad draws the display in a floating window
#
# `hide` drops the surface and puts you back in the headless situation with the apps
# still running; `show` brings the same display id back.
set -euo pipefail

PKG=com.pi.webview
ACTIVITY="$PKG/.MainActivity"
DEVICE_PROFILE="${DEVICE_PROFILE:-pixel-7}"
VDISPLAY="${VDISPLAY:-$HOME/trackpad/skills/pi-vdisplay/scripts/vdisplay}"
ADB="${ADB:-adb}"
SH="$HOME/webview-shell"

[ -x "$VDISPLAY" ] || { echo "vdisplay script not found at $VDISPLAY" >&2; echo "set VDISPLAY=/path/to/vdisplay" >&2; exit 1; }

vd() { "$VDISPLAY" "$@" 2>&1 | tail -1; }
vd_status() { vd status; }
field() { printf '%s\n' "$1" | grep -o "$2=[^ ]*" | cut -d= -f2; }

display_of_app() {
    $ADB shell dumpsys activity activities 2>/dev/null \
        | awk '/Display #/{d=$2} /com\.pi\.webview\/\.MainActivity/{print d; exit}'
}

relay_up() {
    [ "$(curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:9334/json/version 2>/dev/null || true)" = "200" ]
}

launch_on() {
    local id="$1"
    $ADB shell am start --display "$id" -f 0x10000000 -n "$ACTIVITY" >/dev/null 2>&1 || true
    for _ in $(seq 1 10); do
        [ "$(display_of_app)" = "$id" ] && break
        sleep 0.5
    done
    printf 'app display  %s\n' "$(display_of_app)"
}

wait_kind() {  # wait_kind <floating|headless>
    local want="$1" s
    for _ in $(seq 1 15); do
        s="$(vd_status)"
        [ "$(field "$s" kind)" = "$want" ] && { printf '%s\n' "$s"; return 0; }
        sleep 1
    done
    printf '%s\n' "${s:-<no status>}"
    return 1
}

report() {
    local id="$1" kind="$2" surface="$3"
    printf 'display id   %s (%s, surface=%s)\n' "$id" "$kind" "$surface"
    if [ "$surface" = "alive" ]; then
        printf 'pixels       YES — visibilityState=visible, rAF runs, screenshots work\n'
        printf 'screenshot:  node cdp.mjs --device %s --shot shot.png\n' "$DEVICE_PROFILE"
    elif [ "$kind" = "floating" ]; then
        printf 'pixels       NO  — display is visible-capable but its surface is detached\n'
        printf '             (screen off, or the float window is hidden) — try: %s show\n' "$0"
    else
        printf 'pixels       NO  — headless: screenshots time out, rAF never fires\n'
        printf "still works: node cdp.mjs --device %s 'document.title'   (JS/DOM/network/input)\n" "$DEVICE_PROFILE"
    fi
    if relay_up; then
        printf 'relay        UP on 127.0.0.1:9334 (no adb forward)\n'
    else
        printf 'relay        DOWN — is the app running? (./cdp-webview.sh up)\n'
    fi
}

case "${1:-status}" in
  status)
    S="$(vd_status)"; echo "vdisplay: $S"
    printf 'app display  %s\n' "$(display_of_app)"
    if relay_up; then echo "relay        UP on 127.0.0.1:9334"; else echo "relay        DOWN"; fi
    ;;
  headless|visible)
    if [ "$1" = "headless" ]; then
        vd create --headless >/dev/null
        S="$(wait_kind headless)" || { echo "display did not come up: $S" >&2; exit 1; }
    else
        vd create >/dev/null
        S="$(wait_kind floating)" || { echo "display did not come up: $S" >&2; exit 1; }
        vd show >/dev/null || true
        S="$(vd_status)"
    fi
    ID="$(field "$S" id)"
    [ "$ID" != "-1" ] || { echo "no display id in: $S" >&2; exit 1; }
    launch_on "$ID"
    report "$ID" "$(field "$S" kind)" "$(field "$S" surface)"
    ;;
  phone)
    "$0" visible >/dev/null
    ID="$(field "$(vd_status)" id)"
    printf 'applying device profile %s on display %s\n' "$DEVICE_PROFILE" "$ID"
    ( cd "$SH" && node cdp.mjs --device "$DEVICE_PROFILE" --shot phone.png )
    printf 'screenshot   %s/phone.png\n' "$SH"
    ;;
  show|hide)
    vd "$1"
    S="$(vd_status)"
    report "$(field "$S" id)" "$(field "$S" kind)" "$(field "$S" surface)"
    ;;
  none)
    vd destroy
    $ADB shell am start -n "$ACTIVITY" >/dev/null 2>&1 || true
    printf 'app display  %s (back on the phone)\n' "$(display_of_app)"
    ;;
  *)
    sed -n '2,12p' "$0"; exit 1
    ;;
esac
