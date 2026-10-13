import Stripe from "stripe"
import { randomBytes } from "node:crypto"

/**
 * Escrow provider — Stripe Connect with a first-class mock fallback.
 *
 * Model: "separate charges and transfers".
 *   1. fund      → PaymentIntent charges the client; money sits on the
 *                  platform account (the escrow hold).
 *   2. release   → Transfer moves (amount − platform fee) to the
 *                  freelancer's connected account.
 *   3. refund    → Refund returns money to the client's card.
 *   4. split     → half refunded, half (minus fee on that half) transferred.
 *
 * Why an abstraction layer:
 *   - MOCK MODE (no STRIPE_SECRET_KEY): every operation returns a realistic
 *     `mock_*` reference, so the entire lifecycle — fund, deliver, approve,
 *     dispute, resolve — is demoable with zero external setup.
 *   - STRIPE MODE (sk_test_ key): the same calls hit real Stripe test-mode
 *     APIs. Live keys are rejected — this is a portfolio project and must
 *     never be able to move real money.
 *
 * All amounts are integer cents. The platform fee is taken on release (not
 * on funding) so refunds are always whole.
 */

export const PLATFORM_FEE_BPS = (() => {
  const raw = Number(process.env.PLATFORM_FEE_BPS)
  return Number.isFinite(raw) && raw >= 0 && raw <= 5000 ? Math.round(raw) : 1000
})()

export function feeFor(amountCents: number): number {
  return Math.round((amountCents * PLATFORM_FEE_BPS) / 10_000)
}

let stripe: Stripe | null | undefined

function getStripe(): Stripe | null {
  if (stripe !== undefined) return stripe
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  if (!key) {
    stripe = null
  } else if (!key.startsWith("sk_test_")) {
    throw new Error("Refusing to start: STRIPE_SECRET_KEY must be a TEST key (sk_test_...).")
  } else {
    stripe = new Stripe(key, { apiVersion: "2024-06-20" })
  }
  return stripe
}

export function escrowProvider(): "stripe" | "mock" {
  return getStripe() ? "stripe" : "mock"
}

const mockRef = (prefix: string) => `mock_${prefix}_${randomBytes(10).toString("hex")}`

/** Create a payout account for a freelancer (Stripe Express, or a mock id). */
export async function createPayoutAccount(email: string): Promise<string> {
  const s = getStripe()
  if (!s) return mockRef("acct")
  const account = await s.accounts.create({ type: "express", email })
  return account.id
}

/** Charge the client and hold funds on the platform (the escrow hold). */
export async function holdFunds(amountCents: number, contractId: number): Promise<string> {
  const s = getStripe()
  if (!s) return mockRef("pi")
  const pi = await s.paymentIntents.create({
    amount: amountCents,
    currency: "usd",
    payment_method: "pm_card_visa", // Stripe's canonical test card
    payment_method_types: ["card"],
    confirm: true,
    description: `Escrow hold for contract #${contractId}`,
    metadata: { contract_id: String(contractId) },
  })
  if (pi.status !== "succeeded") {
    throw new Error(`Escrow charge did not succeed (status: ${pi.status}).`)
  }
  return pi.id
}

/** Transfer cents to the freelancer's connected account. */
export async function releaseFunds(
  amountCents: number,
  payoutAccount: string,
  contractId: number,
): Promise<string> {
  const s = getStripe()
  if (!s) return mockRef("tr")
  const transfer = await s.transfers.create({
    amount: amountCents,
    currency: "usd",
    destination: payoutAccount,
    description: `Payout for contract #${contractId}`,
    metadata: { contract_id: String(contractId) },
  })
  return transfer.id
}

/** Refund cents from the escrow hold back to the client. */
export async function refundFunds(
  paymentRef: string,
  amountCents: number,
): Promise<string> {
  const s = getStripe()
  if (!s) return mockRef("re")
  const refund = await s.refunds.create({
    payment_intent: paymentRef,
    amount: amountCents,
  })
  return refund.id
}
