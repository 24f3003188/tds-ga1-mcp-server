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

// Enable CORS for external grader requests
app.use(cors());

// Parse incoming body as raw text/string for ALL content types on /messages
app.use("/messages", express.text({ type: "*/*" }));
app.use(express.json());

// Store dynamic session states and per-session headers
const transports = new Map();

function createMcpServer(sessionId) {
  const server = new Server(
    {
      name: "exam-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // 1. List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "solve_challenge",
          description: "Solves the exam header verification challenge",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      ],
    };
  });

  // 2. Execute tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "solve_challenge") {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    // Retrieve the headers stored from the latest POST request on this session
    const session = transports.get(sessionId);
    const headers = session?.lastHeaders || {};

    // Express automatically lowercases header names
    const challenge = headers["x-exam-challenge"] || "";

    // Compute SHA-256("${challenge}:${normalizedEmail}")
    const rawString = `${challenge}:${EMAIL}`;
    const hash = crypto.createHash("sha256").update(rawString).digest("hex");
    const responseText = hash.substring(0, 16);

    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  });

  return server;
}

// SSE Connection Handler
const handleSse = async (req, res) => {
    // Dynamically resolve the absolute host HTTPS URL
    const host = req.get("host");
    const absoluteMessageUrl = `https://${host}/messages`;
  
    // Pass the full absolute URL to SSEServerTransport
    const transport = new SSEServerTransport(absoluteMessageUrl, res);
    const server = createMcpServer(transport.sessionId);
  
    transports.set(transport.sessionId, {
      transport,
      server,
      lastHeaders: req.headers,
    });
  
    transport.onclose = () => {
      transports.delete(transport.sessionId);
    };
  
    await server.connect(transport);
};

// Listen on both /sse and root / to prevent 404s on base endpoint checks
app.get("/sse", handleSse);
app.get("/", handleSse);

// Handle POST messages sent by the MCP client
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = transports.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  // Save latest HTTP request headers on every tool call
  session.lastHeaders = req.headers;

  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  await session.transport.handlePostMessage(req, res, body);
});

app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
});