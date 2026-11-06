// Reads the ProofPay escrow contract straight from NEAR testnet RPC. No backend, no build step.
// Everything that comes from the chain (accounts, deliverables, reports) is untrusted text and is
// escaped before it is shown.

const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
const POLL_MS = 3000;
const DECIMALS = 6;
const EXPLORER = "https://testnet.nearblocks.io/address/";

const $app = document.getElementById("app");
const $jobs = document.getElementById("jobs");
const $live = document.getElementById("live");
const $form = document.getElementById("watch");
const $input = document.getElementById("escrow");

let escrow = "";
let lastFetchOk = 0;
let lastKey = "";
let jobs = [];

// ---------------------------------------------------------------- helpers

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const isHttp = (s) => /^https?:\/\/\S+$/i.test(String(s).trim());

function fmtAmount(units) {
  const u = BigInt(units);
  const base = 10n ** BigInt(DECIMALS);
  const whole = (u / base).toString();
  const frac = (u % base).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Same rounding as the contract: shares round down, the leftover goes to the first split. */
function splitAmounts(amount, splits) {
  const out = splits.map((s) => (amount * BigInt(s.bps)) / 10000n);
  const used = out.reduce((a, b) => a + b, 0n);
  out[0] += amount - used;
  return out;
}

const symbol = (job) => (job.token.startsWith("tusd") ? "tUSD" : job.token);
const link = (account) =>
  `<a class="mono" href="${EXPLORER}${encodeURIComponent(account)}" target="_blank" rel="noopener noreferrer">${esc(account)}</a>`;
const when = (ns) => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString();

async function view(contract, method, args = {}) {
  let last = "";
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "d",
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: contract,
            method_name: method,
            args_base64: btoa(JSON.stringify(args)),
          },
        }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.data || j.error.message || "rpc error");
      if (j.result?.error) throw new Error(j.result.error);
      return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
    } catch (e) {
      last = e.message;
    }
  }
  throw new Error(last || "could not reach testnet");
}

// ---------------------------------------------------------------- what a status means

const STATUS = {
  Created: { label: "Not funded", dot: "", vault: "idle" },
  Funded: { label: "Held in escrow", dot: "held", vault: "" },
  Submitted: { label: "Under review", dot: "wait", vault: "" },
  Rework: { label: "Sent back", dot: "fail", vault: "" },
  Rejected: { label: "Rejected", dot: "fail", vault: "" },
  Disputed: { label: "Disputed", dot: "wait", vault: "" },
  Paying: { label: "Paying out", dot: "wait", vault: "" },
  Paid: { label: "Released", dot: "paid", vault: "paid" },
  Refunding: { label: "Refunding", dot: "wait", vault: "" },
  Refunded: { label: "Returned", dot: "", vault: "idle" },
  Cancelled: { label: "Cancelled", dot: "", vault: "idle" },
};

function why(job) {
  switch (job.status) {
    case "Created": return "Waiting for the client to fund the job.";
    case "Funded": return "Held by the contract. Nobody can move it until the work is verified.";
    case "Submitted": return `Held while the verifier checks round ${job.rounds}.`;
    case "Rework": return `Held. Round ${job.rounds} of ${job.max_rounds} was sent back for rework.`;
    case "Rejected": return "Held. Every round failed, so the client can take it back.";
    case "Disputed": return "Held until the arbiter decides.";
    case "Paying": return "The contract is sending it to the people on the right.";
    case "Paid": return "Released by the contract, split as agreed.";
    case "Refunding": return "The contract is sending it back to the client.";
    case "Refunded": return "Returned to the client.";
    default: return "This job was never funded.";
  }
}

/** How each connector on the route looks for this status. */
function flows(job) {
  const s = job.status;
  const inbound = s === "Created" || s === "Cancelled" ? "" : s === "Refunded" || s === "Refunding" ? "back" : "on";
  const outbound = s === "Paying" ? "moving" : s === "Paid" ? "done" : "";
  return { inbound: s === "Refunding" ? "moving" : inbound, outbound };
}

const LOCKED = `<svg class="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="1"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
const OPEN = `<svg class="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="1"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>`;

