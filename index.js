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
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());

// Parse raw text for /messages so MCP SDK receives a string
app.use("/messages", express.text({ type: "application/json" }));
app.use(express.json());

const transports = new Map();

function createMcpServer(req) {
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

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== "solve_challenge") {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const currentReq = extra?.req || req;
    const challenge = currentReq?.headers["x-exam-challenge"] || "";

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

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer(req);

  transports.set(transport.sessionId, { transport, server, req });

  transport.onclose = () => {
    transports.delete(transport.sessionId);
  };

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = transports.get(sessionId);

  if (!session) {
    return res.status(404).send("Session not found");
  }

  await session.transport.handlePostMessage(req, res, req.body, { req });
});

app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
});