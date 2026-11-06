# ProofPay

**Escrow that pays when the work is verified.**

**Live demo:** https://devbash1.github.io/proofpay/ (dashboard reading the escrow contract on NEAR testnet)

Built for the NEAR Hackathon (tracks: Real-World Money, Agent Economy, Autonomous Business).

## The problem

A freelancer in Lagos does a job for a client abroad. Either the client pays upfront and risks getting nothing, or the freelancer delivers first and risks never being paid. Escrow platforms exist, but they take a large cut, hold money for days, and need a human to review every delivery.

## What ProofPay does

1. The **client** creates a job on a NEAR contract: the freelancer, the amount in a stablecoin, how the payout is split, the acceptance criteria, and a deadline. They fund it. The money is held by the contract.
2. The **freelancer** submits the work, as text or a link.
3. A **verifier** (a small service) checks the work against the criteria and records pass or fail on-chain, with a short report.
4. **Pass:** the contract pays out automatically, split between the people the client listed (for example 80% to the freelancer and 20% to an editor).
   **Fail:** the freelancer gets the reasons and can rework and resubmit, up to the number of rounds the job allows. After the last round the job is rejected and the client can take the money back.
5. Safety valves: the client can approve early or refund (after the deadline, or once rejected). Either side can dispute to an arbiter. If the verifier never answers, the freelancer can claim after the review window.

**The verifier never holds money.** It can only say pass or fail. The contract decides what happens, and it refuses a verdict from anyone else, including the freelancer.

## How NEAR is used

- **Smart contract on NEAR** (`contract/`, Rust, near-sdk 5): jobs, funding through the NEP-141 `ft_on_transfer` flow, submissions, verdicts, payouts, refunds, disputes. The chain enforces the rules, not a server.
- **NEP-141 stablecoin payments.** Payouts are `ft_transfer` calls. Failed transfers (for example a recipient not registered with the token) can be retried, and a retry is refused while a transfer is still in flight, so money can never be sent twice.
- **NEAR testnet** for the live demo. NEAR testnet has no real stablecoin, so `token/` deploys a test token, **tUSD** (6 decimals, owner-mintable, no backing).
- **NEAR AI Cloud** (optional): the verifier can ask a private model to judge free-text criteria. Without an API key those criteria are listed as "not checked" and never fail a job.

## What is in the repo

| Folder | What it is |
|---|---|
| `contract/` | The escrow contract (Rust). 26 unit tests. |
| `token/` | The tUSD test token (Rust, NEP-141). 2 unit tests. |
| `services/` | Verifier, in-memory ledger for offline runs, testnet setup and live demo scripts (TypeScript). 16 tests. |
| `dashboard/` | Live dashboard. Plain HTML/CSS/JS, no build step. Reads testnet RPC directly. |
| `PLAN.md` | Original design notes and schedule. |

## Try it

### 1. Offline demo (about 1 minute, no accounts, no network)

Needs Node.js 20 or newer.

```bash
cd services
npm install
npm test
npm run demo:offline
```

You will see: the client funds a 100 tUSD job, a rushed first draft is failed with the reasons (the money stays in escrow), the freelancer tries to approve their own work and the contract refuses, then a fixed second draft passes and the contract pays 80 and 20.

The offline run uses an in-memory copy of the contract rules (`services/src/mock-chain.ts`). It mirrors the main path (create, fund, submit, verdict, payout). Deadlines, disputes, refunds and silence claims live in the contract and are covered by its own tests. The Rust contract is the source of truth.

### 2. Contract tests