function steps(job) {
  const s = job.status;
  const funded = !["Created", "Cancelled"].includes(s);
  const out = [];
  out.push({
    state: s === "Cancelled" ? "bad" : funded ? "done" : "now",
    title: s === "Cancelled" ? "Cancelled before funding" : "Client funds the job",
    note: funded ? "The money is held by the contract, not by anyone's wallet." : "Waiting for the client to send the stablecoin.",
  });
  const submitted = job.rounds > 0;
  out.push({
    state: s === "Funded" || s === "Rework" ? "now" : submitted ? "done" : "idle",
    title: "Freelancer submits the work",
    note:
      s === "Funded"
        ? "Waiting for the first submission."
        : s === "Rework"
          ? `Round ${job.rounds} of ${job.max_rounds} was sent back. Submit a new version.`
          : submitted
            ? `Round ${job.rounds} of ${job.max_rounds}.`
            : "",
  });
  let check = { state: "idle", title: "Verifier checks it against the brief", note: "" };
  if (s === "Submitted") check = { ...check, state: "now", note: "Checking the latest submission now." };
  else if (s === "Rework") check = { ...check, state: "bad", note: "Failed. The reasons are in the report." };
  else if (s === "Rejected") check = { ...check, state: "bad", note: "Failed the last allowed round." };
  else if (["Paying", "Paid"].includes(s)) check = { ...check, state: "done", note: "Passed." };
  else if (s === "Disputed") check = { ...check, state: "now", note: "A dispute was raised. The arbiter will decide." };
  out.push(check);
  const refund = ["Refunding", "Refunded"].includes(s);
  out.push({
    state: s === "Paid" || s === "Refunded" ? "done" : ["Paying", "Refunding", "Rejected"].includes(s) ? "now" : "idle",
    title: refund ? "Money returned to the client" : "Contract pays out the splits",
    note: s === "Rejected" ? "The client can take the money back." : s === "Paying" ? "Transfers are in flight." : "",
  });
  return out;
}

// ---------------------------------------------------------------- criteria and report

