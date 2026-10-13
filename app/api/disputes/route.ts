import { requireRole } from "@/lib/auth"
import { getPool } from "@/lib/db"
import { feeFor, refundFunds, releaseFunds } from "@/lib/escrow"

export const runtime = "nodejs"

/**
 * Admin dispute desk.
 *
 * GET: all disputes (open first), with contract context.
 * PATCH { id, resolution: "release" | "refund" | "split", note }:
 *   - release → freelancer gets amount − fee (client loses the escrow)
 *   - refund  → client gets the full amount back (freelancer gets nothing;
 *               the platform waives its fee — taking a fee on a refund is
 *               how marketplaces end up on Hacker News)
 *   - split   → client refunded half; freelancer paid the other half minus
 *               the fee on that half (odd cents go to the client's side)
 */

export async function GET() {
  const auth = await requireRole("admin")
  if (auth instanceof Response) return auth

  const res = await getPool().query(
    `SELECT d.id, d.contract_id, d.reason, d.status, d.resolution, d.note, d.created_at,
            du.name AS opened_by_name,
            c.amount_cents, c.fee_cents, c.status AS contract_status, c.deliverable_note,
            j.title AS job_title, cu.name AS client_name, fu.name AS freelancer_name
     FROM disputes d
     JOIN contracts c ON c.id = d.contract_id
     JOIN jobs j ON j.id = c.job_id
     JOIN users du ON du.id = d.opened_by
     JOIN users cu ON cu.id = c.client_id
     JOIN users fu ON fu.id = c.freelancer_id
     ORDER BY (d.status = 'open') DESC, d.created_at DESC`,
  )
  return Response.json({
    disputes: res.rows.map((r) => ({
      id: r.id,
      contractId: r.contract_id,
      jobTitle: r.job_title,
      clientName: r.client_name,
      freelancerName: r.freelancer_name,
      openedByName: r.opened_by_name,
      reason: r.reason,
      deliverableNote: r.deliverable_note,
      amountCents: r.amount_cents,
      feeCents: r.fee_cents,
      status: r.status,
      resolution: r.resolution,
      note: r.note,
      createdAt: r.created_at,
    })),
  })
}

export async function PATCH(req: Request) {
  const auth = await requireRole("admin")
  if (auth instanceof Response) return auth

  const body = (await req.json().catch(() => ({}))) as {
    id?: number
    resolution?: string
    note?: string
  }
  if (!Number.isInteger(body.id) || !["release", "refund", "split"].includes(body.resolution ?? "")) {
    return Response.json({ error: 'Pass { id, resolution: "release" | "refund" | "split", note? }.' }, { status: 400 })
  }

  const pool = getPool()
  const res = await pool.query(
    `SELECT d.id, d.status, c.id AS contract_id, c.job_id, c.status AS contract_status,
            c.amount_cents, c.fee_cents, c.payment_ref, c.freelancer_id
     FROM disputes d JOIN contracts c ON c.id = d.contract_id
     WHERE d.id = $1`,
    [body.id],
  )
  if (res.rows.length === 0) {
    return Response.json({ error: "Dispute not found." }, { status: 404 })
  }
  const d = res.rows[0]
  if (d.status !== "open" || d.contract_status !== "disputed") {
    return Response.json({ error: "This dispute is already resolved." }, { status: 409 })
  }

  const freelancer = await pool.query(`SELECT payout_account FROM users WHERE id = $1`, [d.freelancer_id])
  const payoutAccount = freelancer.rows[0].payout_account

  let finalStatus: string
  let payoutRef: string | null = null
  let refundRef: string | null = null

  if (body.resolution === "release") {
    payoutRef = await releaseFunds(d.amount_cents - d.fee_cents, payoutAccount, d.contract_id)
    finalStatus = "completed"
  } else if (body.resolution === "refund") {
    refundRef = await refundFunds(d.payment_ref, d.amount_cents)
    finalStatus = "refunded"
  } else {
    // split: odd cent goes to the client's refund half
    const freelancerHalf = Math.floor(d.amount_cents / 2)
    const clientHalf = d.amount_cents - freelancerHalf
    refundRef = await refundFunds(d.payment_ref, clientHalf)
    payoutRef = await releaseFunds(freelancerHalf - feeFor(freelancerHalf), payoutAccount, d.contract_id)
    finalStatus = "split"
  }

  // Optimistic guard mirrors the contracts route — resolve exactly once.
  const upd = await pool.query(
    `UPDATE contracts SET status = $2, payout_ref = COALESCE($3, payout_ref),
            refund_ref = COALESCE($4, refund_ref), closed_at = now()
     WHERE id = $1 AND status = 'disputed' RETURNING id`,
    [d.contract_id, finalStatus, payoutRef, refundRef],
  )
  if (upd.rows.length === 0) {
    return Response.json({ error: "Contract changed concurrently; money movement needs reconciliation." }, { status: 409 })
  }
  await pool.query(
    `UPDATE disputes SET status = 'resolved', resolution = $2, resolved_by = $3, note = $4, resolved_at = now()
     WHERE id = $1`,
    [d.id, body.resolution, auth.id, body.note?.trim().slice(0, 2000) ?? null],
  )
  await pool.query(`UPDATE jobs SET status = 'closed' WHERE id = $1`, [d.job_id])

  return Response.json({ ok: true, finalStatus, payoutRef, refundRef })
}
