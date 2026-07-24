# Job & Freelance Marketplace (“GigLance”)

A two-sided marketplace with **escrow payments (Stripe Connect)**, a strict **contract state machine**, **dispute resolution** with an admin desk, and **two-sided reviews** that only unlock after money settles.

Built with **Next.js 14 (App Router)**, **TypeScript**, and **Postgres**. Runs fully in **mock escrow mode** with zero Stripe setup — or against real **Stripe test-mode** APIs by adding one env var.

---

## Quick start

```bash
npm install
cp .env.example .env.local   # set DATABASE_URL (Neon/Supabase free tier)
npm run setup                # tables + a living marketplace in every lifecycle state
npm run dev                  # http://localhost:3000
```

Sign in as the accounts printed by setup (`sara@`, `omar@`, `nadia@`, `jake@`, `priya@`, `admin@giglance.test`). A guided demo is in `samples/walkthrough.md`.

---

## The escrow lifecycle

```
pending_funding ─fund→ funded ─deliver→ delivered ─approve→ completed
     │                    │                │
     │cancel              └────dispute────┘
     ▼                            ▼
 cancelled                    disputed ─admin resolves→ completed | refunded | split
```

| Step | Who | Money movement |
|---|---|---|
| Accept proposal | client | none — contract created at the **bid** amount, not the posted budget |
| Fund | client | PaymentIntent charges the client; funds held on the platform (escrow) |
| Deliver | freelancer | none — requires funded escrow (never work before the money is held) |
| Approve | client | Transfer of **amount − 10% fee** to the freelancer's connected account |
| Dispute | either party | frozen until an admin resolves |
| Resolve: release | admin | freelancer gets amount − fee |
| Resolve: refund | admin | client gets 100% back — **the platform waives its fee on refunds** |
| Resolve: split | admin | client refunded half; freelancer paid the other half minus fee on that half (odd cent → client) |

## Stripe Connect design (`lib/escrow.ts`)

- **Model: separate charges and transfers.** The client's PaymentIntent settles to the platform account (the hold); payouts are explicit `Transfer`s to the freelancer's Express account. That separation is exactly what makes refunds, splits, and delayed release possible — destination charges can't do this cleanly.
- **Mock mode is a feature, not a fallback.** With no `STRIPE_SECRET_KEY`, every operation returns realistic `mock_*` references and the full lifecycle works end to end — recruiters can run the demo with zero setup. The abstraction boundary (`holdFunds` / `releaseFunds` / `refundFunds` / `createPayoutAccount`) is the same four calls in both modes.
- **Live keys are rejected on startup.** Only `sk_test_` keys are accepted — a portfolio project must be physically unable to move real money.
- **Fee timing:** the 10% platform fee (`PLATFORM_FEE_BPS`) is taken on **release**, not on funding — so a refund is always the full amount, with no fee crumbs to claw back.

## Edge cases handled

| Case | Behavior |
|---|---|
| Funding twice (double-click or race) | Charge is guarded by an optimistic `WHERE status = 'pending_funding'` update → 409 |
| Accepting two proposals for one job | `SELECT … FOR UPDATE` on the job row inside a transaction → second accept gets 409 |
| Deliver before escrow is funded | 409 — “never deliver before the money is held” |
| Approve before delivery | 409 |
| Dispute on an unfunded or closed contract | 409 — disputes only exist where money is frozen |
| Review before the contract settles | 409 — prevents “approve or I 1-star you” leverage |
| Reviewing twice | `UNIQUE(contract_id, reviewer_id)` → 409 |
| Duplicate bid on a job | `UNIQUE(job_id, freelancer_id)` → 409 |
| Bid 3× over budget | 400 typo guard |
| Cancel after funding | Blocked — funded money only moves via approve or dispute resolution |
| Split with odd cents | `floor` for freelancer half; the extra cent goes to the client's refund |
| Fee rounding | `Math.round(amount × bps / 10000)` — integer cents everywhere, no floats |

## Data model

`users(role, payout_account)` · `sessions` · `jobs(status)` · `proposals(UNIQUE(job_id, freelancer_id))` · `contracts(status CHECK, payment/payout/refund refs)` · `disputes(UNIQUE contract_id)` · `reviews(UNIQUE(contract_id, reviewer_id))`

## Interview talking points

- Why separate charges + transfers instead of destination charges (delayed release, splits, refund-before-payout).
- Optimistic concurrency (`UPDATE … WHERE status = expected`) vs row locks (`FOR UPDATE` on accept) — and why each spot uses the one it does.
- Money movement happens **before** the status flip; a concurrent-change 409 after a real charge is surfaced loudly as a reconciliation case rather than swallowed.
- Review gating as marketplace-integrity design, not just validation.

## Deployment (Vercel + Neon)

1. Free Postgres at [neon.tech](https://neon.tech) → set `DATABASE_URL`.
2. `npm run setup` against the database.
3. Push to GitHub → import in Vercel → set env vars → deploy.
4. Optional: add a `sk_test_` Stripe key to exercise real test-mode PaymentIntents/Transfers/Refunds.

## Limitations / roadmap

- No Stripe webhooks — mock mode doesn't need them; production would confirm PaymentIntents/Transfers asynchronously and reconcile.
- Freelancer onboarding skips Stripe's hosted KYC flow (Express account links); the account id plumbing is in place.
- No messaging between parties — disputes carry the context in this demo.
- Milestone-based contracts (partial escrow releases) are the natural next feature on this schema.
