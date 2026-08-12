import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 31001);
const LOG_DIR = path.resolve(process.cwd(), "logs", "mock-hik-contact-data");

fs.mkdirSync(LOG_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    sendJson(res, 200, {
      ok: true,
      service: "mock-hik-contact-data",
      endpoints: ["/api/hik/eventRcv", "/api/hik/eventRtbw"]
    });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/api/hik/eventRcv" || url.pathname === "/api/hik/eventRtbw")) {
    const text = await readBody(req);
    const savedTo = savePacket(url.pathname, text);
    console.log(`[${new Date().toISOString()}] ${url.pathname} ${text.length} bytes -> ${savedTo}`);
    sendJson(res, 200, {
      code: 200,
      message: "mock mysql write ok",
      data: {
        savedTo,
        endpoint: url.pathname,
        bytes: Buffer.byteLength(text)
      }
    });
    return;
  }

  sendJson(res, 404, { code: 404, message: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`mock hik-contact-data started: http://${HOST}:${PORT}`);
  console.log(`saving packets to: ${LOG_DIR}`);
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function savePacket(endpoint, text) {
  const name = endpoint.endsWith("eventRtbw") ? "eventRtbw" : "eventRcv";
  const file = path.join(LOG_DIR, `${name}-${Date.now()}.json`);
  let content = text;
  try {
    content = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Keep the original body when the payload is not JSON.
  }
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
