import * as readline from "node:readline";
import * as fs from "node:fs";
// Minimal stdio MCP server. The marker proves whether disallowed calls reached the server.
const marker = process.argv[2];
const tools = [
  { name: "read_note", description: "Read a note", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: "write_note", description: "Change a note", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "unclassified", description: "Tool without safety metadata", inputSchema: { type: "object", properties: {} } },
];
const reader = readline.createInterface({ input: process.stdin });
reader.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "conduct-test", version: "1" } };
  else if (request.method === "tools/list") result = { tools };
  else if (request.method === "tools/call") {
    if (marker) fs.appendFileSync(marker, `${request.params.name}\n`);
    result = { content: [{ type: "text", text: "test note" }] };
  } else if (request.method === "ping") result = {};
  else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Not supported" } }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
