//! ProofPay escrow: a client funds a job in a NEP-141 stablecoin, the freelancer delivers, a
//! verifier account attests pass or fail, and the contract pays out in splits.
//!
//! Flow:
//!   1. The client calls `create_job` (terms, splits, acceptance criteria, deadline).
//!   2. The client funds it with `ft_transfer_call` to this contract, msg = "fund:<job_id>".
//!   3. The freelancer calls `submit_work`. The verifier calls `attest(passed, report)`.
//!      Pass: payout in splits. Fail: rework (up to `max_rounds` submissions), then Rejected.
//!   4. Safety valves: the client can `approve` (pay) or `refund` (after the deadline, or once
//!      Rejected); either party can `dispute`, and the arbiter settles it; if the verifier stays
//!      silent past the review window the freelancer can `claim_after_silence`.
//!
//! The verifier never holds money. It can only say pass or fail.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, PromiseOrValue};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Kept by the contract to pay for the job's storage. Not refunded.
const STORAGE_FEE: NearToken = NearToken::from_millinear(20);
const SECOND_NS: u64 = 1_000_000_000;
const BPS: u128 = 10_000;
const MAX_SPLITS: usize = 5;
const MAX_ROUNDS: u8 = 5;
const MAX_CRITERIA_LEN: usize = 2_000;
const MAX_DELIVERABLE_LEN: usize = 1_000;
const MAX_REPORT_LEN: usize = 1_000;
const MAX_REASON_LEN: usize = 500;
const TRANSFER_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[near(serializers = [json])]
#[derive(Clone)]
pub struct SplitInput {
    pub account: AccountId,
    pub bps: u16,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Split {
    pub account: AccountId,
    pub bps: u16,
    pub paid: bool,
    pub sending: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum Status {
    /// Terms recorded, not funded yet.
    Created,
    Funded,
    Submitted,
    /// The verifier failed the last submission and the freelancer may resubmit.
    Rework,
    /// The verifier failed the last allowed submission. The client may refund.
    Rejected,
    Disputed,
    /// Payout started. Stays here until every split has been transferred.
    Paying,
    Paid,
    /// Refund transfer started. Retry with `refund` if the transfer failed.
    Refunding,
    Refunded,
    Cancelled,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Submission {
    pub deliverable: String,
    pub submitted_at: U64,
    pub round: u8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Job {
    pub id: u64,
    pub client: AccountId,
    pub freelancer: AccountId,
    pub token: AccountId,
    pub amount: U128,
    pub splits: Vec<Split>,
    /// Acceptance criteria as JSON text. The verifier interprets it; the contract only stores it.
    pub criteria: String,
    pub verifier: AccountId,
    pub arbiter: AccountId,
    pub created_at: U64,
    /// Absolute deadline (ns since epoch) for submissions.
    pub deadline: U64,
    pub review_window_secs: u64,
    /// Maximum number of submissions the freelancer may make.
    pub max_rounds: u8,
    pub rounds: u8,
    pub status: Status,
    pub submission: Option<Submission>,
    pub report: Option<String>,
    pub dispute_reason: Option<String>,
    pub refund_sending: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    jobs: IterableMap<u64, Job>,
    next_job_id: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self { jobs: IterableMap::new(b"j".to_vec()), next_job_id: 0 }
    }

    // ----------------------------------------------------------------- client

    /// Record the terms of a job. The caller is the client. Attach at least 0.02 NEAR, which
    /// pays for storage and is not refunded. `deadline_secs` is relative to now.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_job(
        &mut self,
        freelancer: AccountId,
        token: AccountId,
        amount: U128,
        splits: Vec<SplitInput>,
        criteria: String,
        verifier: AccountId,
        arbiter: AccountId,
        deadline_secs: u64,
        review_window_secs: u64,
        max_rounds: u8,
    ) -> u64 {
        let client = env::predecessor_account_id();
        require!(env::attached_deposit() >= STORAGE_FEE, "attach at least 0.02 NEAR for storage");
        require!(client != freelancer, "client and freelancer must be different accounts");
        require!(verifier != freelancer && arbiter != freelancer, "the freelancer cannot verify or arbitrate");
        require!(amount.0 > 0, "amount must be greater than zero");
        require!(criteria.len() <= MAX_CRITERIA_LEN, "criteria too long");
        require!(deadline_secs > 0, "deadline must be in the future");
        require!(review_window_secs > 0, "review window must be greater than zero");
        require!((1..=MAX_ROUNDS).contains(&max_rounds), "max_rounds must be between 1 and 5");
        require!(!splits.is_empty() && splits.len() <= MAX_SPLITS, "between 1 and 5 splits are required");
        let total: u128 = splits.iter().map(|s| s.bps as u128).sum();
        require!(total == BPS, "split basis points must add up to 10000");
        require!(splits.iter().all(|s| s.bps > 0), "every split needs a positive share");

        let splits: Vec<Split> = splits
            .into_iter()
            .map(|s| Split { account: s.account, bps: s.bps, paid: false, sending: false })
            .collect();
        let shares = split_amounts(amount.0, &splits);
        require!(shares.iter().all(|a| *a > 0), "amount is too small for these splits");

        let id = self.next_job_id;
        self.next_job_id += 1;
        let now = env::block_timestamp();
        self.jobs.insert(
            id,
            Job {
                id,
                client: client.clone(),
                freelancer: freelancer.clone(),
                token: token.clone(),
                amount,
                splits,
                criteria,
                verifier,
                arbiter,
                created_at: U64(now),
                deadline: U64(now + deadline_secs * SECOND_NS),
                review_window_secs,
                max_rounds,
                rounds: 0,
                status: Status::Created,
                submission: None,
                report: None,
                dispute_reason: None,
                refund_sending: false,
            },
        );
        log_event(
            "job_created",
            json!({ "job": id, "client": client, "freelancer": freelancer, "token": token, "amount": amount }),
        );
        id
    }

    /// Cancel a job that was never funded.
    pub fn cancel_job(&mut self, job_id: u64) {
        let job = self.job_mut(job_id);
        require!(env::predecessor_account_id() == job.client, "only the client can cancel");
        require!(job.status == Status::Created, "only an unfunded job can be cancelled");
        job.status = Status::Cancelled;
        log_event("job_cancelled", json!({ "job": job_id }));
    }

    /// Accept the work and pay out, even if the verifier failed it.
    pub fn approve(&mut self, job_id: u64) {
        let job = self.job_mut(job_id);
        require!(env::predecessor_account_id() == job.client, "only the client can approve");
        require!(
            matches!(job.status, Status::Submitted | Status::Rework | Status::Rejected),
            "nothing to approve in this state"
        );
        log_event("approved", json!({ "job": job_id }));
        self.start_payout(job_id);
    }

    /// Take the money back: after the deadline if no work was accepted, or once the job was
    /// rejected. Also retries a refund whose transfer failed.
    pub fn refund(&mut self, job_id: u64) {
        let now = env::block_timestamp();
        let job = self.job_mut(job_id);
        require!(env::predecessor_account_id() == job.client, "only the client can refund");
        let allowed = match job.status {
            Status::Rejected => true,
            Status::Funded | Status::Rework => now > job.deadline.0,
            Status::Refunding => !job.refund_sending,
            _ => false,
        };
        require!(allowed, "refund is not available yet");
        self.start_refund(job_id);
    }

    // ------------------------------------------------------------- freelancer

    pub fn submit_work(&mut self, job_id: u64, deliverable: String) {
        let now = env::block_timestamp();
        let job = self.job_mut(job_id);
        require!(env::predecessor_account_id() == job.freelancer, "only the freelancer can submit");
        require!(matches!(job.status, Status::Funded | Status::Rework), "job is not open for submissions");
        require!(now <= job.deadline.0, "the deadline has passed");
        require!(
            !deliverable.is_empty() && deliverable.len() <= MAX_DELIVERABLE_LEN,
            "deliverable must be 1 to 1000 characters"
        );
        job.rounds += 1;
        job.status = Status::Submitted;
        job.submission = Some(Submission {
            deliverable,
            submitted_at: U64(now),
            round: job.rounds,
        });
        log_event("work_submitted", json!({ "job": job_id, "round": job.rounds }));
    }

    /// If the verifier has not answered within the review window, the freelancer can claim.
    pub fn claim_after_silence(&mut self, job_id: u64) {
        let now = env::block_timestamp();
        let job = self.job_mut(job_id);
        require!(env::predecessor_account_id() == job.freelancer, "only the freelancer can claim");
        require!(job.status == Status::Submitted, "no submission is waiting for review");
        let at = job.submission.as_ref().map(|s| s.submitted_at.0).unwrap_or(now);
        require!(now >= at + job.review_window_secs * SECOND_NS, "the review window is still open");
        log_event("claimed_after_silence", json!({ "job": job_id }));
        self.start_payout(job_id);
    }

    // --------------------------------------------------------------- verifier

    /// The verifier's ruling on the latest submission.
    pub fn attest(&mut self, job_id: u64, passed: bool, report: String) {
        require!(report.len() <= MAX_REPORT_LEN, "report too long");
        let job = self.job_mut(job_id);
        require!(env::predecessor_account_id() == job.verifier, "only the verifier can attest");
        require!(job.status == Status::Submitted, "no submission is waiting for review");
        job.report = Some(report);
        if passed {
            log_event("attested", json!({ "job": job_id, "passed": true, "round": job.rounds }));
            self.start_payout(job_id);
        } else {
            job.status = if job.rounds >= job.max_rounds { Status::Rejected } else { Status::Rework };
            log_event(
                "attested",
                json!({ "job": job_id, "passed": false, "round": job.rounds, "status": job.status }),
            );
        }
    }

    // ---------------------------------------------------------------- disputes

    /// Either party can escalate to the arbiter while the outcome is open.
    pub fn dispute(&mut self, job_id: u64, reason: String) {
        require!(reason.len() <= MAX_REASON_LEN, "reason too long");
        let job = self.job_mut(job_id);
        let who = env::predecessor_account_id();
        require!(who == job.client || who == job.freelancer, "only the client or the freelancer can dispute");
        require!(
            matches!(job.status, Status::Submitted | Status::Rework | Status::Rejected),
            "this job cannot be disputed now"
        );
        job.status = Status::Disputed;
        job.dispute_reason = Some(reason);
        log_event("disputed", json!({ "job": job_id, "by": who }));
    }

    /// The arbiter decides who gets the money.
    pub fn resolve_dispute(&mut self, job_id: u64, pay_freelancer: bool) {
        let job = self.job_mut(job_id);
        require!(env::predecessor_account_id() == job.arbiter, "only the arbiter can resolve");
        require!(job.status == Status::Disputed, "job is not disputed");
        log_event("dispute_resolved", json!({ "job": job_id, "pay_freelancer": pay_freelancer }));
        if pay_freelancer {
            self.start_payout(job_id);
        } else {
            self.start_refund(job_id);
        }
    }

    // ------------------------------------------------------------- maintenance

    /// Retry the splits whose transfer failed (for example a recipient that was not registered
    /// with the token yet). Safe for anyone to call: money only goes to the agreed accounts.
    pub fn retry_payout(&mut self, job_id: u64) {
        let job = self.job_mut(job_id);
        require!(job.status == Status::Paying, "no payout is in progress");
        require!(!job.splits.iter().any(|s| s.sending), "a transfer is still in flight");
        self.start_payout(job_id);
    }

    // ------------------------------------------------------------------ views

    pub fn get_job(&self, job_id: u64) -> Option<Job> {
        self.jobs.get(&job_id).cloned()
    }

    /// Newest first.
    pub fn recent_jobs(&self, limit: u64) -> Vec<Job> {
        (0..self.next_job_id)
            .rev()
            .take(limit.min(50) as usize)
            .filter_map(|id| self.jobs.get(&id).cloned())
            .collect()
    }

    pub fn get_split_amounts(&self, job_id: u64) -> Vec<U128> {
        let job = self.jobs.get(&job_id).expect("job not found");
        split_amounts(job.amount.0, &job.splits).into_iter().map(U128).collect()
    }

    pub fn job_count(&self) -> u64 {
        self.next_job_id
    }

    // -------------------------------------------------------------- callbacks

    #[private]
    pub fn on_split_paid(&mut self, job_id: u64, index: u64) {
        let ok = transfer_succeeded();
        let job = self.job_mut(job_id);
        let split = &mut job.splits[index as usize];
        split.sending = false;
        if ok {
            split.paid = true;
        }
        log_event(
            "split_transfer",
            json!({ "job": job_id, "account": split.account, "ok": ok }),
        );
        if job.splits.iter().all(|s| s.paid) {
            job.status = Status::Paid;
            log_event("paid", json!({ "job": job_id }));
        }
    }

    #[private]
    pub fn on_refund(&mut self, job_id: u64) {
        let ok = transfer_succeeded();
        let job = self.job_mut(job_id);
        job.refund_sending = false;
        if ok {
            job.status = Status::Refunded;
            log_event("refunded", json!({ "job": job_id }));
        } else {
            log_event("refund_failed", json!({ "job": job_id }));
        }
    }
}

// Funding: the client sends the stablecoin with `ft_transfer_call(msg = "fund:<job_id>")`.
#[near]
impl FungibleTokenReceiver for Contract {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let id: u64 = msg
            .strip_prefix("fund:")
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| env::panic_str("msg must be fund:<job_id>"));
        let job = self.job_mut(id);
        // A panic here makes the token refund the whole transfer to the sender.
        require!(sender_id == job.client, "only the client can fund this job");
        require!(token == job.token, "wrong token for this job");
        require!(job.status == Status::Created, "job is already funded or closed");
        require!(amount.0 >= job.amount.0, "amount is less than the job amount");
        job.status = Status::Funded;
        let excess = amount.0 - job.amount.0;
        log_event("funded", json!({ "job": id, "amount": job.amount, "excess_returned": U128(excess) }));
        PromiseOrValue::Value(U128(excess))
    }
}

