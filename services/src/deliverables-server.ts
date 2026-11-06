// Serves demo-deliverables/ on localhost so the verifier can fetch a freelancer's work by URL:
//   npm run serve:deliverables

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { DELIVERABLES_PORT } from "./demo-config.js";

const dir = new URL("../demo-deliverables/", import.meta.url);

createServer((req, res) => {
  const name = (req.url ?? "/").split("?")[0]!.replace(/^\/+/, "");
  if (!/^draft-\d+\.txt$/.test(name)) {
    res.writeHead(404).end("not found");
    return;
  }
  try {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(readFileSync(new URL(name, dir)));
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(DELIVERABLES_PORT, "127.0.0.1", () => {
  console.log(`serving demo deliverables on http://localhost:${DELIVERABLES_PORT}`);
});
