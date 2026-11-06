// Runs the verifier against the live escrow contract:  npm run verifier
// It signs as VERIFIER_ACCOUNT and only reviews jobs that name that account.

import { nearChainFromEnv } from "../chain.js";
import { llmAvailable } from "../llm.js";
import { newState, reviewOnce } from "./verifier.js";

const MAX_BYTES = 200_000;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("deliverable is larger than 200 KB");
  return text;
}

const chain = nearChainFromEnv("VERIFIER");
const me = process.env.VERIFIER_ACCOUNT!;
const pollMs = Number(process.env.VERIFIER_POLL_MS ?? 3000);
const state = newState();

console.log(`verifier watching ${process.env.ESCROW_CONTRACT} as ${me}; model review ${llmAvailable() ? "on" : "off (rules only)"}`);

for (;;) {
  try {
    await reviewOnce({ chain, me, fetchText, log: console.log }, state);
  } catch (e) {
    console.log(`poll failed: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
