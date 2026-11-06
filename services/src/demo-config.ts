import { readFileSync } from "node:fs";
import type { NewJob } from "./types.js";
import { tusdToUnits } from "./types.js";

export const JOB_AMOUNT = "100"; // tUSD
export const CLIENT_BALANCE = "1000"; // tUSD minted to the client in the demo

/** What the client asks for. The verifier reads these rules, nobody else interprets them. */
export const CRITERIA = {
  min_items: 5,
  min_words: 100,
  must_include: ["Lagos", "free delivery"],
  must_not_include: ["lorem ipsum"],
};

export const JOB_TITLE = "5 product descriptions for a Lagos sneaker store";

/** 80 percent to the freelancer, 20 percent to the editor. */
export function demoJob(p: {
  freelancer: string;
  editor: string;
  token: string;
  verifier: string;
  arbiter: string;
  reviewWindowSecs?: number;
}): NewJob {
  return {
    freelancer: p.freelancer,
    token: p.token,
    amount: tusdToUnits(JOB_AMOUNT),
    splits: [
      { account: p.freelancer, bps: 8_000 },
      { account: p.editor, bps: 2_000 },
    ],
    criteria: JSON.stringify(CRITERIA),
    verifier: p.verifier,
    arbiter: p.arbiter,
    deadlineSecs: 86_400,
    reviewWindowSecs: p.reviewWindowSecs ?? 120,
    maxRounds: 3,
  };
}

const dir = new URL("../demo-deliverables/", import.meta.url);

/** The two drafts the freelancer hands in. The first is rushed, the second meets the brief. */
export const readDraft = (n: 1 | 2) => readFileSync(new URL(`draft-${n}.txt`, dir), "utf8");

export const DELIVERABLES_PORT = 5190;
export const draftUrl = (base: string, n: 1 | 2) => `${base.replace(/\/$/, "")}/draft-${n}.txt`;
