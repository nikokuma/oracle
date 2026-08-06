#!/usr/bin/env node
import http from "node:http";

const portIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portIndex + 1]);
let currentHandle = "window-1";
let currentUrl = "about:blank";
const handles = [currentHandle];
const cookies = [];

function reply(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ value }));
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (request.method === "GET" && pathname === "/status") return reply(response, { ready: true });
    if (request.method === "POST" && pathname === "/session") {
      return reply(response, { sessionId: "fixture-session", capabilities: { browserName: "safari" } });
    }
    if (request.method === "DELETE" && pathname === "/session/fixture-session") {
      reply(response, null);
      return server.close(() => process.exit(0));
    }
    if (pathname === "/session/fixture-session/window/handles") return reply(response, handles);
    if (pathname === "/session/fixture-session/window" && request.method === "POST") {
      currentHandle = body.handle;
      return reply(response, null);
    }
    if (pathname === "/session/fixture-session/window/new") {
      const handle = `window-${handles.length + 1}`;
      handles.push(handle);
      currentHandle = handle;
      currentUrl = "about:blank";
      return reply(response, { handle, type: "tab" });
    }
    if (pathname === "/session/fixture-session/url" && request.method === "GET") return reply(response, currentUrl);
    if (pathname === "/session/fixture-session/url" && request.method === "POST") {
      currentUrl = body.url;
      return reply(response, null);
    }
    if (pathname === "/session/fixture-session/cookie" && request.method === "POST") {
      cookies.push(body.cookie);
      return reply(response, null);
    }
    if (pathname === "/session/fixture-session/cookie" && request.method === "GET") return reply(response, cookies);
    if (pathname.endsWith("/execute/sync")) return reply(response, true);
    return reply(response, { error: "unknown command", message: `${request.method} ${pathname} for ${currentHandle}` }, 404);
  });
});

server.listen(port, "127.0.0.1");
