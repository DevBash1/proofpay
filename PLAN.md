# ProofPay: plan

Working name. Tagline: **Escrow that pays when the work is verified.**

Tracks: `realworld` (primary), `agents`, `business`.
Deadline: 2026-11-14 23:59 UTC. Plan written 2026-11-05, so about 9 working days.

## Problem

A freelancer in Lagos does a job for a client abroad. Either the client pays upfront and risks getting nothing, or the freelancer delivers first and risks never being paid. Escrow platforms exist, but they take 10 to 20 percent, hold money for days, and a human has to review every delivery.

## Product

1. The **client** creates a job on a NEAR contract: freelancer, amount in a stablecoin, payout splits, acceptance criteria, deadline. They fund it. The money sits in escrow.
2. The **freelancer** submits the deliverable (text or a link).
3. A **verifier agent** checks it against the acceptance criteria and writes a short report. It attests the result on-chain.
4. **Pass:** the contract pays out automatically, split between the freelancer and anyone else the client listed (for example an editor at 20 percent). **Fail:** the freelancer gets the report and can rework and resubmit, up to 2 rounds.
5. **Safety valves:** the client can approve early or dispute. If the verifier never answers, the freelancer can claim after a review window. If nothing is ever submitted, the client can refund after the deadline.

The agent never holds the money. It can only say pass or fail. The contract decides what happens.

## Architecture

| Part | What it is | Where |
|---|---|---|
| `contract/` | Escrow contract, Rust, near-sdk 5. Jobs, funding through NEP-141 `ft_on_transfer`, submit, attest, dispute, claim, refund, payout splits. | NEAR testnet |
| `token/` | Test stablecoin "tUSD" (NEP-141, near-contract-standards). Testnet has no real stablecoin, so we deploy our own and say so. | NEAR testnet |
| `services/` | Verifier agent (TypeScript): reads submitted jobs, runs rule checks, optionally asks NEAR AI to judge criteria that need reading, attests on-chain. Also a mock ledger for offline runs and tests. | local or any server |
| `dashboard/` | Static page, no build step: jobs, escrow bar, criteria with pass or fail, report, payout split. Reads testnet RPC. | Vercel |

Acceptance criteria are a list the verifier can check:
- `min_words`, `must_include`, `must_not_include`, `url_ok`: deterministic, always on.
- `judge`: a free-text criterion the NEAR AI model scores with evidence. Optional. Without an API key only the deterministic ones run.

## Demo (about 70 seconds)

Job: "5 product descriptions for a Lagos sneaker store", 100 tUSD, split 80 percent to the freelancer and 20 percent to an editor.
1. Client funds the job. Dashboard shows 100 tUSD in escrow.
2. Freelancer submits a rushed draft. Verifier fails it: too short, missing the required keyword. Report appears. Money stays in escrow.
3. Freelancer fixes it and resubmits. Verifier passes it.
4. The contract pays 80 tUSD and 20 tUSD. Dashboard shows both balances change.

## What is deliberately left out

- One milestone per job (milestones are a stretch goal).
- One trusted verifier account per job. A panel of verifiers or a DAO arbiter is future work.
- Test stablecoin only. NEAR Intents has no testnet, so no cross-chain pay-in.
- The verifier checks rules and reads text. It cannot judge quality of images or code.

## Build notes that shape this plan

- The testnet faucet rate-limits after about 18 accounts a day. Create one faucet account and make everything else a sub-account of it.
- Write the contract tests before the services. The offline mock ledger mirrors the contract rules.
- Make the challenge and review windows configurable (`REVIEW_WINDOW_SECS`) so a demo does not wait minutes.
- Keep `.env` out of git and out of every recording.
- Record the video in the headless stage page, not the desktop.

## Schedule

| Day | Work |
|---|---|
| Nov 5 | Plan, scaffold, contract types and job lifecycle |
| Nov 6 to 7 | Contract complete with tests; token contract |
| Nov 8 | Verifier service, mock ledger, offline demo |
| Nov 9 | Testnet setup script, one live run |
| Nov 10 | Dashboard |
| Nov 11 | README and polish |
| Nov 12 | Record and edit video; make repo public; host dashboard |
| Nov 13 | X post and submission |
| Nov 14 | Buffer |

## Rules to respect

- Each repository can be submitted once.
- README written for a machine reader: "do X, see Y" steps, LICENSE, list of libraries, AI-assistance disclosure.
- Nothing is made public, pushed, posted or submitted without the owner's explicit yes.
