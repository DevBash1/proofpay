// One-shot testnet setup. Run once:  npm run setup:testnet
//   1. asks the public testnet faucet for two funded accounts (free test NEAR); everything else
//      is a sub-account of those two, so the faucet's daily limit is not a problem
//   2. deploys the escrow contract and the tUSD test token, and initializes both
//   3. registers the accounts that will receive tUSD, and mints the client some
//   4. writes everything to services/.env (git-ignored). Private keys are never printed.
//
// Testnet only. It refuses to run if .env already exists.

import { Account, JsonRpcProvider, KeyPair, teraToGas, nearToYocto } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CLIENT_BALANCE } from "./demo-config.js";
import { tusdToUnits } from "./types.js";

const ENV_PATH = new URL("../.env", import.meta.url);
const WASM = (name: string) =>
  new URL(`../../target/wasm32-unknown-unknown/release/${name}.wasm`, import.meta.url);
const RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const FAUCETS = ["https://helper.nearprotocol.com/account", "https://helper.testnet.near.org/account"];

if (existsSync(ENV_PATH)) {
  console.error(".env already exists. Delete it first if you really want a fresh setup (old accounts stay on-chain).");
  process.exit(1);
}
for (const w of ["proofpay_escrow", "proofpay_test_token"]) {
  if (!existsSync(WASM(w))) {
    console.error(`Missing ${w}.wasm. Build it first: cargo build --workspace --target wasm32-unknown-unknown --release`);
    process.exit(1);
  }
}

const provider = new JsonRpcProvider({ url: RPC });
const suffix = randomBytes(3).toString("hex");
const gas = (n: number) => teraToGas(n);

// Two faucet accounts: A holds the contracts, B holds the people.
const faucetRoles = ["a", "b"] as const;
type FaucetRole = (typeof faucetRoles)[number];
const rootId = (r: FaucetRole) => `pp-${r}-${suffix}.testnet`;
const rootKeys = Object.fromEntries(faucetRoles.map((r) => [r, KeyPair.fromRandom("ed25519")])) as Record<FaucetRole, KeyPair>;

async function fund(r: FaucetRole) {
  const body = JSON.stringify({ newAccountId: rootId(r), newAccountPublicKey: rootKeys[r].getPublicKey().toString() });
  let last = "";
  for (const url of FAUCETS) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (res.ok) return;
      last = `${url} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
    } catch (e) {
      last = `${url} -> ${(e as Error).message}`;
    }
  }
  throw new Error(`faucet failed for ${rootId(r)}: ${last}`);
}

const root = (r: FaucetRole) => new Account(rootId(r), provider, rootKeys[r].toString() as KeyPairString);

async function waitFor(r: FaucetRole) {
  for (let i = 0; i < 20; i++) {
    try {
      return await root(r).getBalance();
    } catch {
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
  throw new Error(`account ${rootId(r)} never appeared on chain`);
}

console.log(`creating faucet accounts with suffix -${suffix} on testnet...`);
for (const r of faucetRoles) {
  await fund(r);
  const bal = await waitFor(r);
  console.log(`  ${rootId(r)} funded (${(Number(bal / 10n ** 21n) / 1000).toFixed(2)} NEAR)`);
}

// Sub-accounts, each with its own key.
interface Sub { id: string; key: KeyPair }
async function makeSub(parent: FaucetRole, prefix: string, near: `${number}`): Promise<Sub> {
  const key = KeyPair.fromRandom("ed25519");
  await root(parent).createSubAccount({ accountOrPrefix: prefix, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(near) });
  return { id: `${prefix}.${rootId(parent)}`, key };
}
const acct = (s: Sub) => new Account(s.id, provider, s.key.toString() as KeyPairString);

console.log("creating contract accounts...");
const escrow = await makeSub("a", "escrow", "4.8");
const token = await makeSub("a", "tusd", "3.8");
console.log("creating people accounts...");
const client = await makeSub("b", "client", "0.6");
const freelancer = await makeSub("b", "freelancer", "0.3");
const editor = await makeSub("b", "editor", "0.2");
const verifier = await makeSub("b", "verifier", "0.6");
const arbiter = await makeSub("b", "arbiter", "0.2");

console.log("deploying the escrow contract...");
await acct(escrow).deployContract(new Uint8Array(readFileSync(WASM("proofpay_escrow"))));
await acct(escrow).callFunction({ contractId: escrow.id, methodName: "new", args: {}, gas: gas(30), deposit: 0n });

console.log("deploying the tUSD test token...");
await acct(token).deployContract(new Uint8Array(readFileSync(WASM("proofpay_test_token"))));
await acct(token).callFunction({ contractId: token.id, methodName: "new", args: { owner: rootId("a") }, gas: gas(30), deposit: 0n });

console.log("registering token accounts and minting tUSD for the client...");
for (const who of [escrow.id, freelancer.id, editor.id]) {
  await root("a").callFunction({
    contractId: token.id,
    methodName: "storage_deposit",
    args: { account_id: who, registration_only: true },
    gas: gas(30),
    deposit: nearToYocto("0.01"),
  });
}
await root("a").callFunction({
  contractId: token.id,
  methodName: "mint",
  args: { account_id: client.id, amount: tusdToUnits(CLIENT_BALANCE).toString() },
  gas: gas(30),
  deposit: 0n,
});

const env = `# Generated by setup-testnet. Testnet only. Never commit this file.
NEAR_RPC_URL=${RPC}
ESCROW_CONTRACT=${escrow.id}
TOKEN_CONTRACT=${token.id}

CLIENT_ACCOUNT=${client.id}
CLIENT_KEY=${client.key.toString()}
FREELANCER_ACCOUNT=${freelancer.id}
FREELANCER_KEY=${freelancer.key.toString()}
EDITOR_ACCOUNT=${editor.id}
VERIFIER_ACCOUNT=${verifier.id}
VERIFIER_KEY=${verifier.key.toString()}
ARBITER_ACCOUNT=${arbiter.id}

# Owner of the tUSD token (can mint more)
OWNER_ACCOUNT=${rootId("a")}
OWNER_KEY=${rootKeys.a.toString()}

# Demo job terms
REVIEW_WINDOW_SECS=120
DELIVERABLES_URL=http://localhost:5190

# How often the verifier polls the contract, in ms
VERIFIER_POLL_MS=3000

# Optional: let a NEAR AI Cloud model judge free-text criteria
NEAR_AI_API_KEY=
`;
writeFileSync(ENV_PATH, env, { mode: 0o600 });

console.log(`
Done. Escrow: ${escrow.id}
  explorer: https://testnet.nearblocks.io/address/${escrow.id}
Next, in three terminals:
  npm run serve:deliverables
  npm run verifier
  npm run demo:live
`);
