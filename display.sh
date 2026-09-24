#!/data/data/com.termux/files/usr/bin/bash
# Put pi-webview-shell on a secondary display, and say whether that display can
# produce pixels.
#
# Two backends — you do NOT need pi-trackpad for the first one:
#
#   ./display.sh overlay [WxH@dpi]   adb only. Creates a simulated secondary display
#                                    via the `overlay_display_devices` global setting
#                                    (default 1080x2340@420 = a normal phone), launches
#                                    the shell there and resizes its task to fill it.
#   ./display.sh overlay-off         clear that setting, app back to the phone
#
#   ./display.sh headless            pi-trackpad's display, OFF (no pixels)
#   ./display.sh visible             pi-trackpad's display, surface-backed (renders)
#   ./display.sh show | hide         attach/detach that surface
#   ./display.sh none                destroy pi-trackpad's display
#
#   ./display.sh status              what exists right now
#
# Why the overlay backend is the default choice
# --------------------------------------------
# `settings put global overlay_display_devices "1080x2340/420"` asks system_server to
# create a simulated display, so it needs nothing but adb (shell holds
# WRITE_SECURE_SETTINGS). It is **phone-sized natively** — the WebView fills it at
# 411x851 CSS px / dpr 2.625, so `--device` emulation is optional and a screenshot comes
# back at the display's own resolution (1082x2237) instead of being clamped to a float
# surface. It renders (visibilityState=visible, rAF runs) and it is not drawn on the
# phone screen.
#
# Caveats: it is a persisted global setting (cleared by `overlay-off`, and it comes back
# after a reboot until you clear it); a freshly launched app lands in a small freeform
# window on it, which is why this script resizes the task; and only adb can create it.
# Clear it with `settings delete global overlay_display_devices` — `settings put ... ""`
# fails with "Bad arguments".
#
# pi-trackpad's display (the other backend) needs that app installed with its
# accessibility service enabled and Shizuku granted, because a PUBLIC task-hosting
# display requires shell UID. Use it when you want its headless/visible/surface
# toggling, or when you have no adb.
#
# Measured on SM-F936B / Android 16:
#
#   kind                              JS/DOM/net  CDP input  rAF        screenshot
#   overlay display (this script)     yes         yes        yes        yes (native size)
#   pi-trackpad visible               yes         yes        yes        yes (float surface)
#   pi-trackpad headless              yes         yes        NEVER      times out
set -euo pipefail

PKG=com.pi.webview
ACTIVITY="$PKG/.MainActivity"
DEVICE_PROFILE="${DEVICE_PROFILE:-pixel-7}"
OVERLAY_SPEC="${OVERLAY_SPEC:-1080x2340/420}"
VDISPLAY="${VDISPLAY:-$HOME/trackpad/skills/pi-vdisplay/scripts/vdisplay}"
ADB="${ADB:-adb}"

# ---------------------------------------------------------------- shared helpers
display_of_app() {
    $ADB shell dumpsys activity activities 2>/dev/null \
        | awk '/Display #/{d=$2} /com\.pi\.webview\/\.MainActivity/{print d; exit}'
}
relay_up() {
    [ "$(curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:9334/json/version 2>/dev/null || true)" = "200" ]
}
all_ids() { $ADB shell dumpsys display 2>/dev/null | grep -oE 'mDisplayId=[0-9]+' | cut -d= -f2 | sort -un | tr '\n' ' '; }
task_on_display() {
    $ADB shell dumpsys activity activities 2>/dev/null | awk -v want="#$1" '
        /Display #/ { cur = $2 }
        cur == want && /com\.pi\.webview\/\.MainActivity/ {
            if (match($0, /t[0-9]+/)) { print substr($0, RSTART + 1, RLENGTH - 1); exit }
        }'
}
relay_line() {
    if relay_up; then printf 'relay        UP on 127.0.0.1:9334 (no adb forward)\n'
    else printf 'relay        DOWN — is the app running? (./cdp-webview.sh up)\n'; fi
}

