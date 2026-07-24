# 5-minute walkthrough (after `npm run setup`)

All seeded accounts share the password printed by setup. The seed leaves the marketplace mid-story — every escrow state is one click from moving.

## 1. Fund escrow — `sara@giglance.test` (client)

1. **Contracts tab** → the brand-kit contract with Priya sits in `pending_funding`.
2. Click **Fund escrow $320.00** → status flips to `funded` and you get an escrow reference (`mock_pi_*`, or a real test-mode PaymentIntent if you set a Stripe key). Click it twice if you like — the second attempt is a 409: escrow funds exactly once.
3. Note the completed landing-page contract below it: refs for both the escrow hold and the payout, plus ⭐ reviews both ways.

## 2. Deliver — `jake@giglance.test` (freelancer)

1. **Contracts tab** → the $1,100 Shopify migration is `funded` — the money is already held, which is the whole point: Jake works knowing he can't be ghosted.
2. Type a deliverable note and click **Deliver** → status `delivered`, waiting on Omar.
3. Try the same on Priya's contract as her (`priya@giglance.test`) — you can't: it's not funded, and the API says so.

## 3. Approve & pay out — `omar@giglance.test` (client)

1. **Contracts tab** → Jake's migration is `delivered`. Click **Approve → release $990.00** — that's $1,100 minus the 10% platform fee, transferred to Jake's payout account.
2. Now both parties can leave reviews — and only now. Before settlement the review form simply doesn't exist (try via curl: 409).
3. Omar also has an **open dispute** with Nadia over the reconcile script — note he *cannot* resolve it himself. Neither can she.

## 4. The dispute desk — `admin@giglance.test`

1. **Disputes tab** → one open case: $240 frozen, Omar's complaint and Nadia's deliverable note side by side.
2. Three buttons, three money paths:
   - **Release** → Nadia gets $216 (fee applies — work was delivered)
   - **Refund** → Omar gets $240 back in full (platform waives its fee)
   - **Split 50/50** → Omar refunded $120; Nadia paid $120 − $12 fee = $108
3. Pick **Split** with a note — the contract closes as `split`, both refs recorded, and reviews unlock for both parties.

## 5. The open market — any freelancer

1. **Jobs tab** as `nadia@giglance.test` → two open jobs; she already bid on the SEO articles (badge shows `pending`). Bidding again → 409.
2. As `sara@giglance.test`, open the SEO job's proposals: competing bids with each freelancer's ⭐ average — accept one and the other is auto-rejected, job locks, and a new contract starts the cycle again.
