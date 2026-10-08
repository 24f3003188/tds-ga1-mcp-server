// ---------------------------------------------------------------
//  Tiny MCP server — NO dependencies, only Node's built-in modules.
//
//  The grader sends these messages, in this order:
//    1. initialize                  ("hi, what can you do?")
//    2. notifications/initialized   ("ok, thanks")
//    3. tools/list                  ("what tools do you have?")
//    4. tools/call  x 5             ("run solve_challenge")
//  Each tools/call carries a fresh X-Exam-Challenge HTTP header.
// ---------------------------------------------------------------
import http from "node:http";
import crypto from "node:crypto";

const EMAIL = "24f3003188@ds.study.iitm.ac.in".trim().toLowerCase();
const PORT = process.env.PORT || 10000;
const TOOL_NAME = "solve_challenge";
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// ---------- THE BRAIN: one incoming message -> one reply (or null) ----------
function answer(msg, headers) {
  const { id, method, params } = msg ?? {};
  if (typeof method !== "string") return null; // not a request (e.g. a stray reply) -> ignore
  if (id === undefined) return null;           // notifications (no id) never get a reply

  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return ok({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "exam-mcp-server", version: "1.0.0" },
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: [
          {
            name: TOOL_NAME,
            description:
              "Returns the first 16 hex chars of SHA-256('<X-Exam-Challenge header>:<registered email>').",
            inputSchema: { type: "object", properties: {} }, // no required inputs
          },
        ],
      });
    case "tools/call": {
      if (params?.name !== TOOL_NAME) return fail(-32602, `Unknown tool: ${params?.name}`);
      const challenge = headers["x-exam-challenge"]; // Node lowercases header names
      if (!challenge) {
        return ok({ isError: true, content: [{ type: "text", text: "Missing X-Exam-Challenge header" }] });
      }
      const hash = crypto.createHash("sha256").update(`${challenge}:${EMAIL}`).digest("hex");
      return ok({ content: [{ type: "text", text: hash.slice(0, 16) }] });
    }
    default:
      return fail(-32601, `Method not found: ${method}`); // newer clients use this to fall back politely
  }
}

// ---------- small helpers ----------
const run = (parsed, headers) =>
  (Array.isArray(parsed) ? parsed : [parsed]).map((m) => answer(m, headers)).filter(Boolean);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function addCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "*");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

const JSON_TYPE = { "Content-Type": "application/json" };
const sseSessions = new Map(); // only used by the old-style "SSE" door

// ---------- THE DOORS ----------
const server = http.createServer(async (req, res) => {
  try {
    addCors(req, res);
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const wantsStream = String(req.headers.accept || "").includes("text/event-stream");

    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    // Health check: handy for uptime pingers and for you to open in a browser.
    if ((req.method === "GET" || req.method === "HEAD") && (path === "/health" || (path === "/" && !wantsStream))) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("MCP server is running. Send JSON-RPC with POST.\n");
    }

    // DOOR B (old style): GET opens a long-lived stream; replies come back through it.
    if (req.method === "GET" && (path === "/sse" || path === "/")) {
      const sid = crypto.randomUUID();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      sseSessions.set(sid, { res, headers: req.headers });
      res.write(`event: endpoint\ndata: /messages?sessionId=${sid}\n\n`);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => { clearInterval(ping); sseSessions.delete(sid); });
      return;
    }
    if (req.method === "POST" && path === "/messages") {
      const session = sseSessions.get(url.searchParams.get("sessionId"));
      if (!session) { res.writeHead(404); return res.end("Unknown session"); }
      let parsed;
      try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400); return res.end("Bad JSON"); }
      for (const reply of run(parsed, { ...session.headers, ...req.headers })) {
        session.res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      }
      res.writeHead(202); return res.end("Accepted");
    }

    // DOOR A (modern "Streamable HTTP"): every message is a POST, the answer comes straight back.
    if (req.method === "POST") {
      let parsed;
      try { parsed = JSON.parse(await readBody(req)); }
      catch {
        res.writeHead(400, JSON_TYPE);
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      }
      const replies = run(parsed, req.headers);
      if (replies.length === 0) { res.writeHead(202); return res.end(); } // notifications: "202 Accepted", no body
      res.writeHead(200, JSON_TYPE);
      return res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    }

    res.writeHead(405, { Allow: "POST" });
    res.end("Method not allowed");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end("Server error");
  }
});

// Stops random 502 errors when a hosting proxy reuses an idle connection.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;

server.listen(PORT, "0.0.0.0", () => console.log(`MCP server listening on port ${PORT}`));