# ---------------------------------------------------------------- overlay backend
overlay() {
    local spec="${1:-$OVERLAY_SPEC}"
    # Accept WxH@DPI or WxH/DPI. The *setting* only understands the slash form
    # (AOSP's OverlayDisplayAdapter parser), so normalise it.
    local w h dpi setting
    w="${spec%%x*}"
    local rest="${spec#*x}"
    h="${rest%%[ @/]*}"
    dpi="$(printf '%s' "$rest" | sed -n 's/^[0-9]*[ @/]\([0-9][0-9]*\)$/\1/p')"
    [ -n "$dpi" ] || dpi=420
    case "$w" in ''|*[!0-9]*) echo "bad size '$spec' — want WxH@DPI, e.g. 1080x2340@420" >&2; exit 1;; esac
    case "$h" in ''|*[!0-9]*) echo "bad height in '$spec'" >&2; exit 1;; esac
    setting="${w}x${h}/${dpi}"
    local before after id task vp px

    before="$(all_ids)"
    # `settings delete` (not `put ... ""`, which errors with "Bad arguments") is what
    # removes the display; recreating guarantees a fresh id for the diff below.
    $ADB shell settings delete global overlay_display_devices >/dev/null 2>&1 || true
    sleep 1
    $ADB shell settings put global overlay_display_devices "$setting" >/dev/null
    for _ in $(seq 1 20); do
        after="$(all_ids)"
        id=""
        for cand in $after; do
            case " $before " in *" $cand "*) ;; *) id="$cand" ;; esac
        done
        [ -n "$id" ] && break
        sleep 1
    done
    [ -n "${id:-}" ] || { echo "no new display appeared for spec '$spec'" >&2; exit 1; }

    printf 'display id   %s (overlay, %s — created via overlay_display_devices)\n' "$id" "$spec"

    # Stop first, then launch on the display. *Moving* an existing task onto it (what
    # `am start --display` does when the activity is already running) keeps the old
    # window size and carries the previous display's density with it — you get 480x993
    # CSS at dpr 2.25 instead of 411x851 at 2.625. A fresh launch fills the display.
    $ADB shell am force-stop "$PKG" >/dev/null 2>&1 || true
    sleep 1
    $ADB shell am start --display "$id" -f 0x10000000 -n "$ACTIVITY" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
        task="$(task_on_display "$id")"
        [ -n "$task" ] && break
        sleep 0.5
    done
    # the relay is started in onCreate, so wait for it to come back after the restart
    for _ in $(seq 1 30); do relay_up && break; sleep 0.5; done

    if [ -n "${task:-}" ]; then
        # Always resize (idempotent): a task keeps its bounds when the display changes,
        # so a window can come up *larger* than the new display — not just smaller.
        $ADB shell am task resize "$task" 0 0 "$w" "$h" >/dev/null 2>&1 || true
        sleep 2
        printf 'task         %s sized to %sx%s\n' "$task" "$w" "$h"
    else
        printf 'task         not found on display %s — is the app installed?\n' "$id" >&2
    fi
    vp="$(node cdp.mjs 'JSON.stringify({css:innerWidth+"x"+innerHeight,dpr:devicePixelRatio,px:Math.round(innerWidth*devicePixelRatio)+"x"+Math.round(innerHeight*devicePixelRatio)})' 2>/dev/null | tail -1 || true)"
    printf 'viewport     %s\n' "${vp:-<not answering>}"
    printf 'pixels       YES — renders off-screen; capture at the display size, no clamping\n'
    printf 'next         node cdp.mjs --shot shot.png          (no --device needed)\n'
    printf '             node cdp.mjs --device pixel-7 …       (only to pin a specific phone)\n'
    relay_line
}

# ---------------------------------------------------------------- pi-trackpad backend
[ -x "$VDISPLAY" ] || VDISPLAY=""
vd() { "$VDISPLAY" "$@" 2>&1 | tail -1; }
vd_status() { vd status; }
field() { printf '%s\n' "$1" | grep -o "$2=[^ ]*" | cut -d= -f2; }

