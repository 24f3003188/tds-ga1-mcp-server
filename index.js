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
// Parse all POST payloads as strings so the MCP SDK handles them natively
app.use(express.text({ type: "*/*" }));
app.use(express.json());

// GLOBAL STATE: Completely bypasses sessionId routing issues
let activeTransport = null;
let activeHeaders = {};

function createMcpServer() {
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

    // Always read from the globally tracked headers updated on the latest POST
    const challenge = activeHeaders["x-exam-challenge"] || "";

    const rawString = `${challenge}:${EMAIL}`;
    const hash = crypto.createHash("sha256").update(rawString).digest("hex");

    return {
      content: [{ type: "text", text: hash.substring(0, 16) }],
    };
  });

  return server;
}

const handleSse = async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer();

  // Overwrite the global state with the active grading session
  activeTransport = transport;
  activeHeaders = req.headers;

  await server.connect(transport);
};

// Listen on both /sse and /
app.get(["/sse", "/"], handleSse);

// CATCH-ALL POST ROUTE: Accepts the request regardless of path or missing sessionId
app.post("*", async (req, res) => {
  if (!activeTransport) {
    return res.status(400).send("SSE connection not established yet");
  }

  // Update global headers so the tool call has the freshest X-Exam-Challenge
  activeHeaders = req.headers;

  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  await activeTransport.handlePostMessage(req, res, body);
});

app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
});