// The client posts the demo job and funds it:  npm run client:create
// Prints the job id and remembers it in .job so the other scripts can find it.

import { writeFileSync } from "node:fs";
import { nearChainFromEnv } from "../chain.js";
import { JOB_AMOUNT, JOB_TITLE, demoJob } from "../demo-config.js";
import { tusdToUnits } from "../types.js";

const need = (k: string) => process.env[k] ?? (console.error(`Missing ${k} in .env. Run npm run setup:testnet first.`), process.exit(1));
const token = need("TOKEN_CONTRACT");
const client = nearChainFromEnv("CLIENT");

console.log(`client: posting "${JOB_TITLE}" for ${JOB_AMOUNT} tUSD...`);
const id = await client.createJob(
  demoJob({
    freelancer: need("FREELANCER_ACCOUNT"),
    editor: need("EDITOR_ACCOUNT"),
    token,
    verifier: need("VERIFIER_ACCOUNT"),
    arbiter: need("ARBITER_ACCOUNT"),
    reviewWindowSecs: Number(process.env.REVIEW_WINDOW_SECS ?? 120),
  }),
);
console.log(`client: job #${id} created, funding ${JOB_AMOUNT} tUSD into escrow...`);
await client.fundJob(id, token, tusdToUnits(JOB_AMOUNT));
const job = await client.getJob(id);
console.log(`client: job #${id} is ${job?.status}. The money is held by the contract.`);
writeFileSync(new URL("../../.job", import.meta.url), String(id));
