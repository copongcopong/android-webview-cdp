#!/usr/bin/env bash
# Install the Pi + Omalauncher web-search integration for So7oWebShell.
# Run from anywhere: bash pi/install.sh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
dest="$HOME/.local/share/So7oWebShell"
widgets="$HOME/.config/omalauncher/widgets"
skill="$HOME/.pi/agent/skills/so7o-web-shell"
mcp="$HOME/.pi/agent/mcp.json"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing: %s\n' "$1" >&2
    return 1
  fi
}

need node
need cp
need owl-send || printf 'warning: owl-send not found; the launcher tile cannot auto-launch the app\n' >&2

mkdir -p "$dest" "$widgets" "$skill" "$(dirname "$mcp")"

install -m 755 "$here/So7oWebShell.mjs" "$dest/So7oWebShell.mjs"
install -m 644 "$here/mcp-server.mjs" "$dest/mcp-server.mjs"
install -m 644 "$here/../cdp.mjs" "$dest/cdp.mjs"
install -m 644 "$here/So7oWebShell.owl" "$widgets/So7oWebShell.owl"
install -m 644 "$here/skills/so7o-web-shell/SKILL.md" "$skill/SKILL.md"

if [ -f "$mcp" ]; then
  cp "$mcp" "$mcp.bak"
fi

node - "$mcp" "$dest/mcp-server.mjs" <<'NODE'
const fs = require("fs");
const path = require("path");
const [mcpPath, serverPath] = process.argv.slice(2);
let doc = {};
if (fs.existsSync(mcpPath)) doc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
if (!doc.mcpServers || typeof doc.mcpServers !== "object") doc.mcpServers = {};
doc.mcpServers["so7o-web-shell"] = {
  command: process.execPath,
  args: [serverPath],
  exposure: "direct",
  timeout: 90,
  description:
    "So7oWebShell: web search and page reading through the installed So7o Android WebView shell over CDP.",
};
fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
fs.writeFileSync(mcpPath, JSON.stringify(doc, null, 2) + "\n");
NODE

printf '\ninstalled:\n'
printf '  %s\n' "$dest/So7oWebShell.mjs" "$dest/mcp-server.mjs" "$dest/cdp.mjs"
printf '  %s\n' "$widgets/So7oWebShell.owl" "$skill/SKILL.md" "$mcp"

if command -v owl-check >/dev/null 2>&1; then
  printf '\nchecking the launcher tile...\n'
  owl-check "$widgets/So7oWebShell.owl" || true
fi

cat <<'EOF'

next:
  1. Make sure app.so7o.webview (So7o Android Webview Shell) is installed.
  2. pi mcp list                     # should show so7o-web-shell, 4 direct tools
  3. in a running pi session: /reload  (or start a new session)
  4. keep the So7oWebShell tile on home so `launch` can open the app.

search:  node ~/.local/share/So7oWebShell/So7oWebShell.mjs search "query" 6
read:    node ~/.local/share/So7oWebShell/So7oWebShell.mjs read https://example.com
EOF
