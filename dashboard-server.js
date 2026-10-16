// Tiny web server for the Memory Companion caregiver dashboard.
// No extra packages needed. Run:  node dashboard-server.js
// Then open http://localhost:3000 (in Codespaces, use the "Open in Browser" popup).

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "memory-companion-data.json");
const PAGE_FILE = path.join(__dirname, "dashboard.html");
const EMPTY = '{"messages":[],"doses":[],"meals":[],"alerts":[]}';

http
  .createServer((req, res) => {
    const url = req.url.split("?")[0];

    if (url === "/api/data") {
      let body = EMPTY;
      try {
        body = fs.readFileSync(DATA_FILE, "utf8");
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(body);
    }

    if (url === "/" || url === "/dashboard.html") {
      try {
        const html = fs.readFileSync(PAGE_FILE);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(html);
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain" });
        return res.end("dashboard.html not found next to dashboard-server.js");
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  })
  .listen(PORT, () => {
    console.log(`Memory Companion dashboard running at http://localhost:${PORT}`);
  });