impl Contract {
    fn job_mut(&mut self, id: u64) -> &mut Job {
        self.jobs.get_mut(&id).unwrap_or_else(|| env::panic_str("job not found"))
    }

    /// Transfer every split that has not been paid and is not already in flight.
    fn start_payout(&mut self, id: u64) {
        let job = self.job_mut(id);
        job.status = Status::Paying;
        let amounts = split_amounts(job.amount.0, &job.splits);
        let token = job.token.clone();
        let mut sends = Vec::new();
        for (i, s) in job.splits.iter_mut().enumerate() {
            if !s.paid && !s.sending {
                s.sending = true;
                sends.push((i as u64, s.account.clone(), amounts[i]));
            }
        }
        for (i, account, amount) in sends {
            let _ = ext_ft_core::ext(token.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(TRANSFER_GAS)
                .ft_transfer(account, U128(amount), None)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_split_paid(id, i),
                );
        }
    }

    fn start_refund(&mut self, id: u64) {
        let job = self.job_mut(id);
        job.status = Status::Refunding;
        job.refund_sending = true;
        let (token, client, amount) = (job.token.clone(), job.client.clone(), job.amount);
        let _ = ext_ft_core::ext(token)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(TRANSFER_GAS)
            .ft_transfer(client, amount, None)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_refund(id));
    }
}

