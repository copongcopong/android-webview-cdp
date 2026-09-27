#!/data/data/com.termux/files/usr/bin/bash
# Wire Termux to the So7o Android WebView shell's DevTools socket.
#
#   ./cdp-webview.sh up [port]    (re)launch + unfreeze the app, adb forward, verify
#   ./cdp-webview.sh direct       check the in-app relay on 127.0.0.1:9334 (no adb at all)
#   ./cdp-webview.sh status [port]  pid, frozen cgroup, forward, HTTP reachability
#   ./cdp-webview.sh info [port]    list page targets
#   ./cdp-webview.sh down [port]    remove the forward
#
# Why adb: the DevTools socket is an abstract unix socket owned by the app, and
# SELinux blocks every other app from connecting to it (Termux gets EACCES; the
# shell UID, i.e. Shizuku, is refused too). adbd is allowed, so `adb forward` is
# the way in — and because Termux's adb server runs on the device, the forward
# lands on the device's own loopback.
set -euo pipefail

# Default port is deliberately NOT 9222 — that one belongs to the existing
# Chrome CDP setup (~/cdp-search.mjs, ~/projects/termux-pi-browser-search).
PKG=app.so7o.webview
ACTIVITY="$PKG/.MainActivity"
PORT="${2:-9333}"
ADB="${ADB:-adb}"

pid_of() { $ADB shell pidof "$PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}'; }
http_code() {
  local p="${1:-$PORT}" c
  c="$(curl -s -m 4 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$p/json/version" 2>/dev/null || true)"
  echo "${c:-000}"
}
is_frozen() {
  local p; p="$(pid_of)"
  [ -z "$p" ] && { echo "no-process"; return; }
  $ADB shell cat "/proc/$p/cgroup" 2>/dev/null | grep -q frozen && echo "FROZEN" || echo "unfrozen"
}
socket_name() {
  local p s
  p="$(pid_of)"
  if [ -n "$p" ] && $ADB shell cat /proc/net/unix 2>/dev/null | grep -q "@webview_devtools_remote_$p"; then
    echo "webview_devtools_remote_$p"; return 0
  fi
  s="$($ADB shell cat /proc/net/unix 2>/dev/null | grep -o 'webview_devtools_remote_[0-9]*' | head -1 | tr -d '\r')"
  [ -n "$s" ] && { echo "$s"; return 0; }
  return 1
}

case "${1:-up}" in
  up)
    # Always (re)start: this both launches a dead app and *unfreezes* one the
    # platform parked in the frozen cgroup while it was in the background.
    $ADB shell am start -n "$ACTIVITY" >/dev/null 2>&1 || true
    for _ in $(seq 1 15); do [ -n "$(pid_of)" ] && break; sleep 0.5; done
    [ -n "$(pid_of)" ] || { echo "app did not start" >&2; exit 1; }

    if ! SOCK="$(socket_name)"; then
      echo "no webview_devtools_remote socket — is setWebContentsDebuggingEnabled reached?" >&2
      exit 1
    fi
    echo "pid $(pid_of)  socket $SOCK  ($(is_frozen))"

    $ADB forward --remove "tcp:$PORT" >/dev/null 2>&1 || true
    $ADB forward "tcp:$PORT" "localabstract:$SOCK" >/dev/null

    for _ in $(seq 1 12); do
      [ "$(http_code)" = "200" ] && break
      sleep 1
    done
    if [ "$(http_code)" != "200" ]; then
      echo "forward is up but the DevTools server did not answer (state: $(is_frozen))." >&2
      echo "If that says FROZEN, the process was parked: run '$0 up' again." >&2
      exit 1
    fi

    curl -s -m 5 "http://127.0.0.1:$PORT/json/version" \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  %s — %s — protocol %s" % (d.get("Android-Package"), d.get("Browser"), d.get("Protocol-Version")))'
    echo "ready -> http://127.0.0.1:$PORT   (then: node cdp.mjs --repl)"
    ;;
  direct)
    # The in-app relay needs no adb, so this is the check that proves it.
    if curl -s -m 4 -o /dev/null "http://127.0.0.1:9334/json/version"; then
      echo "relay UP on 127.0.0.1:9334 (no adb forward involved)"
      curl -s -m 5 http://127.0.0.1:9334/json/version \
        | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  %s — %s" % (d.get("Android-Package"), d.get("Browser")))'
      echo "then: node cdp.mjs --list"
    else
      echo "relay not answering on 9334." >&2
      echo "  - is the app running?  (it starts the relay in onCreate)"
      echo "  - is this the build that HAS RelayServer?  check logcat: adb logcat -s So7oWebViewRelay" >&2
      exit 1
    fi
    ;;
  status)
    printf 'pid      %s\n' "$(pid_of)"
    printf 'cgroup   %s\n' "$(is_frozen)"
    printf 'relay    %s  (127.0.0.1:9334 — in-app, no adb)\n' "$(http_code 9334)"
    printf 'forward  %s  (127.0.0.1:%s — adb)\n' "$(http_code "$PORT")" "$PORT"
    printf 'adb      %s\n' "$($ADB forward --list | grep "tcp:$PORT" || echo 'no forward on that port')"
    ;;
  info)
    TMP="${TMPDIR:-/tmp}/so7o-webview-targets.json"
    curl -s -m 5 "http://127.0.0.1:$PORT/json/list" > "$TMP"
    python3 - "$TMP" <<'PY'
import json, sys
for t in json.load(open(sys.argv[1])):
    print("%-8s %14s  %-26s %s" % (t.get("type", ""), t.get("id", ""),
          (t.get("title") or "")[:26], (t.get("url") or "")[:58]))
PY
    ;;
  down)
    $ADB forward --remove "tcp:$PORT" 2>/dev/null && echo "removed tcp:$PORT" || echo "nothing to remove on $PORT"
    ;;
  *)
    sed -n '2,10p' "$0"; exit 1
    ;;
esac
