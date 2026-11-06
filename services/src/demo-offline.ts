// The whole story with no network and no accounts:  npm run demo:offline
// A client escrows 100 tUSD, a rushed draft is failed, a fixed draft passes, and the contract
// pays 80 and 20. Uses the in-memory copy of the contract rules (src/mock-chain.ts).

import { CLIENT_BALANCE, JOB_TITLE, demoJob, draftUrl, readDraft } from "./demo-config.js";
import { MOCK_ESCROW, MockLedger } from "./mock-chain.js";
import { tusdToUnits, unitsToTusd } from "./types.js";
import { newState, reviewOnce } from "./verifier/verifier.js";

const A = {
  client: "client.mock",
  freelancer: "freelancer.mock",
  editor: "editor.mock",
  verifier: "verifier.mock",
  arbiter: "arbiter.mock",
  token: "tusd.mock",
};
const BASE = "http://localhost:5190";

const ledger = new MockLedger();
ledger.mint(A.client, tusdToUnits(CLIENT_BALANCE));

// The "web": the verifier fetches drafts by URL, here served from the demo-deliverables folder.
const fetchText = async (url: string) => {
  if (url === draftUrl(BASE, 1)) return readDraft(1);
  if (url === draftUrl(BASE, 2)) return readDraft(2);
  throw new Error("404");
};

const say = (s: string) => console.log(s);
const balances = () =>
  say(
    `  balances: client ${unitsToTusd(ledger.balance(A.client))}, escrow ${unitsToTusd(ledger.balance(MOCK_ESCROW))}, ` +
      `freelancer ${unitsToTusd(ledger.balance(A.freelancer))}, editor ${unitsToTusd(ledger.balance(A.editor))} tUSD`,
  );

const client = ledger.as(A.client);
const freelancer = ledger.as(A.freelancer);
const verifierChain = ledger.as(A.verifier);
const state = newState();
const verify = () => reviewOnce({ chain: verifierChain, me: A.verifier, fetchText, log: (l) => say(`  verifier: ${l}`) }, state);

say(`\n1. The client posts a job: "${JOB_TITLE}", 100 tUSD, paid 80/20 to the freelancer and an editor.`);
const id = await client.createJob(demoJob(A));
await client.fundJob(id, A.token, tusdToUnits("100"));
say(`  job #${id} is funded and held in escrow.`);
balances();

say("\n2. The freelancer hands in a rushed first draft.");
await freelancer.submitWork(id, draftUrl(BASE, 1));
await verify();
say(`  job status: ${(await client.getJob(id))?.status}. The money is still in escrow.`);
balances();

say("\n3. The freelancer tries to approve their own work. The contract refuses.");
try {
  await freelancer.attest(id, true, "looks great to me");
} catch (e) {
  say(`  refused: ${(e as Error).message}`);
}

say("\n4. The freelancer reworks it and hands in a second draft.");
await freelancer.submitWork(id, draftUrl(BASE, 2));
await verify();
say(`  job status: ${(await client.getJob(id))?.status}.`);
balances();

say("\nThe verifier only said pass or fail. The contract moved the money.\n");
