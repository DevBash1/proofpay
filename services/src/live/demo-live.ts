// The whole story on testnet:  npm run demo:live
// Needs `npm run serve:deliverables` and `npm run verifier` running in two other terminals.

import { nearChainFromEnv } from "../chain.js";
import { JOB_AMOUNT, JOB_TITLE, demoJob, draftUrl } from "../demo-config.js";
import type { Job } from "../types.js";
import { tusdToUnits, unitsToTusd } from "../types.js";

const need = (k: string) => process.env[k] ?? (console.error(`Missing ${k} in .env. Run npm run setup:testnet first.`), process.exit(1));
const token = need("TOKEN_CONTRACT");
const base = process.env.DELIVERABLES_URL ?? "http://localhost:5190";
const client = nearChainFromEnv("CLIENT");
const freelancer = nearChainFromEnv("FREELANCER");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.log(s);

async function balances() {
  const [c, e, f, ed] = await Promise.all(
    [process.env.CLIENT_ACCOUNT!, process.env.ESCROW_CONTRACT!, process.env.FREELANCER_ACCOUNT!, process.env.EDITOR_ACCOUNT!].map((a) =>
      client.balanceOf(token, a),
    ),
  );
  say(`  balances: client ${unitsToTusd(c!)}, escrow ${unitsToTusd(e!)}, freelancer ${unitsToTusd(f!)}, editor ${unitsToTusd(ed!)} tUSD`);
}

async function waitFor(id: number, done: (j: Job) => boolean, what: string, ms = 180_000): Promise<Job> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const j = await client.getJob(id);
    if (j && done(j)) return j;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${what}. Is the verifier running (npm run verifier)?`);
}

say(`\n1. The client posts "${JOB_TITLE}" and funds ${JOB_AMOUNT} tUSD.`);
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
await client.fundJob(id, token, tusdToUnits(JOB_AMOUNT));
say(`  job #${id} funded.`);
await balances();

say("\n2. The freelancer hands in a rushed first draft.");
await freelancer.submitWork(id, draftUrl(base, 1));
const failed = await waitFor(id, (j) => j.status !== "Submitted", "the verifier's first ruling");
say(`  status: ${failed.status}\n  report: ${failed.report}`);
await balances();

say("\n3. The freelancer reworks it and resubmits.");
await freelancer.submitWork(id, draftUrl(base, 2));
const passed = await waitFor(id, (j) => j.status === "Paid" || j.status === "Rejected" || j.status === "Rework", "the second ruling");
say(`  status: ${passed.status}\n  report: ${passed.report}`);
const paid = await waitFor(id, (j) => j.status === "Paid" || j.status === "Rejected", "the payout", 60_000).catch(() => passed);
say(`  final status: ${paid.status}`);
await balances();
say("\nThe verifier only said pass or fail. The contract moved the money.\n");
