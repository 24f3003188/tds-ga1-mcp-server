// Mini-grader: pretends to be the exam grader and checks YOUR live server.
//   Run:  node test.mjs https://YOUR-APP.onrender.com/mcp
import crypto from "node:crypto";

const url = process.argv[2];
const EMAIL = "24f3003188@ds.study.iitm.ac.in";
if (!url) { console.log("Usage: node test.mjs <your public https URL>"); process.exit(1); }

let nextId = 1;
let problems = 0;
const report = (ok, text) => { if (!ok) problems++; console.log(`${ok ? "PASS" : "FAIL"}  ${text}`); };

async function send(message, extraHeaders = {}) {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extraHeaders },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(60_000),
  });
  let text = await res.text();
  if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
    text = (text.split("\n").find((l) => l.startsWith("data:")) || "").slice(5).trim(); // unwrap SSE reply
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, text, json, ms: Date.now() - t0 };
}
const request = (method, params, headers) => send({ jsonrpc: "2.0", id: nextId++, method, params }, headers);

try {
  // 1) initialize
  const init = await request("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "my-mini-grader", version: "1.0.0" },
  });
  report(init.status === 200 && !!init.json?.result?.protocolVersion,
    `initialize -> HTTP ${init.status} in ${init.ms} ms ${init.json?.result ? "" : "| body: " + init.text.slice(0, 120)}`);
  if (init.ms > 8000) console.log("      (slow first reply = your host was asleep. See 'keep it awake' step!)");

  // 2) notifications/initialized  (a notification has NO id and gets no reply body)
  const note = await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  report(note.status === 202 || note.status === 200, `notifications/initialized -> HTTP ${note.status}`);

  // 3) tools/list
  const list = await request("tools/list", {});
  const names = (list.json?.result?.tools || []).map((t) => t.name);
  report(names.includes("solve_challenge"), `tools/list -> [${names.join(", ")}]`);

  // 4) five tools/call, each with a brand-new random challenge header
  for (let i = 1; i <= 5; i++) {
    const challenge = crypto.randomBytes(16).toString("hex"); // 32 lowercase hex chars
    const want = crypto.createHash("sha256").update(`${challenge}:${EMAIL}`).digest("hex").slice(0, 16);
    const call = await request("tools/call", { name: "solve_challenge", arguments: {} }, {
      "X-Exam-Challenge": challenge, "X-Exam-Timestamp": String(Date.now()), "X-Exam-Signature": "not-checked-here",
    });
    const got = call.json?.result?.content?.[0]?.text;
    report(got === want, `tools/call #${i} -> got ${got}  want ${want}`);
  }
} catch (err) {
  problems++;
  console.log(`FAIL  Could not talk to the server: ${err.message}`);
  console.log("      Is it deployed, awake, and is the URL public https?");
}

console.log(problems === 0 ? "\nALL CHECKS PASSED - you're ready to submit." : `\n${problems} check(s) failed - fix those first.`);
process.exit(problems ? 1 : 0);
