import type { VerifierChain } from "../chain.js";
import { evaluate } from "./criteria.js";

export interface VerifierDeps {
  chain: VerifierChain;
  /** The account this verifier signs as. It only reviews jobs that name it. */
  me: string;
  fetchText: (url: string) => Promise<string>;
  log: (line: string) => void;
}

export interface VerifierState {
  /** Submissions already ruled on, keyed "<job id>:<round>". */
  done: Set<string>;
  /** Failed fetches per submission, so a flaky host does not fail the freelancer. */
  fetchFailures: Map<string, number>;
}

export const newState = (): VerifierState => ({ done: new Set(), fetchFailures: new Map() });

const MAX_FETCH_FAILURES = 3;
const looksLikeUrl = (s: string) => /^https?:\/\//i.test(s.trim());

/** Load what the freelancer delivered: a URL is fetched, anything else is the text itself. */
async function load(deliverable: string, fetchText: VerifierDeps["fetchText"]): Promise<string> {
  return looksLikeUrl(deliverable) ? fetchText(deliverable.trim()) : deliverable;
}

/**
 * One pass over the contract. For every submission waiting for this verifier: load it, check it
 * against the job's criteria, and record pass or fail on-chain. The verifier never moves money;
 * the contract pays out (or asks for rework) on its own once the verdict is recorded.
 */
export async function reviewOnce(deps: VerifierDeps, state: VerifierState): Promise<number> {
  const jobs = await deps.chain.recentJobs(50);
  let ruled = 0;
  for (const job of jobs) {
    if (job.status !== "Submitted" || job.verifier !== deps.me || !job.submission) continue;
    const key = `${job.id}:${job.submission.round}`;
    if (state.done.has(key)) continue;
    const tag = `job #${job.id} round ${job.submission.round}`;
    try {
      let content: string;
      try {
        content = await load(job.submission.deliverable, deps.fetchText);
      } catch (e) {
        const n = (state.fetchFailures.get(key) ?? 0) + 1;
        state.fetchFailures.set(key, n);
        if (n < MAX_FETCH_FAILURES) {
          deps.log(`${tag}: could not load the deliverable (${(e as Error).message}), will retry (${n}/${MAX_FETCH_FAILURES})`);
          continue;
        }
        const report = `FAIL: the deliverable could not be loaded after ${MAX_FETCH_FAILURES} tries (${(e as Error).message}).`.slice(0, 900);
        await deps.chain.attest(job.id, false, report);
        state.done.add(key);
        ruled++;
        deps.log(`${tag}: FAIL, deliverable unreachable`);
        continue;
      }
      const verdict = await evaluate(job.criteria, content);
      await deps.chain.attest(job.id, verdict.passed, verdict.report);
      state.done.add(key);
      ruled++;
      deps.log(`${tag}: ${verdict.report}`);
    } catch (e) {
      deps.log(`${tag}: error, will retry: ${(e as Error).message}`);
    }
  }
  return ruled;
}
