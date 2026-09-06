import { createServer } from "node:http";
const page =
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Temporarily unavailable</title><style>body{background:#101820;color:#f4f7fb;font:18px system-ui;max-width:42rem;margin:15vh auto;padding:2rem}h1{color:#edab58}p{line-height:1.6}</style><h1>We’ll be back shortly.</h1><p>This application is undergoing maintenance. Please try again in a few minutes.</p></html>';
createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(503, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": "60",
    "x-content-type-options": "nosniff",
  });
  res.end(page);
}).listen(8080, "0.0.0.0");
