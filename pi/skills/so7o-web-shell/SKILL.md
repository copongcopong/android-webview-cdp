---
name: so7o-web-shell
description: Search the live web and read pages through So7oWebShell, the installed So7o Android WebView shell driven over CDP. Use for current facts, news, docs, prices, or research that needs a real browser.
---

# So7oWebShell

So7oWebShell drives the installed Android app `app.so7o.webview` over CDP on
`127.0.0.1:9334`. No adb is needed. The home tile `So7oWebShell.owl` opens the app
and exposes a `launch` state for the MCP server.

## Use the MCP tools first

- `mcp__so7o_web_shell__web_search`: `{query, limit}`. Bing results with title, URL, and snippet.
- `mcp__so7o_web_shell__web_read`: `{url, maxChars}`. Final URL, title, and readable page text.
- `mcp__so7o_web_shell__status`: are the app and relay running?
- `mcp__so7o_web_shell__launch`: start the app through the home tile.

If the tools are not declared to the model yet, call them from codemode:

```js
await tools.mcp__so7o_web_shell__web_search({ query: "omarchy linux", limit: 6 })
await tools.mcp__so7o_web_shell__web_read({ url: "https://omarchy.org/" })
```

## Workflow

1. If a search reports that So7o is not running, call `launch`. If that fails,
   ask the user to open So7o from the app drawer. The launch tile must be on home.
2. Search with a specific query and ask for 4 to 8 results. Do not repeat the
   same query.
3. Read one or two of the best results with `web_read`, then answer from the page
   text. Snippets can miss context. Cite the final URLs.
4. If a page is a login wall or paywall, or a JavaScript app with no text, say so
   and use another result.
5. Prefer primary sources such as project docs, official sites, and the paper
   over aggregators.

## Fallback CLI

The same functions work without MCP:

```sh
node ~/.local/share/So7oWebShell/So7oWebShell.mjs status
node ~/.local/share/So7oWebShell/So7oWebShell.mjs launch
node ~/.local/share/So7oWebShell/So7oWebShell.mjs search "query" 6
node ~/.local/share/So7oWebShell/So7oWebShell.mjs read https://example.com
node ~/.local/share/So7oWebShell/cdp.mjs --repl
```

## Notes and limits

- Search is Bing through the phone's WebView. Keep the URL bare (`?q=…`); extra
  parameters (`count`, `setlang`) made Bing return junk results.
- Results depend on region, language, and rate limits. Open the app if Bing shows
  a consent or verification page.
- `web_read` returns page text; it does not capture screenshots. Screenshots need
  the app in the foreground and are outside this workflow.
- Search and read change the visible So7o page.
