// The freelancer hands in a draft:  npm run freelancer:submit -- 1     (or 2)
// The draft is served by `npm run serve:deliverables`; the contract stores only its URL.

import { readFileSync } from "node:fs";
import { nearChainFromEnv } from "../chain.js";
import { draftUrl } from "../demo-config.js";

const n = Number(process.argv[2]);
if (n !== 1 && n !== 2) {
  console.error("Usage: npm run freelancer:submit -- <1|2>");
  process.exit(1);
}
const id = Number(readFileSync(new URL("../../.job", import.meta.url), "utf8"));
const url = draftUrl(process.env.DELIVERABLES_URL ?? "http://localhost:5190", n);

const freelancer = nearChainFromEnv("FREELANCER");
console.log(`freelancer: submitting draft ${n} for job #${id}: ${url}`);
await freelancer.submitWork(id, url);
console.log("freelancer: submitted. Waiting for the verifier is up to it.");
