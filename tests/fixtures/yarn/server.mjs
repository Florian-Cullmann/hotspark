import { createServer } from "node:http";
import { readFileSync } from "node:fs";
createServer((req, res) =>
  res.end("hotspark-yarn-" + readFileSync("built.txt", "utf8")),
).listen(Number(process.env.PORT), "0.0.0.0");