Needs Rust (https://rustup.rs) with the `wasm32-unknown-unknown` target.

```bash
cargo test --workspace
cargo build --workspace --target wasm32-unknown-unknown --release
```

You will see 28 tests pass (26 escrow, 2 token). On Windows, one dependency wants NASM. Avoid installing it by setting this first:

```powershell
$env:AWS_LC_SYS_PREBUILT_NASM = "1"
```

### 3. Live demo on NEAR testnet

Testnet NEAR is free. `setup:testnet` asks the public faucet for two accounts, creates sub-accounts for the contracts and the people, deploys both contracts from the wasm you just built, registers the token accounts, and mints 1,000 tUSD to the client. It writes keys to `services/.env` (git-ignored) and refuses to run if that file exists.

```bash
cd services
npm run setup:testnet
```

Then, in three terminals:

```bash
npm run serve:deliverables
```

```bash
npm run verifier
```

```bash
npm run demo:live
```

`demo:live` runs the whole story on chain and prints the balances after each step. Or run the steps one by one: `npm run client:create`, then `npm run freelancer:submit -- 1` (the rushed draft) and `npm run freelancer:submit -- 2` (the fixed one).

Set `REVIEW_WINDOW_SECS` in `services/.env` (default 120) to change how long the verifier has before the freelancer can claim.

Watch it live:

```bash
cd dashboard
node serve.mjs
```

Open http://localhost:5174, or use the hosted copy at https://devbash1.github.io/proofpay/. It reads the contract named in `dashboard/config.json`, or use `?escrow=<account>` in the URL.

### What a real run looked like (testnet, escrow `escrow.pp-a-57b7e7.testnet`)

| Step | Result |
|---|---|
| Client funds job #0 | 100 tUSD moves into escrow. Client balance 1000 to 900 |
| First draft (20 words, 3 items) | Failed: needs 100 words, 5 items, "Lagos" and "free delivery". Status Rework, money still in escrow |
| Second draft (5 items, all phrases) | Passed, 5 of 5 checks |
| Payout | Freelancer 80 tUSD, editor 20 tUSD, escrow 0 |
| Job #1, same story with the verifier started late | Showed Under Review while waiting, then Rework, then Paid |

Contract: https://testnet.nearblocks.io/address/escrow.pp-a-57b7e7.testnet

## The verifier

`services/src/verifier/` reviews each submission that names its account:

- **Rules (always on):** minimum and maximum word count, a minimum number of items (blocks separated by a blank line), phrases that must appear, phrases that must not appear. The rules are deterministic, so the text being judged cannot argue with them.
- **Model review (optional):** free-text criteria in a `judge` list are scored by a NEAR AI model that is told the delivered text is untrusted data. A model answer can only add checks, never remove the deterministic ones. With no key, or no answer, those criteria are skipped and reported as "Not checked".
- **Evidence:** every report ends with the first 16 characters of the SHA-256 of the text it checked, so the freelancer and client can see which version was judged.
- **Unreachable links** are retried twice and then failed with a clear report, so a flaky host does not fail the freelancer straight away.
- It rules on each submission once, and only on jobs that name it as verifier.

The acceptance criteria are plain JSON on the job, for example:

```json
{ "min_items": 5, "min_words": 100, "must_include": ["Lagos", "free delivery"], "must_not_include": ["lorem ipsum"] }
```

## Known limitations

- **One trusted verifier per job, and one arbiter account.** A panel of verifiers or a DAO arbiter (for example through Sputnik DAO) is future work. The client can always override with `approve`, and either side can dispute.
- **Silence pays the freelancer.** If the verifier does not answer within the review window, the freelancer can claim. That is a design choice, and it means a verifier that is offline for the whole window cannot block a legitimate payment. The client can dispute before that.
- **Test stablecoin only.** tUSD is a demo token. NEAR Intents has no testnet, so there is no cross-chain pay-in.
- **The verifier reads text.** It cannot judge images, design or code quality. The model review is a text judgment.
- **One milestone per job.**
- **On-chain limits:** a deliverable is at most 1000 characters (use a link for anything longer), and criteria at most 2000.
- **The 0.02 NEAR storage fee** attached when a job is created is kept by the contract and not refunded.
- **The offline mock** covers the main path only (see above).
- **Hosted dashboards can't open the demo drafts**, because the demo serves them from `localhost`. The link is still shown.
- **Not audited.** This is hackathon code. Do not put real funds in it.

## Security notes

- `services/.env` holds testnet private keys. It is git-ignored; never commit it.
- Everything the dashboard shows from the chain (accounts, deliverables, reports) is escaped before display, since freelancers and clients control that text.
- Only the verifier account can record a verdict, only the arbiter can resolve a dispute, and only the client can fund, approve or refund. Each is enforced in the contract and covered by a test.

## AI assistance and third-party code

Disclosed as the hackathon rules ask:

- The contracts, services, dashboard and this README were written with **Claude (Anthropic) through Claude Code**, directed and reviewed by the project owner. The tests were run on the author's machine, and the live testnet runs above were performed for real.
- Libraries: [`near-sdk`](https://crates.io/crates/near-sdk) 5 and [`near-contract-standards`](https://crates.io/crates/near-contract-standards) 5 (Rust), [`near-api-js`](https://www.npmjs.com/package/near-api-js) 7, `tsx` and `typescript` (dev tooling). The dashboard uses the Bricolage Grotesque and Hanken Grotesk fonts from Google Fonts. No templates were used.
- The project was started during the hackathon window. There is no pre-existing code and no product on another chain, so there is no baseline to separate out.

## License

MIT. See [LICENSE](LICENSE).
