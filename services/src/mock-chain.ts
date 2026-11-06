// In-memory copy of the escrow rules, for offline runs and tests. The Rust contract is the source
// of truth. This mirrors the main path: create, fund, submit, attest (pass pays out, fail asks for
// rework until the rounds run out). Deadlines, disputes, refunds and silence claims live only in
// the contract, where they are covered by its own tests.

import type { EscrowChain } from "./chain.js";
import type { Job, NewJob } from "./types.js";
import { splitAmounts } from "./types.js";

const ESCROW = "escrow.mock";

export class MockLedger {
  jobs: Job[] = [];
  balances = new Map<string, bigint>();
  /** Account ids in the order they were created, for readable output. */
  clock = 1;

  mint(account: string, amount: bigint) {
    this.balances.set(account, this.balance(account) + amount);
  }

  balance(account: string) {
    return this.balances.get(account) ?? 0n;
  }

  /** A chain handle that acts as `account`, like a signer on testnet. */
  as(account: string): MockChain {
    return new MockChain(this, account);
  }

  job(id: number): Job {
    const j = this.jobs[id];
    if (!j) throw new Error("job not found");
    return j;
  }

  payOut(job: Job) {
    const shares = splitAmounts(BigInt(job.amount), job.splits);
    job.splits.forEach((s, i) => {
      this.balances.set(ESCROW, this.balance(ESCROW) - (shares[i] ?? 0n));
      this.mint(s.account, shares[i] ?? 0n);
      s.paid = true;
    });
    job.status = "Paid";
  }
}

export class MockChain implements EscrowChain {
  constructor(private ledger: MockLedger, private me: string) {}

  async recentJobs(limit: number) {
    return structuredClone(this.ledger.jobs.slice().reverse().slice(0, limit));
  }

  async getJob(jobId: number) {
    const j = this.ledger.jobs[jobId];
    return j ? structuredClone(j) : null;
  }

  async createJob(n: NewJob) {
    const total = n.splits.reduce((a, s) => a + s.bps, 0);
    if (total !== 10_000) throw new Error("split basis points must add up to 10000");
    if (n.maxRounds < 1 || n.maxRounds > 5) throw new Error("max_rounds must be between 1 and 5");
    const id = this.ledger.jobs.length;
    const now = this.ledger.clock++;
    this.ledger.jobs.push({
      id,
      client: this.me,
      freelancer: n.freelancer,
      token: n.token,
      amount: n.amount.toString(),
      splits: n.splits.map((s) => ({ ...s, paid: false, sending: false })),
      criteria: n.criteria,
      verifier: n.verifier,
      arbiter: n.arbiter,
      created_at: String(now),
      deadline: String(now + n.deadlineSecs),
      review_window_secs: n.reviewWindowSecs,
      max_rounds: n.maxRounds,
      rounds: 0,
      status: "Created",
      submission: null,
      report: null,
      dispute_reason: null,
      refund_sending: false,
    });
    return id;
  }

  async fundJob(jobId: number, token: string, amount: bigint) {
    const j = this.ledger.job(jobId);
    if (this.me !== j.client) throw new Error("only the client can fund this job");
    if (token !== j.token) throw new Error("wrong token for this job");
    if (j.status !== "Created") throw new Error("job is already funded or closed");
    if (amount < BigInt(j.amount)) throw new Error("amount is less than the job amount");
    if (this.ledger.balance(this.me) < BigInt(j.amount)) throw new Error("not enough balance");
    this.ledger.mint(this.me, -BigInt(j.amount));
    this.ledger.mint(ESCROW, BigInt(j.amount));
    j.status = "Funded";
  }

  async submitWork(jobId: number, deliverable: string) {
    const j = this.ledger.job(jobId);
    if (this.me !== j.freelancer) throw new Error("only the freelancer can submit");
    if (j.status !== "Funded" && j.status !== "Rework") throw new Error("job is not open for submissions");
    if (!deliverable || deliverable.length > 1000) throw new Error("deliverable must be 1 to 1000 characters");
    j.rounds += 1;
    j.status = "Submitted";
    j.submission = { deliverable, submitted_at: String(this.ledger.clock++), round: j.rounds };
  }

  async attest(jobId: number, passed: boolean, report: string) {
    const j = this.ledger.job(jobId);
    if (this.me !== j.verifier) throw new Error("only the verifier can attest");
    if (j.status !== "Submitted") throw new Error("no submission is waiting for review");
    j.report = report;
    if (passed) this.ledger.payOut(j);
    else j.status = j.rounds >= j.max_rounds ? "Rejected" : "Rework";
  }

  async balanceOf(_token: string, account: string) {
    return this.ledger.balance(account);
  }
}

export const MOCK_ESCROW = ESCROW;
