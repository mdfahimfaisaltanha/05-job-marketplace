import { requireRole } from "@/lib/auth"
import { getPool } from "@/lib/db"
import { escrowProvider, holdFunds, refundFunds, releaseFunds } from "@/lib/escrow"

export const runtime = "nodejs"

/**
 * GET: my contracts (clients and freelancers see their own; admins see all),
 *      with dispute info and whether I already left a review.
 * PATCH { id, action, note? }: drive the state machine.
 *
 *   action   | who        | valid from        | effect
 *   ---------|------------|-------------------|---------------------------------
 *   fund     | client     | pending_funding   | escrow hold (PaymentIntent)
 *   cancel   | client     | pending_funding   | cancelled, job reopens
 *   deliver  | freelancer | funded            | delivered + deliverable note
 *   approve  | client     | delivered         | payout = amount − fee → completed
 *   dispute  | either     | funded, delivered | disputed + dispute row (reason)
 *
 * Guards are enforced from CURRENT status in SQL (optimistic — the UPDATE
 * includes the expected status in its WHERE clause), so double-funding or
 * double-approving returns 409 even under concurrent requests.
 */

const TERMINAL = ["completed", "refunded", "split", "cancelled"]

export async function GET() {
  const auth = await requireRole("client", "freelancer", "admin")
  if (auth instanceof Response) return auth

  const mine = auth.role === "admin" ? "" : `WHERE c.client_id = $1 OR c.freelancer_id = $1`
  const res = await getPool().query(
    `SELECT c.id, c.job_id, j.title AS job_title, c.client_id, cu.name AS client_name,
            c.freelancer_id, fu.name AS freelancer_name, c.amount_cents, c.fee_cents,
            c.status, c.provider, c.payment_ref, c.payout_ref, c.refund_ref,
            c.deliverable_note, c.created_at,
            d.id AS dispute_id, d.reason AS dispute_reason, d.status AS dispute_status,
            d.resolution AS dispute_resolution, d.note AS dispute_note,
            d.created_at AS dispute_created_at, du.name AS dispute_opened_by,
            EXISTS (SELECT 1 FROM reviews r WHERE r.contract_id = c.id AND r.reviewer_id = $${
              auth.role === "admin" ? 1 : 2
            }) AS my_review_done
     FROM contracts c
     JOIN jobs j ON j.id = c.job_id
     JOIN users cu ON cu.id = c.client_id
     JOIN users fu ON fu.id = c.freelancer_id
     LEFT JOIN disputes d ON d.contract_id = c.id
     LEFT JOIN users du ON du.id = d.opened_by
     ${mine}
     ORDER BY c.created_at DESC`,
    auth.role === "admin" ? [auth.id] : [auth.id, auth.id],
  )

  return Response.json({
    contracts: res.rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      jobTitle: r.job_title,
      clientId: r.client_id,
      clientName: r.client_name,
      freelancerId: r.freelancer_id,
      freelancerName: r.freelancer_name,
      amountCents: r.amount_cents,
      feeCents: r.fee_cents,
      status: r.status,
      provider: r.provider,
      paymentRef: r.payment_ref,
      payoutRef: r.payout_ref,
      refundRef: r.refund_ref,
      deliverableNote: r.deliverable_note,
      dispute: r.dispute_id
        ? {
            id: r.dispute_id,
            contractId: r.id,
            openedByName: r.dispute_opened_by,
            reason: r.dispute_reason,
            status: r.dispute_status,
            resolution: r.dispute_resolution,
            note: r.dispute_note,
            createdAt: r.dispute_created_at,
          }
        : null,
      myReviewDone: r.my_review_done,
      createdAt: r.created_at,
    })),
  })
}

