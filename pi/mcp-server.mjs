#!/usr/bin/env node
// Minimal MCP stdio server exposing So7oWebShell: web search and page reading
// through the installed So7o Android WebView shell over CDP.
import { createInterface } from "node:readline";
import { search, readPage, status, launch } from "./So7oWebShell.mjs";

const SERVER = { name: "So7oWebShell", version: "1.0.0" };
const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the live web through So7oWebShell (the installed So7o Android WebView shell) and return titles, URLs, and snippets. Uses Bing, or DuckDuckGo HTML with engine=ddg. Use for current facts, news, docs, prices, or anything that needs a real browser. Up to 20 results; set brief to drop snippets and save tokens.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 20,
          default: 6,
          description: "How many results to return (1-20). Beyond 10, a second Bing page is fetched; keep it small to save tokens.",
        },
        brief: {
          type: "boolean",
          default: false,
          description: "Return only title and URL, with no snippet, to save tokens.",
        },
        engine: {
          type: "string",
          enum: ["bing", "ddg"],
          default: "bing",
          description: "bing (about 10 per page, up to 20 with a second page) or ddg (DuckDuckGo HTML, usually 10).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "web_read",
    description:
      "Open a URL in So7oWebShell and return its title and readable text. Use after web_search to read a result, or for a page you already have the URL of.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "An http(s) URL." },
        maxChars: {
          type: "number",
          minimum: 1000,
          maximum: 60000,
          default: 20000,
          description: "Maximum characters of text to return.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "status",
    description:
      "Check whether So7oWebShell's app and CDP relay are running, and list its page targets.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "launch",
    description:
      "Launch So7oWebShell's Android app if the CDP relay is not running. It asks the So7oWebShell home tile to open app.so7o.webview.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const text = (value) => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

async function callTool(name, args = {}) {
  switch (name) {
    case "web_search":
      return text(await search(args.query, { limit: args.limit, brief: args.brief, engine: args.engine }));
    case "web_read":
      return text(await readPage(args.url, { maxChars: args.maxChars }));
    case "status":
      return text(await status());
    case "launch":
      return text(await launch());
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    fail(null, -32700, "parse error");
    return;
  }
  const { id, method, params } = msg;
  try {
    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: SERVER,
          instructions:
            "So7oWebShell drives the installed So7o Android WebView shell over CDP. Use web_search for live web queries and web_read to open a result URL.",
        });
        break;
      case "notifications/initialized":
      case "notifications/cancelled":
        break;
      case "ping":
        reply(id, {});
        break;
      case "tools/list":
        reply(id, { tools: TOOLS });
        break;
      case "tools/call": {
        const name = params?.name;
        if (!TOOLS.some((t) => t.name === name)) {
          fail(id, -32602, `unknown tool ${name}`);
          break;
        }
        try {
          reply(id, await callTool(name, params?.arguments || {}));
        } catch (e) {
          reply(id, {
            content: [{ type: "text", text: `error: ${e.message || e}` }],
            isError: true,
          });
        }
        break;
      }
      case "resources/list":
        reply(id, { resources: [] });
        break;
      case "prompts/list":
        reply(id, { prompts: [] });
        break;
      case "logging/setLevel":
        reply(id, {});
        break;
      case "shutdown":
        reply(id, null);
        break;
      case "exit":
        process.exit(0);
        break;
      default:
        if (id != null) fail(id, -32601, `unknown method ${method}`);
    }
  } catch (e) {
    if (id != null) fail(id, -32603, String(e.message || e));
  }
});