/// Each split gets `amount * bps / 10000`, rounded down. The leftover goes to the first split.
pub fn split_amounts(amount: u128, splits: &[Split]) -> Vec<u128> {
    let mut out: Vec<u128> = splits.iter().map(|s| amount * s.bps as u128 / BPS).collect();
    let used: u128 = out.iter().sum();
    out[0] += amount - used;
    out
}

fn transfer_succeeded() -> bool {
    require!(env::promise_results_count() == 1, "expected one promise result");
    // ft_transfer returns nothing, so a tiny cap is plenty.
    env::promise_result_checked(0, 16).is_ok()
}

fn log_event(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "proofpay", "version": "1.0.0", "event": event, "data": data })
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

    const DEADLINE_SECS: u64 = 3_600;
    const REVIEW_SECS: u64 = 60;
    const JOB_AMOUNT: u128 = 100_000_000; // 100 tUSD with 6 decimals

    fn contract_id() -> AccountId { accounts(0) }
    fn client() -> AccountId { accounts(1) }
    fn freelancer() -> AccountId { accounts(2) }
    fn verifier() -> AccountId { accounts(3) }
    fn arbiter() -> AccountId { "arbiter.near".parse().unwrap() }
    fn editor() -> AccountId { "editor.near".parse().unwrap() }
    fn token() -> AccountId { "tusd.near".parse().unwrap() }

    fn ctx(who: AccountId, deposit: NearToken, ts: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(contract_id())
            .predecessor_account_id(who)
            .attached_deposit(deposit)
            .block_timestamp(ts);
        b
    }

    fn split_inputs() -> Vec<SplitInput> {
        vec![
            SplitInput { account: freelancer(), bps: 8_000 },
            SplitInput { account: editor(), bps: 2_000 },
        ]
    }

    fn create(c: &mut Contract, max_rounds: u8) -> u64 {
        testing_env!(ctx(client(), STORAGE_FEE, 0).build());
        c.create_job(
            freelancer(), token(), U128(JOB_AMOUNT), split_inputs(),
            r#"{"min_words":50}"#.into(), verifier(), arbiter(),
            DEADLINE_SECS, REVIEW_SECS, max_rounds,
        )
    }

    fn fund(c: &mut Contract, id: u64) {
        testing_env!(ctx(token(), NearToken::from_yoctonear(0), 1).build());
        let _ = c.ft_on_transfer(client(), U128(JOB_AMOUNT), format!("fund:{id}"));
    }

    fn setup(max_rounds: u8) -> (Contract, u64) {
        testing_env!(ctx(client(), NearToken::from_yoctonear(0), 0).build());
        let mut c = Contract::new();
        let id = create(&mut c, max_rounds);
        fund(&mut c, id);
        (c, id)
    }

    fn submit(c: &mut Contract, id: u64, ts: u64) {
        testing_env!(ctx(freelancer(), NearToken::from_yoctonear(0), ts).build());
        c.submit_work(id, "my draft".into());
    }

    fn attest(c: &mut Contract, id: u64, passed: bool, ts: u64) {
        testing_env!(ctx(verifier(), NearToken::from_yoctonear(0), ts).build());
        c.attest(id, passed, "report".into());
    }

    /// Run a callback as the contract itself, with a successful or failed promise result.
    fn with_promise_result(ok: bool, ts: u64) {
        let r = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
        testing_env!(
            ctx(contract_id(), NearToken::from_yoctonear(0), ts).build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![r]
        );
    }

    #[test]
    fn creates_and_funds_a_job() {
        let (c, id) = setup(3);
        let j = c.get_job(id).unwrap();
        assert_eq!(j.status, Status::Funded);
        assert_eq!(j.amount.0, JOB_AMOUNT);
        assert_eq!(j.splits.len(), 2);
        assert_eq!(j.deadline.0, DEADLINE_SECS * SECOND_NS);
    }

    #[test]
    #[should_panic(expected = "split basis points must add up to 10000")]
    fn rejects_splits_that_do_not_add_up() {
        let mut c = Contract::new();
        testing_env!(ctx(client(), STORAGE_FEE, 0).build());
        c.create_job(
            freelancer(), token(), U128(JOB_AMOUNT),
            vec![SplitInput { account: freelancer(), bps: 9_000 }],
            "{}".into(), verifier(), arbiter(), 60, 60, 3,
        );
    }

    #[test]
    #[should_panic(expected = "attach at least 0.02 NEAR")]
    fn requires_the_storage_fee() {
        let mut c = Contract::new();
        testing_env!(ctx(client(), NearToken::from_yoctonear(0), 0).build());
        c.create_job(
            freelancer(), token(), U128(JOB_AMOUNT), split_inputs(),
            "{}".into(), verifier(), arbiter(), 60, 60, 3,
        );
    }

    #[test]
    fn splits_round_down_and_the_first_gets_the_rest() {
        let splits: Vec<Split> = split_inputs()
            .into_iter()
            .map(|s| Split { account: s.account, bps: s.bps, paid: false, sending: false })
            .collect();
        assert_eq!(split_amounts(100, &splits), vec![80, 20]);
        assert_eq!(split_amounts(101, &splits), vec![81, 20]); // 80.8 and 20.2 round down, 1 left over
        assert_eq!(split_amounts(JOB_AMOUNT, &splits), vec![80_000_000, 20_000_000]);
    }

    #[test]
    fn excess_funding_is_returned() {
        let mut c = Contract::new();
        let id = create(&mut c, 3);
        testing_env!(ctx(token(), NearToken::from_yoctonear(0), 1).build());
        match c.ft_on_transfer(client(), U128(JOB_AMOUNT + 5), format!("fund:{id}")) {
            PromiseOrValue::Value(v) => assert_eq!(v.0, 5),
            _ => panic!("expected a value"),
        }
    }

    #[test]
    #[should_panic(expected = "amount is less than the job amount")]
    fn underfunding_is_refused() {
        let mut c = Contract::new();
        let id = create(&mut c, 3);
        testing_env!(ctx(token(), NearToken::from_yoctonear(0), 1).build());
        let _ = c.ft_on_transfer(client(), U128(JOB_AMOUNT - 1), format!("fund:{id}"));
    }

    #[test]
    #[should_panic(expected = "wrong token for this job")]
    fn the_wrong_token_is_refused() {
        let mut c = Contract::new();
        let id = create(&mut c, 3);
        testing_env!(ctx("other.near".parse().unwrap(), NearToken::from_yoctonear(0), 1).build());
        let _ = c.ft_on_transfer(client(), U128(JOB_AMOUNT), format!("fund:{id}"));
    }

    #[test]
    #[should_panic(expected = "only the client can fund this job")]
    fn only_the_client_can_fund() {
        let mut c = Contract::new();
        let id = create(&mut c, 3);
        testing_env!(ctx(token(), NearToken::from_yoctonear(0), 1).build());
        let _ = c.ft_on_transfer(freelancer(), U128(JOB_AMOUNT), format!("fund:{id}"));
    }

    #[test]
    #[should_panic(expected = "job is not open for submissions")]
    fn cannot_submit_before_funding() {
        let mut c = Contract::new();
        let id = create(&mut c, 3);
        submit(&mut c, id, 2);
    }

    #[test]
    #[should_panic(expected = "the deadline has passed")]
    fn cannot_submit_after_the_deadline() {
        let (mut c, id) = setup(3);
        submit(&mut c, id, DEADLINE_SECS * SECOND_NS + 1);
    }

    #[test]
    fn a_failed_check_allows_rework_until_the_rounds_run_out() {
        let (mut c, id) = setup(2);
        submit(&mut c, id, 2);
        attest(&mut c, id, false, 3);
        assert_eq!(c.get_job(id).unwrap().status, Status::Rework);
        submit(&mut c, id, 4);
        attest(&mut c, id, false, 5);
        let j = c.get_job(id).unwrap();
        assert_eq!(j.status, Status::Rejected);
        assert_eq!(j.rounds, 2);
        assert_eq!(j.report.as_deref(), Some("report"));
    }

    #[test]
    #[should_panic(expected = "only the verifier can attest")]
    fn only_the_verifier_can_attest() {
        let (mut c, id) = setup(3);
        submit(&mut c, id, 2);
        testing_env!(ctx(freelancer(), NearToken::from_yoctonear(0), 3).build());
        c.attest(id, true, "i pass myself".into());
    }

    #[test]
    fn a_pass_starts_the_payout_and_callbacks_finish_it() {
        let (mut c, id) = setup(3);
        submit(&mut c, id, 2);
        attest(&mut c, id, true, 3);
        let j = c.get_job(id).unwrap();
        assert_eq!(j.status, Status::Paying);
        assert!(j.splits.iter().all(|s| s.sending && !s.paid));

        with_promise_result(true, 4);
        c.on_split_paid(id, 0);
        assert_eq!(c.get_job(id).unwrap().status, Status::Paying);
        with_promise_result(true, 4);
        c.on_split_paid(id, 1);
        assert_eq!(c.get_job(id).unwrap().status, Status::Paid);
    }

    #[test]
    fn a_failed_transfer_can_be_retried_but_not_while_in_flight() {
        let (mut c, id) = setup(3);
        submit(&mut c, id, 2);
        attest(&mut c, id, true, 3);
        with_promise_result(true, 4);
        c.on_split_paid(id, 0);
        with_promise_result(false, 4); // the editor is not registered with the token
        c.on_split_paid(id, 1);
        let j = c.get_job(id).unwrap();
        assert_eq!(j.status, Status::Paying);
        assert!(j.splits[0].paid && !j.splits[1].paid && !j.splits[1].sending);

        testing_env!(ctx(editor(), NearToken::from_yoctonear(0), 5).build());
        c.retry_payout(id);
        assert!(c.get_job(id).unwrap().splits[1].sending);
        with_promise_result(true, 6);
        c.on_split_paid(id, 1);
        assert_eq!(c.get_job(id).unwrap().status, Status::Paid);
    }

    #[test]
    #[should_panic(expected = "a transfer is still in flight")]
    fn retry_is_refused_while_a_transfer_is_in_flight() {
        let (mut c, id) = setup(3);
        submit(&mut c, id, 2);
        attest(&mut c, id, true, 3);
        testing_env!(ctx(editor(), NearToken::from_yoctonear(0), 4).build());
        c.retry_payout(id);
    }

    #[test]
    fn the_client_can_approve_even_after_a_failed_check() {
        let (mut c, id) = setup(3);
        submit(&mut c, id, 2);
        attest(&mut c, id, false, 3);
        testing_env!(ctx(client(), NearToken::from_yoctonear(0), 4).build());
        c.approve(id);
        assert_eq!(c.get_job(id).unwrap().status, Status::Paying);
    }

    #[test]
    #[should_panic(expected = "the review window is still open")]
    fn silence_cannot_be_claimed_too_early() {
        let (mut c, id) = setup(3);
        submit(&mut c, id, 2);
        testing_env!(ctx(freelancer(), NearToken::from_yoctonear(0), 3).build());
        c.claim_after_silence(id);
    }

    #[test]
    fn silence_can_be_claimed_after_the_review_window() {
        let (mut c, id) = setup(3);
        submit(&mut c, id, 2);
        testing_env!(ctx(freelancer(), NearToken::from_yoctonear(0), 2 + REVIEW_SECS * SECOND_NS).build());
        c.claim_after_silence(id);
        assert_eq!(c.get_job(id).unwrap().status, Status::Paying);
    }

    #[test]
    fn the_arbiter_settles_a_dispute_in_either_direction() {
        let (mut c, id) = setup(3);
        submit(&mut c, id, 2);
        attest(&mut c, id, false, 3);
        testing_env!(ctx(freelancer(), NearToken::from_yoctonear(0), 4).build());
        c.dispute(id, "the report is wrong".into());
        let j = c.get_job(id).unwrap();
        assert_eq!(j.status, Status::Disputed);
        assert_eq!(j.dispute_reason.as_deref(), Some("the report is wrong"));
        testing_env!(ctx(arbiter(), NearToken::from_yoctonear(0), 5).build());
        c.resolve_dispute(id, true);
        assert_eq!(c.get_job(id).unwrap().status, Status::Paying);

        let (mut c2, id2) = setup(3);
        submit(&mut c2, id2, 2);
        testing_env!(ctx(client(), NearToken::from_yoctonear(0), 3).build());
        c2.dispute(id2, "not what we agreed".into());
        testing_env!(ctx(arbiter(), NearToken::from_yoctonear(0), 4).build());
        c2.resolve_dispute(id2, false);
        assert_eq!(c2.get_job(id2).unwrap().status, Status::Refunding);
    }

    #[test]
    #[should_panic(expected = "only the arbiter can resolve")]
    fn only_the_arbiter_can_resolve() {
        let (mut c, id) = setup(3);
        submit(&mut c, id, 2);
        testing_env!(ctx(client(), NearToken::from_yoctonear(0), 3).build());
        c.dispute(id, "x".into());
        c.resolve_dispute(id, false);
    }

    #[test]
    #[should_panic(expected = "refund is not available yet")]
    fn no_refund_while_the_job_is_still_open() {
        let (mut c, id) = setup(3);
        testing_env!(ctx(client(), NearToken::from_yoctonear(0), 10).build());
        c.refund(id);
    }

    #[test]
    fn refund_after_the_deadline_and_retry_after_a_failed_transfer() {
        let (mut c, id) = setup(3);
        testing_env!(ctx(client(), NearToken::from_yoctonear(0), DEADLINE_SECS * SECOND_NS + 1).build());
        c.refund(id);
        assert_eq!(c.get_job(id).unwrap().status, Status::Refunding);

        with_promise_result(false, DEADLINE_SECS * SECOND_NS + 2);
        c.on_refund(id);
        let j = c.get_job(id).unwrap();
        assert_eq!(j.status, Status::Refunding);
        assert!(!j.refund_sending);

        testing_env!(ctx(client(), NearToken::from_yoctonear(0), DEADLINE_SECS * SECOND_NS + 3).build());
        c.refund(id);
        with_promise_result(true, DEADLINE_SECS * SECOND_NS + 4);
        c.on_refund(id);
        assert_eq!(c.get_job(id).unwrap().status, Status::Refunded);
    }

    #[test]
    fn a_rejected_job_can_be_refunded_at_once() {
        let (mut c, id) = setup(1);
        submit(&mut c, id, 2);
        attest(&mut c, id, false, 3);
        assert_eq!(c.get_job(id).unwrap().status, Status::Rejected);
        testing_env!(ctx(client(), NearToken::from_yoctonear(0), 4).build());
        c.refund(id);
        assert_eq!(c.get_job(id).unwrap().status, Status::Refunding);
    }

    #[test]
    fn only_an_unfunded_job_can_be_cancelled() {
        let mut c = Contract::new();
        let id = create(&mut c, 3);
        testing_env!(ctx(client(), NearToken::from_yoctonear(0), 1).build());
        c.cancel_job(id);
        assert_eq!(c.get_job(id).unwrap().status, Status::Cancelled);
    }

    #[test]
    #[should_panic(expected = "only an unfunded job can be cancelled")]
    fn a_funded_job_cannot_be_cancelled() {
        let (mut c, id) = setup(3);
        testing_env!(ctx(client(), NearToken::from_yoctonear(0), 3).build());
        c.cancel_job(id);
    }

    #[test]
    fn recent_jobs_come_newest_first() {
        let mut c = Contract::new();
        create(&mut c, 3);
        create(&mut c, 3);
        let ids: Vec<u64> = c.recent_jobs(10).iter().map(|j| j.id).collect();
        assert_eq!(ids, vec![1, 0]);
        assert_eq!(c.job_count(), 2);
    }
}