function parseCriteria(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The brief as a checklist. The mark comes from the verifier's report, never from guessing. */
function requirements(job) {
  const c = parseCriteria(job.criteria);
  const report = job.report || "";
  const verdict = job.status === "Submitted" ? null : /^PASS/.test(report) ? "pass" : /^FAIL/.test(report) ? "fail" : null;
  const mark = (fragment) => (verdict === "pass" ? "met" : verdict === "fail" ? (report.includes(fragment) ? "unmet" : "met") : "unknown");
  const out = [];
  if (c.min_words !== undefined) out.push({ text: `At least ${c.min_words} words`, m: mark(`words, need at least ${c.min_words}`) });
  if (c.max_words !== undefined) out.push({ text: `At most ${c.max_words} words`, m: mark(`words, at most ${c.max_words} allowed`) });
  if (c.min_items !== undefined) out.push({ text: `At least ${c.min_items} items`, m: mark(`items, need at least ${c.min_items}`) });
  for (const p of c.must_include || []) out.push({ text: `Mentions “${p}”`, m: mark(`must mention "${p}"`) });
  for (const p of c.must_not_include || []) out.push({ text: `Does not contain “${p}”`, m: mark(`must not contain "${p}"`) });
  for (const p of c.judge || []) out.push({ text: `Judged: ${p}`, m: "unknown" });
  return out;
}

function reasons(report) {
  const m = report.match(/^FAIL: \d+ of \d+ checks met\. (.*?)(?: Not checked:.*)?(?: sha256:[0-9a-f]+)?$/);
  if (!m) return [];
  return m[1].replace(/\.$/, "").split("; ").filter(Boolean);
}

// ---------------------------------------------------------------- rendering

function renderJob(job) {
  const st = STATUS[job.status] || { label: job.status, vault: "idle" };
  const amount = BigInt(job.amount);
  const shares = splitAmounts(amount, job.splits);
  const sym = symbol(job);
  const returned = ["Refunding", "Refunded"].includes(job.status);
  const holding = ["Funded", "Submitted", "Rework", "Rejected", "Disputed", "Paying"].includes(job.status);
  const f = flows(job);
  const unlocked = ["Paying", "Paid", "Refunding", "Refunded"].includes(job.status);
  const failFlag = job.status === "Rework" || job.status === "Rejected";

  const payees = job.splits
    .map((s, i) => {
      const role = s.account === job.freelancer ? "Freelancer" : s.account === job.client ? "Client" : "Also paid";
      const chip = returned
        ? ["none", "Goes back to the client"]
        : s.paid
          ? ["paid", "Paid"]
          : s.sending
            ? ["sending", "Sending"]
            : holding
              ? ["held", "Held in escrow"]
              : ["none", "Not funded"];
      return `<li>
        <div class="line1"><div>${link(s.account)}<div class="role">${role}, ${s.bps / 100}%</div></div>
        <div class="amt">${esc(fmtAmount(shares[i]))}<small>${esc(sym)}</small></div></div>
        <span class="state-chip ${chip[0]}">${chip[1]}</span></li>`;
    })
    .join("");

  const route = `
  <div class="route" aria-label="Where the money is">
    <div class="who-node"><h2>Client</h2>${link(job.client)}</div>
    <div class="link ${f.inbound}" aria-hidden="true"></div>
    <div class="vault ${st.vault}">
      ${unlocked ? OPEN : LOCKED}
      <p class="amount">${esc(fmtAmount(amount))}<small>${esc(sym)}</small></p>
      <p class="state" role="status">${esc(st.label)}</p>
      <p class="why">${esc(why(job))}</p>
      ${failFlag ? `<span class="flag">${job.status === "Rejected" ? "Rejected" : "Failed the check"}</span>` : ""}
    </div>
    <div class="link ${f.outbound}" aria-hidden="true"></div>
    <div class="payees"><h2>${returned ? "Back to the client" : "Pays out to"}</h2><ul>${payees}</ul></div>
  </div>`;

  const stepRows = steps(job)
    .map((s) => {
      const mark = s.state === "done" ? "✓" : s.state === "bad" ? "!" : "";
      return `<li class="${s.state}"><span class="mark" aria-hidden="true">${mark}</span>
        <div><div class="step-title">${esc(s.title)}</div>${s.note ? `<div class="step-note">${esc(s.note)}</div>` : ""}</div></li>`;
    })
    .join("");

  const sub = job.submission;
  const deliverable = sub
    ? `<p class="deliverable">${
        isHttp(sub.deliverable)
          ? `<a href="${esc(sub.deliverable.trim())}" target="_blank" rel="noopener noreferrer">${esc(sub.deliverable)}</a>`
          : esc(sub.deliverable)
      }</p><p class="meta">Round ${sub.round}, submitted ${esc(when(sub.submitted_at))}</p>`
    : `<p class="none">Nothing submitted yet.</p>`;

  const reqs = requirements(job);
  const reqHtml = reqs.length
    ? `<ul class="reqs">${reqs.map((r) => `<li class="${r.m}"><span class="tick" aria-hidden="true">${r.m === "met" ? "✓" : r.m === "unmet" ? "✗" : "–"}</span><span>${esc(r.text)}${r.m === "unmet" ? " (not met)" : ""}</span></li>`).join("")}</ul>`
    : `<p class="none">No criteria were set.</p>`;

  let reportHtml;
  if (!job.report) {
    reportHtml = `<p class="none">No verdict yet.</p>`;
  } else {
    const pass = /^PASS/.test(job.report);
    const fail = /^FAIL/.test(job.report);
    const list = fail ? reasons(job.report) : [];
    const hash = (job.report.match(/sha256:([0-9a-f]+)/) || [])[1];
    reportHtml = `
      <div class="verdict">
        ${pass ? `<span class="pill pass">PASS</span>` : fail ? `<span class="pill fail">FAIL</span>` : ""}
        <span>${job.status === "Submitted" ? "From the previous round. The new submission is being checked." : pass ? "Every check was met." : fail ? "These checks were not met:" : ""}</span>
      </div>
      ${list.length ? `<ul class="reasons">${list.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${!pass && !fail ? `<p>${esc(job.report)}</p>` : ""}
      ${hash ? `<p class="evidence">Fingerprint of the text it checked: <span class="mono">${esc(hash)}</span></p>` : ""}`;
  }

  return `
  <article aria-label="Job ${job.id}">
    ${route}
    <div class="details">
      <section><h2 class="sec">Progress</h2><ol class="steps">${stepRows}</ol>
        <div class="sec-gap"><h2 class="sec">What was delivered</h2>${deliverable}</div></section>
      <section><h2 class="sec">The brief</h2>${reqHtml}</section>
      <section><h2 class="sec">Verifier’s report</h2>${reportHtml}</section>
    </div>
    <p class="people"><span>Verifier ${link(job.verifier)}</span><span>Arbiter ${link(job.arbiter)}</span><span>Contract ${link(escrow)}</span></p>
  </article>`;
}

function selectedId() {
  const m = location.hash.match(/job=(\d+)/);
  if (m) {
    const id = Number(m[1]);
    if (jobs.some((j) => j.id === id)) return id;
  }
  return jobs[0]?.id; // newest first
}

function render() {
  const id = selectedId();
  $jobs.innerHTML = jobs
    .map((j) => {
      const st = STATUS[j.status] || { dot: "", label: j.status };
      return `<button type="button" data-id="${j.id}" ${j.id === id ? 'aria-current="true"' : ""}><span class="dot ${st.dot}"></span><span>Job #${j.id}</span><span>${esc(st.label.toLowerCase())}</span></button>`;
    })
    .join("");
  const job = jobs.find((j) => j.id === id);
  $app.innerHTML = job
    ? renderJob(job)
    : new URLSearchParams(location.search).get("since")
      ? `<div class="empty"><p>Waiting for a new job on this contract.</p></div>`
      : `<div class="empty"><p>No jobs on this contract yet.</p><p>Create one with <code>npm run demo:live</code> in the repo, or type another ProofPay escrow contract above.</p></div>`;
}

function tickLive() {
  if (!lastFetchOk) return;
  const s = Math.max(0, Math.round((Date.now() - lastFetchOk) / 1000));
  $live.className = "live";
  $live.textContent = `Live, updated ${s}s ago`;
}

async function poll() {
  if (!escrow) return;
  try {
    const all = await view(escrow, "recent_jobs", { limit: 20 });
    // ?since=N hides jobs older than id N, for a clean view of a new run.
    const since = Number(new URLSearchParams(location.search).get("since") || 0);
    jobs = all.filter((j) => j.id >= since);
    lastFetchOk = Date.now();
    const key = JSON.stringify(jobs) + location.hash;
    if (key !== lastKey) {
      lastKey = key;
      render();
    }
    tickLive();
  } catch (e) {
    $live.className = "live bad";
    $live.textContent = `Could not read ${escrow}: ${e.message}`;
  }
}

$jobs.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-id]");
  if (!b) return;
  location.hash = `job=${b.dataset.id}`;
});
window.addEventListener("hashchange", () => {
  lastKey = "";
  render();
});

function setEscrow(value) {
  escrow = value.trim();
  $input.value = escrow;
  const url = new URL(location.href);
  url.searchParams.set("escrow", escrow);
  history.replaceState(null, "", url);
  lastKey = "";
  jobs = [];
  $app.innerHTML = "";
  $live.textContent = "Loading…";
  poll();
}
$form.addEventListener("submit", (e) => {
  e.preventDefault();
  if ($input.value.trim()) setEscrow($input.value);
});

(async function start() {
  const fromUrl = new URLSearchParams(location.search).get("escrow");
  try {
    const cfg = await (await fetch("config.json")).json();
    escrow = fromUrl || cfg.escrow || "";
  } catch {
    escrow = fromUrl || "";
  }
  $input.value = escrow;
  if (escrow) poll();
  else $live.textContent = "Enter an escrow contract to start.";
  setInterval(poll, POLL_MS);
  setInterval(tickLive, 1000);
})();
