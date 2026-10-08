import express from "express";
import cors from "cors";
import crypto from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const EMAIL = "24f3003188@ds.study.iitm.ac.in".trim().toLowerCase();
const PORT = process.env.PORT || 10000;

const app = express();
app.use(cors());

// Parse raw text for ALL routes so MCP SDK receives raw string payload
app.use(express.text({ type: "*/*" }));
app.use(express.json());

const transports = new Map();

function createMcpServer(sessionId) {
  const server = new Server(
    { name: "exam-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "solve_challenge",
          description: "Solves the exam header verification challenge",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "solve_challenge") {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const session = transports.get(sessionId);
    const headers = session?.lastHeaders || {};
    const challenge = headers["x-exam-challenge"] || "";

    const rawString = `${challenge}:${EMAIL}`;
    const hash = crypto.createHash("sha256").update(rawString).digest("hex");
    const responseText = hash.substring(0, 16);

    return { content: [{ type: "text", text: responseText }] };
  });

  return server;
}

const handleSse = async (req, res) => {
  // Hardcode the absolute URL just to be absolutely certain
  const transport = new SSEServerTransport("https://tds-ga1-mcp-server.onrender.com/messages", res);
  const server = createMcpServer(transport.sessionId);

  transports.set(transport.sessionId, { transport, server, lastHeaders: req.headers });

  transport.onclose = () => transports.delete(transport.sessionId);
  await server.connect(transport);
};

// Accept GET requests on /sse and /
app.get(["/sse", "/"], handleSse);

// CATCH-ALL POST ROUTE: Catches /messages, /sse/messages, or anything else to prevent 404s
app.post("*", async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = transports.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  // Preserve request headers from the tool call POST request
  session.lastHeaders = req.headers;

  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  await session.transport.handlePostMessage(req, res, body);
});

app.listen(PORT, () => console.log(`MCP Server running on port ${PORT}`));