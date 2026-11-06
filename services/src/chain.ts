import { Account, JsonRpcProvider, teraToGas, nearToYocto } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import type { Job, NewJob } from "./types.js";

/** What the verifier needs from the escrow contract. */
export interface VerifierChain {
  recentJobs(limit: number): Promise<Job[]>;
  /** Verifier only. */
  attest(jobId: number, passed: boolean, report: string): Promise<void>;
}

/** Everything the demo scripts do on behalf of the client and the freelancer. */
export interface EscrowChain extends VerifierChain {
  getJob(jobId: number): Promise<Job | null>;
  createJob(job: NewJob): Promise<number>;
  /** Client: send the stablecoin to the escrow with msg "fund:<id>". */
  fundJob(jobId: number, token: string, amount: bigint): Promise<void>;
  /** Freelancer. */
  submitWork(jobId: number, deliverable: string): Promise<void>;
  balanceOf(token: string, account: string): Promise<bigint>;
}

export interface NearChainConfig {
  rpcUrl: string;
  escrowId: string;
  accountId: string; // the account that signs
  privateKey: string; // ed25519:...
}

export class NearChain implements EscrowChain {
  private provider: JsonRpcProvider;
  private account: Account;

  constructor(private cfg: NearChainConfig) {
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
    this.account = new Account(cfg.accountId, this.provider, cfg.privateKey as KeyPairString);
  }

  private view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.provider.callFunction({ contractId, method, args }) as Promise<T>;
  }

  private call(contractId: string, methodName: string, args: Record<string, unknown>, deposit = 0n, tgas = 100) {
    return this.account.callFunction({ contractId, methodName, args, gas: teraToGas(tgas), deposit });
  }

  recentJobs(limit: number) {
    return this.view<Job[]>(this.cfg.escrowId, "recent_jobs", { limit });
  }

  getJob(jobId: number) {
    return this.view<Job | null>(this.cfg.escrowId, "get_job", { job_id: jobId });
  }

  async createJob(job: NewJob): Promise<number> {
    const result = await this.call(
      this.cfg.escrowId,
      "create_job",
      {
        freelancer: job.freelancer,
        token: job.token,
        amount: job.amount.toString(),
        splits: job.splits,
        criteria: job.criteria,
        verifier: job.verifier,
        arbiter: job.arbiter,
        deadline_secs: job.deadlineSecs,
        review_window_secs: job.reviewWindowSecs,
        max_rounds: job.maxRounds,
      },
      nearToYocto("0.02"),
    );
    if (typeof result === "number") return result;
    // Fallback if the SDK does not return the value: the newest job by this client.
    const count = await this.view<number>(this.cfg.escrowId, "job_count");
    return count - 1;
  }

  async fundJob(jobId: number, token: string, amount: bigint) {
    await this.call(
      token,
      "ft_transfer_call",
      { receiver_id: this.cfg.escrowId, amount: amount.toString(), msg: `fund:${jobId}` },
      1n,
      150,
    );
  }

  async submitWork(jobId: number, deliverable: string) {
    await this.call(this.cfg.escrowId, "submit_work", { job_id: jobId, deliverable });
  }

  async attest(jobId: number, passed: boolean, report: string) {
    await this.call(this.cfg.escrowId, "attest", { job_id: jobId, passed, report });
  }

  async balanceOf(token: string, account: string) {
    const v = await this.view<string>(token, "ft_balance_of", { account_id: account });
    return BigInt(v);
  }
}

export type Role = "CLIENT" | "FREELANCER" | "VERIFIER";

export function nearChainFromEnv(role: Role): NearChain {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env var ${k} (see .env.example)`);
    return v;
  };
  return new NearChain({
    rpcUrl: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com",
    escrowId: need("ESCROW_CONTRACT"),
    accountId: need(`${role}_ACCOUNT`),
    privateKey: need(`${role}_KEY`),
  });
}