export async function PATCH(req: Request) {
  const auth = await requireRole("client", "freelancer")
  if (auth instanceof Response) return auth

  const body = (await req.json().catch(() => ({}))) as { id?: number; action?: string; note?: string }
  if (!Number.isInteger(body.id) || !body.action) {
    return Response.json({ error: "Pass { id, action }." }, { status: 400 })
  }

  const pool = getPool()
  const res = await pool.query(`SELECT * FROM contracts WHERE id = $1`, [body.id])
  if (res.rows.length === 0) {
    return Response.json({ error: "Contract not found." }, { status: 404 })
  }
  const c = res.rows[0]
  const isClient = c.client_id === auth.id
  const isFreelancer = c.freelancer_id === auth.id
  if (!isClient && !isFreelancer) {
    return Response.json({ error: "Not your contract." }, { status: 403 })
  }

  switch (body.action) {
    case "fund": {
      if (!isClient) return Response.json({ error: "Only the client funds escrow." }, { status: 403 })
      if (c.status !== "pending_funding") {
        return Response.json({ error: `Cannot fund from status '${c.status}' — escrow is funded exactly once.` }, { status: 409 })
      }
      const paymentRef = await holdFunds(c.amount_cents, c.id)
      const upd = await pool.query(
        `UPDATE contracts SET status = 'funded', provider = $2, payment_ref = $3, funded_at = now()
         WHERE id = $1 AND status = 'pending_funding' RETURNING id`,
        [c.id, escrowProvider(), paymentRef],
      )
      if (upd.rows.length === 0) {
        // Raced with another fund click after the charge — surface loudly so a
        // real system would reconcile/refund the duplicate hold.
        return Response.json({ error: "Contract was funded concurrently; duplicate hold needs reconciliation." }, { status: 409 })
      }
      return Response.json({ ok: true, paymentRef })
    }

    case "cancel": {
      if (!isClient) return Response.json({ error: "Only the client can cancel." }, { status: 403 })
      if (c.status !== "pending_funding") {
        return Response.json({ error: "Only unfunded contracts can be cancelled — use a dispute after funding." }, { status: 409 })
      }
      await pool.query(
        `UPDATE contracts SET status = 'cancelled', closed_at = now() WHERE id = $1 AND status = 'pending_funding'`,
        [c.id],
      )
      await pool.query(`UPDATE jobs SET status = 'open' WHERE id = $1`, [c.job_id])
      await pool.query(`UPDATE proposals SET status = 'rejected' WHERE id = $1`, [c.proposal_id])
      return Response.json({ ok: true })
    }

    case "deliver": {
      if (!isFreelancer) return Response.json({ error: "Only the freelancer delivers." }, { status: 403 })
      if (c.status !== "funded") {
        return Response.json(
          { error: c.status === "pending_funding" ? "Escrow is not funded yet — never deliver before the money is held." : `Cannot deliver from status '${c.status}'.` },
          { status: 409 },
        )
      }
      if (!body.note?.trim()) {
        return Response.json({ error: "A deliverable note is required (what did you ship?)." }, { status: 400 })
      }
      await pool.query(
        `UPDATE contracts SET status = 'delivered', deliverable_note = $2, delivered_at = now()
         WHERE id = $1 AND status = 'funded'`,
        [c.id, body.note.trim().slice(0, 2000)],
      )
      return Response.json({ ok: true })
    }

    case "approve": {
      if (!isClient) return Response.json({ error: "Only the client approves delivery." }, { status: 403 })
      if (c.status !== "delivered") {
        return Response.json({ error: `Cannot approve from status '${c.status}' — wait for delivery.` }, { status: 409 })
      }
      const freelancer = await pool.query(`SELECT payout_account FROM users WHERE id = $1`, [c.freelancer_id])
      const payout = c.amount_cents - c.fee_cents
      const payoutRef = await releaseFunds(payout, freelancer.rows[0].payout_account, c.id)
      const upd = await pool.query(
        `UPDATE contracts SET status = 'completed', payout_ref = $2, closed_at = now()
         WHERE id = $1 AND status = 'delivered' RETURNING id`,
        [c.id, payoutRef],
      )
      if (upd.rows.length === 0) {
        return Response.json({ error: "Contract changed concurrently; payout needs reconciliation." }, { status: 409 })
      }
      await pool.query(`UPDATE jobs SET status = 'closed' WHERE id = $1`, [c.job_id])
      return Response.json({ ok: true, payoutRef, payoutCents: payout })
    }

    case "dispute": {
      if (!["funded", "delivered"].includes(c.status)) {
        return Response.json(
          { error: TERMINAL.includes(c.status) ? "This contract is closed — disputes must be opened before completion." : "Disputes require funded escrow." },
          { status: 409 },
        )
      }
      if (!body.note?.trim()) {
        return Response.json({ error: "A dispute reason is required." }, { status: 400 })
      }
      const upd = await pool.query(
        `UPDATE contracts SET status = 'disputed' WHERE id = $1 AND status = ANY($2) RETURNING id`,
        [c.id, ["funded", "delivered"]],
      )
      if (upd.rows.length === 0) {
        return Response.json({ error: "Contract changed concurrently." }, { status: 409 })
      }
      await pool.query(
        `INSERT INTO disputes (contract_id, opened_by, reason) VALUES ($1, $2, $3)`,
        [c.id, auth.id, body.note.trim().slice(0, 2000)],
      )
      return Response.json({ ok: true })
    }

    default:
      return Response.json({ error: `Unknown action '${body.action}'.` }, { status: 400 })
  }
}
