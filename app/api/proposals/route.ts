import { requireRole } from "@/lib/auth"
import { getPool } from "@/lib/db"
import { feeFor } from "@/lib/escrow"

export const runtime = "nodejs"

/**
 * GET ?jobId= : proposals for a job (job owner or admin only), with each
 *               freelancer's average rating so clients can compare bids.
 * POST : submit a bid (freelancers only, one per job, open jobs only).
 * PATCH { proposalId, action: "accept" } : accept a bid (job owner only).
 *   Accepting is transactional: the winning proposal is accepted, all others
 *   are rejected, the job moves to in_progress, and a contract is created in
 *   pending_funding at the BID amount (not the posted budget).
 */

export async function GET(req: Request) {
  const auth = await requireRole("client", "admin")
  if (auth instanceof Response) return auth

  const jobId = Number(new URL(req.url).searchParams.get("jobId"))
  if (!Number.isInteger(jobId)) {
    return Response.json({ error: "jobId query param is required." }, { status: 400 })
  }
  const pool = getPool()
  const job = await pool.query(`SELECT client_id FROM jobs WHERE id = $1`, [jobId])
  if (job.rows.length === 0) {
    return Response.json({ error: "Job not found." }, { status: 404 })
  }
  if (auth.role !== "admin" && job.rows[0].client_id !== auth.id) {
    return Response.json({ error: "Only the job owner can view its proposals." }, { status: 403 })
  }

  const res = await pool.query(
    `SELECT p.id, p.job_id, p.freelancer_id, u.name AS freelancer_name, p.bid_cents,
            p.cover_letter, p.status, p.created_at,
            ROUND(AVG(r.rating)::numeric, 1)::float AS avg_rating,
            COUNT(r.id)::int AS review_count
     FROM proposals p
     JOIN users u ON u.id = p.freelancer_id
     LEFT JOIN reviews r ON r.reviewee_id = p.freelancer_id
     WHERE p.job_id = $1
     GROUP BY p.id, u.name
     ORDER BY p.created_at ASC`,
    [jobId],
  )
  return Response.json({
    proposals: res.rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      freelancerId: r.freelancer_id,
      freelancerName: r.freelancer_name,
      freelancerRating: r.avg_rating,
      freelancerReviewCount: r.review_count,
      bidCents: r.bid_cents,
      coverLetter: r.cover_letter,
      status: r.status,
      createdAt: r.created_at,
    })),
  })
}

export async function POST(req: Request) {
  const auth = await requireRole("freelancer")
  if (auth instanceof Response) return auth

  const body = (await req.json().catch(() => ({}))) as {
    jobId?: number
    bidCents?: number
    coverLetter?: string
  }
  if (!Number.isInteger(body.jobId) || !body.coverLetter?.trim()) {
    return Response.json({ error: "jobId and coverLetter are required." }, { status: 400 })
  }
  if (!Number.isInteger(body.bidCents) || (body.bidCents as number) < 500) {
    return Response.json({ error: "bidCents must be an integer ≥ 500 ($5 minimum)." }, { status: 400 })
  }

  const pool = getPool()
  const job = await pool.query(`SELECT status, budget_cents FROM jobs WHERE id = $1`, [body.jobId])
  if (job.rows.length === 0) {
    return Response.json({ error: "Job not found." }, { status: 404 })
  }
  if (job.rows[0].status !== "open") {
    return Response.json({ error: "This job is no longer accepting proposals." }, { status: 409 })
  }
  if ((body.bidCents as number) > job.rows[0].budget_cents * 3) {
    return Response.json({ error: "Bid exceeds 3× the posted budget — that's a typo guard." }, { status: 400 })
  }

  // UNIQUE(job_id, freelancer_id) backs this up at the DB level.
  const dupe = await pool.query(
    `SELECT id FROM proposals WHERE job_id = $1 AND freelancer_id = $2`,
    [body.jobId, auth.id],
  )
  if (dupe.rows.length > 0) {
    return Response.json({ error: "You already bid on this job." }, { status: 409 })
  }

  const res = await pool.query(
    `INSERT INTO proposals (job_id, freelancer_id, bid_cents, cover_letter)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [body.jobId, auth.id, body.bidCents, body.coverLetter.trim().slice(0, 2000)],
  )
  return Response.json({ ok: true, id: res.rows[0].id })
}

export async function PATCH(req: Request) {
  const auth = await requireRole("client")
  if (auth instanceof Response) return auth

  const body = (await req.json().catch(() => ({}))) as { proposalId?: number; action?: string }
  if (!Number.isInteger(body.proposalId) || body.action !== "accept") {
    return Response.json({ error: 'Pass { proposalId, action: "accept" }.' }, { status: 400 })
  }

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    // Lock the job row so two accepts can't race.
    const res = await client.query(
      `SELECT p.id, p.job_id, p.freelancer_id, p.bid_cents, p.status AS proposal_status,
              j.client_id, j.status AS job_status
       FROM proposals p JOIN jobs j ON j.id = p.job_id
       WHERE p.id = $1
       FOR UPDATE OF j`,
      [body.proposalId],
    )
    if (res.rows.length === 0) {
      await client.query("ROLLBACK")
      return Response.json({ error: "Proposal not found." }, { status: 404 })
    }
    const p = res.rows[0]
    if (p.client_id !== auth.id) {
      await client.query("ROLLBACK")
      return Response.json({ error: "Only the job owner can accept a proposal." }, { status: 403 })
    }
    if (p.job_status !== "open" || p.proposal_status !== "pending") {
      await client.query("ROLLBACK")
      return Response.json({ error: "A proposal was already accepted for this job." }, { status: 409 })
    }

    await client.query(`UPDATE proposals SET status = 'accepted' WHERE id = $1`, [p.id])
    await client.query(
      `UPDATE proposals SET status = 'rejected' WHERE job_id = $1 AND id <> $2 AND status = 'pending'`,
      [p.job_id, p.id],
    )
    await client.query(`UPDATE jobs SET status = 'in_progress' WHERE id = $1`, [p.job_id])

    const contract = await client.query(
      `INSERT INTO contracts (job_id, proposal_id, client_id, freelancer_id, amount_cents, fee_cents)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [p.job_id, p.id, auth.id, p.freelancer_id, p.bid_cents, feeFor(p.bid_cents)],
    )

    await client.query("COMMIT")
    return Response.json({ ok: true, contractId: contract.rows[0].id })
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}
