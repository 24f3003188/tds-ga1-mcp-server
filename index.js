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

// Parse raw text for /messages so MCP SDK receives raw string payload
app.use("/messages", express.text({ type: "*/*" }));
app.use(express.json());

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

  // 1. Tool listing
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

  // 2. Tool invocation handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "solve_challenge") {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    // Fetch stored HTTP headers from the latest POST request on this session
    const session = transports.get(sessionId);
    const headers = session?.lastHeaders || {};

    // Read X-Exam-Challenge header (Express lowercases header names automatically)
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

// Handler for both /sse and root /
const handleSse = async (req, res) => {
  // Construct absolute message URL so the grader client connects accurately
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const transport = new SSEServerTransport(`${baseUrl}/messages`, res);
  
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

app.get("/sse", handleSse);
app.get("/", handleSse);

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = transports.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  // Update headers on every incoming tool call POST
  session.lastHeaders = req.headers;

  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  await session.transport.handlePostMessage(req, res, body);
});

app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
});