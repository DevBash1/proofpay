// JSON shapes returned by the escrow contract. u128 and u64 values arrive as strings.

export type JobStatus =
  | "Created"
  | "Funded"
  | "Submitted"
  | "Rework"
  | "Rejected"
  | "Disputed"
  | "Paying"
  | "Paid"
  | "Refunding"
  | "Refunded"
  | "Cancelled";

export interface Split {
  account: string;
  bps: number;
  paid: boolean;
  sending: boolean;
}

export interface Job {
  id: number;
  client: string;
  freelancer: string;
  token: string;
  amount: string;
  splits: Split[];
  criteria: string;
  verifier: string;
  arbiter: string;
  created_at: string;
  deadline: string;
  review_window_secs: number;
  max_rounds: number;
  rounds: number;
  status: JobStatus;
  submission: { deliverable: string; submitted_at: string; round: number } | null;
  report: string | null;
  dispute_reason: string | null;
  refund_sending: boolean;
}

export interface NewJob {
  freelancer: string;
  token: string;
  amount: bigint;
  splits: { account: string; bps: number }[];
  criteria: string;
  verifier: string;
  arbiter: string;
  deadlineSecs: number;
  reviewWindowSecs: number;
  maxRounds: number;
}

export const TUSD_DECIMALS = 6;
const UNIT = 10n ** BigInt(TUSD_DECIMALS);

/** "100" or "12.5" to base units. */
export function tusdToUnits(value: string): bigint {
  const [whole = "0", frac = ""] = value.trim().split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || frac.length > TUSD_DECIMALS) {
    throw new Error(`invalid tUSD amount: ${value}`);
  }
  return BigInt(whole) * UNIT + BigInt(frac.padEnd(TUSD_DECIMALS, "0") || "0");
}

/** Base units to a readable string such as "80" or "12.5". */
export function unitsToTusd(units: bigint | string): string {
  const u = BigInt(units);
  const whole = u / UNIT;
  const frac = (u % UNIT).toString().padStart(TUSD_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Same rounding as the contract: round each share down, give the leftover to the first split. */
export function splitAmounts(amount: bigint, splits: { bps: number }[]): bigint[] {
  const out = splits.map((s) => (amount * BigInt(s.bps)) / 10_000n);
  const used = out.reduce((a, b) => a + b, 0n);
  out[0] = (out[0] ?? 0n) + (amount - used);
  return out;
}
