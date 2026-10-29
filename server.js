const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const databaseName = process.env.MYSQL_DATABASE || "basketball";
if (!/^[A-Za-z0-9_]+$/.test(databaseName)) throw new Error("MYSQL_DATABASE may contain only letters, numbers, and underscores");
const mysqlConfig = {
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "basketball",
  password: process.env.MYSQL_PASSWORD || "",
  waitForConnections: true,
  connectionLimit: 5,
  charset: "utf8mb4",
};
const pool = mysql.createPool({ ...mysqlConfig, database: databaseName });

async function ensureSchema() {
  const bootstrapPool = mysql.createPool({ ...mysqlConfig, connectionLimit: 1 });
  await bootstrapPool.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await bootstrapPool.end();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_key VARCHAR(100) NOT NULL PRIMARY KEY,
      payload JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT, relative);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };
  res.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

async function handle(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  if (pathname === "/api/health" && req.method === "GET") {
    json(res, 200, { ok: true });
    return;
  }
  if (pathname === "/api/workspace" && req.method === "GET") {
    const [rows] = await pool.query("SELECT payload, updated_at FROM workspaces WHERE workspace_key = ?", ["default"]);
    json(res, 200, rows[0] ? { workspace: rows[0].payload, updatedAt: rows[0].updated_at } : { workspace: null });
    return;
  }
  if (pathname === "/api/workspace" && req.method === "PUT") {
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "invalid JSON" });
      return;
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tactics)) {
      json(res, 400, { error: "invalid workspace" });
      return;
    }
    await pool.query(
      "INSERT INTO workspaces (workspace_key, payload) VALUES (?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)",
      ["default", JSON.stringify(parsed)],
    );
    json(res, 200, { ok: true });
    return;
  }
  serveStatic(req, res);
}

ensureSchema()
  .then(() => {
    http.createServer((req, res) => {
      handle(req, res).catch((error) => {
        console.error(error);
        json(res, 500, { error: "server error" });
      });
    }).listen(PORT, "0.0.0.0", () => console.log(`Basketball tactics server listening on ${PORT}`));
  })
  .catch((error) => {
    console.error("Unable to connect to MySQL", error.message);
    process.exitCode = 1;
  });