launch_on() {
    local id="$1"
    $ADB shell am start --display "$id" -f 0x10000000 -n "$ACTIVITY" >/dev/null 2>&1 || true
    for _ in $(seq 1 10); do
        [ "$(display_of_app)" = "#$id" ] && break
        sleep 0.5
    done
    printf 'app display  %s\n' "$(display_of_app)"
}
wait_kind() {
    local want="$1" s
    for _ in $(seq 1 15); do
        s="$(vd_status)"
        [ "$(field "$s" kind)" = "$want" ] && { printf '%s\n' "$s"; return 0; }
        sleep 1
    done
    printf '%s\n' "${s:-<no status>}"; return 1
}
report() {
    local id="$1" kind="$2" surface="$3"
    printf 'display id   %s (%s, surface=%s)\n' "$id" "$kind" "$surface"
    if [ "$surface" = "alive" ]; then
        printf 'pixels       YES — visibilityState=visible, rAF runs, screenshots work\n'
        printf 'screenshot:  node cdp.mjs --device %s --shot shot.png\n' "$DEVICE_PROFILE"
    elif [ "$kind" = "floating" ]; then
        printf 'pixels       NO  — visible-capable display but its surface is detached\n'
        printf '             (screen off, or the float window is hidden) — try: %s show\n' "$0"
    else
        printf 'pixels       NO  — headless: screenshots time out, rAF never fires\n'
        printf "still works: node cdp.mjs --device %s 'document.title'   (JS/DOM/network/input)\n" "$DEVICE_PROFILE"
    fi
    relay_line
}

require_trackpad() {
    [ -n "$VDISPLAY" ] || { echo "pi-trackpad's vdisplay script not found (set VDISPLAY=...)" >&2; exit 1; }
}

# ---------------------------------------------------------------- verbs
case "${1:-status}" in
  overlay)
    overlay "${2:-}"
    ;;
  overlay-off)
    $ADB shell settings delete global overlay_display_devices >/dev/null
    sleep 3
    $ADB shell am start -n "$ACTIVITY" >/dev/null 2>&1 || true
    printf 'overlay-display setting cleared; app display %s\n' "$(display_of_app)"
    ;;
  headless)
    require_trackpad
    vd create --headless >/dev/null
    S="$(wait_kind headless)" || { echo "display did not come up: $S" >&2; exit 1; }
    ID="$(field "$S" id)"; [ "$ID" != "-1" ] || { echo "no display id in: $S" >&2; exit 1; }
    launch_on "$ID"; report "$ID" "$(field "$S" kind)" "$(field "$S" surface)"
    ;;
  visible)
    require_trackpad
    vd create >/dev/null
    S="$(wait_kind floating)" || { echo "display did not come up: $S" >&2; exit 1; }
    vd show >/dev/null || true
    S="$(vd_status)"
    ID="$(field "$S" id)"; [ "$ID" != "-1" ] || { echo "no display id in: $S" >&2; exit 1; }
    launch_on "$ID"; report "$ID" "$(field "$S" kind)" "$(field "$S" surface)"
    ;;
  phone)
    require_trackpad
    "$0" visible >/dev/null
    ID="$(field "$(vd_status)" id)"
    printf 'applying device profile %s on display %s\n' "$DEVICE_PROFILE" "$ID"
    node cdp.mjs --device "$DEVICE_PROFILE" --shot phone.png
    printf 'screenshot   %s/phone.png\n' "$PWD"
    ;;
  show|hide)
    require_trackpad
    vd "$1"; S="$(vd_status)"
    report "$(field "$S" id)" "$(field "$S" kind)" "$(field "$S" surface)"
    ;;
  none)
    require_trackpad
    vd destroy
    $ADB shell am start -n "$ACTIVITY" >/dev/null 2>&1 || true
    printf 'app display  %s (back on the phone)\n' "$(display_of_app)"
    ;;
  status)
    printf 'overlay set  %s\n' "$($ADB shell settings get global overlay_display_devices | tr -d '\r')"
    printf 'displays     %s\n' "$(all_ids)"
    printf 'app display  %s\n' "$(display_of_app)"
    if [ -n "$VDISPLAY" ]; then printf 'vdisplay     %s\n' "$(vd_status)"; else printf 'vdisplay     (pi-trackpad not installed)\n'; fi
    relay_line
    ;;
  *)
    sed -n '2,20p' "$0"; exit 1
    ;;
esac
