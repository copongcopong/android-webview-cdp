# Pi + Omalauncher web search through So7oWebShell

This branch adds a Pi/Omalauncher layer to
[So7o Android Webview Shell](https://github.com/jan5o7o/android-webview-cdp). It uses the
app's CDP relay to search the web and read pages from Pi.

The Android app is unchanged. The additions live in `pi/`:

```
pi/
├── So7oWebShell.mjs                     # CLI + CDP library (search, read, status, launch, js)
├── mcp-server.mjs                       # MCP stdio server (4 tools, direct exposure)
├── So7oWebShell.owl                     # Omalauncher home tile (open / cdp / status)
├── skills/so7o-web-shell/SKILL.md       # Pi skill: when and how to search/read
├── install.sh                           # installs the files below
└── README.md
```

## Prerequisites

- Android 14+ with the So7o Android Webview Shell app installed
  (`app.so7o.webview`). Its relay must answer at `127.0.0.1:9334`.
- Omarchy/Omalauncher with Linux. The CLI and MCP server run there.
- Node 22+, `curl`, and `owl-send`/`owl-check` for the launcher tile.
- Pi with MCP support.

## Install

```sh
git clone -b feat/pi-on-omalauncher-web-search-shell-mcp-skill \
  https://github.com/copongcopong/android-webview-cdp.git
cd android-webview-cdp
bash pi/install.sh
pi mcp list
```

The branch is on the fork for now. Once it is merged, clone the upstream
`jan5o7o/android-webview-cdp` instead.

`install.sh` writes:

| Path | What it is |
|---|---|
| `~/.local/share/So7oWebShell/So7oWebShell.mjs` | CLI and library |
| `~/.local/share/So7oWebShell/mcp-server.mjs` | MCP server |
| `~/.local/share/So7oWebShell/cdp.mjs` | raw CDP client, copied from the repo root |
| `~/.config/omalauncher/widgets/So7oWebShell.owl` | home tile |
| `~/.pi/agent/skills/so7o-web-shell/SKILL.md` | Pi skill |
| `~/.pi/agent/mcp.json` | adds or updates `so7o-web-shell` (backup at `.bak`) |

In a running Pi session, run `/reload` or start a new session to pick up the
server and the skill.

## MCP tools

`so7o-web-shell` is registered with `exposure: direct`:

- `mcp__so7o_web_shell__web_search`: `{query, limit}`. Bing results with title, URL, and snippet.
- `mcp__so7o_web_shell__web_read`: `{url, maxChars}`. Final URL, title, and readable text.
- `mcp__so7o_web_shell__status`: relay state and page targets.
- `mcp__so7o_web_shell__launch`: starts `app.so7o.webview` through the home tile.

The skill `so7o-web-shell` describes the search and read workflow, plus the CLI
fallback when the MCP tools are not loaded.

## Launcher tile and auto-launch

The tile shows whether the relay is up and has open and cdp buttons. Its
`launch` state is the bridge used by `launch()`:

```
owl-send So7oWebShell.owl set launch <timestamp>
  -> on launch { androidApp("app.so7o.webview") }
```

Keep the tile on home. If the app is closed, the MCP `launch` tool sets the state
and waits for the relay. If the tile is gone, open the app from the drawer.

The app runs a foreground keep-alive service. Closing its window does not stop
the relay; use Android's Force stop on `app.so7o.webview` to test the launch path.

## CLI

```sh
node ~/.local/share/So7oWebShell/So7oWebShell.mjs status
node ~/.local/share/So7oWebShell/So7oWebShell.mjs launch
node ~/.local/share/So7oWebShell/So7oWebShell.mjs search "omarchy linux" 6
node ~/.local/share/So7oWebShell/So7oWebShell.mjs search "omarchy linux" 20 --brief
node ~/.local/share/So7oWebShell/So7oWebShell.mjs search "omarchy linux" 6 --ddg
node ~/.local/share/So7oWebShell/So7oWebShell.mjs read https://omarchy.org/ 12000
node ~/.local/share/So7oWebShell/cdp.mjs --repl
```

## Notes

- Search uses Bing by default. `engine: "ddg"` uses DuckDuckGo HTML, which also
  works in the WebView. Keep the Bing URL bare (`?q=…`); adding `count` or
  `setlang` made Bing return unrelated results.
- `limit` defaults to 6 and goes to 20. Bing fetches a second page past 10.
  `brief: true` drops snippets and returns only title and URL.
- `read` returns page text only; it does not capture screenshots. Screenshots
  need the app in the foreground and are outside this workflow.
- `search` and `read` include a `usage` block with `chars`, `words`, and
  `approx_tokens` (characters divided by 3.5). The MCP JSON is pretty-printed, so
  the model sees a little more. Use the model's reported usage for billing.

Measured with `gpt-tokenizer` on pretty JSON:

| Query | Results | Tokens |
|---|---|---|
| Bing, snippets | 6 | 468 |
| Bing, `brief` | 6 | 254 |
| Bing, snippets | 18 | 1,395 |
| Bing, `brief` | 18 | 743 |
| DDG, snippets | 6 | 490 |
- Updating the app leaves the installed CLI, skill, and tile in place.
  Updating those leaves the app alone.

License: MIT, same as the parent repo.
