import { requireRole } from "@/lib/auth"
import { getPool } from "@/lib/db"

export const runtime = "nodejs"

/**
 * Two-sided reviews, gated hard:
 *   - only after the contract reaches a terminal paid state
 *     (completed | refunded | split) — never mid-engagement, so reviews
 *     can't be used as leverage ("approve or I 1-star you")
 *   - only by the two parties on the contract, about each other
 *   - one review per direction per contract (UNIQUE(contract_id, reviewer_id))
 *
 * GET ?userId= : reviews received by a user + their average.
 * POST { contractId, rating 1-5, comment } : leave a review.
 */

const REVIEWABLE = ["completed", "refunded", "split"]

export async function GET(req: Request) {
  const auth = await requireRole("client", "freelancer", "admin")
  if (auth instanceof Response) return auth

  const userId = Number(new URL(req.url).searchParams.get("userId") ?? auth.id)
  if (!Number.isInteger(userId)) {
    return Response.json({ error: "Invalid userId." }, { status: 400 })
  }

  const res = await getPool().query(
    `SELECT r.id, r.contract_id, u.name AS reviewer_name, r.rating, r.comment, r.created_at
     FROM reviews r JOIN users u ON u.id = r.reviewer_id
     WHERE r.reviewee_id = $1
     ORDER BY r.created_at DESC`,
    [userId],
  )
  const avg =
    res.rows.length > 0
      ? Math.round((res.rows.reduce((s, r) => s + r.rating, 0) / res.rows.length) * 10) / 10
      : null

  return Response.json({
    averageRating: avg,
    reviews: res.rows.map((r) => ({
      id: r.id,
      contractId: r.contract_id,
      reviewerName: r.reviewer_name,
      rating: r.rating,
      comment: r.comment,
      createdAt: r.created_at,
    })),
  })
}

export async function POST(req: Request) {
  const auth = await requireRole("client", "freelancer")
  if (auth instanceof Response) return auth

  const body = (await req.json().catch(() => ({}))) as {
    contractId?: number
    rating?: number
    comment?: string
  }
  if (!Number.isInteger(body.contractId)) {
    return Response.json({ error: "contractId is required." }, { status: 400 })
  }
  if (!Number.isInteger(body.rating) || (body.rating as number) < 1 || (body.rating as number) > 5) {
    return Response.json({ error: "rating must be an integer from 1 to 5." }, { status: 400 })
  }

  const pool = getPool()
  const res = await pool.query(`SELECT * FROM contracts WHERE id = $1`, [body.contractId])
  if (res.rows.length === 0) {
    return Response.json({ error: "Contract not found." }, { status: 404 })
  }
  const c = res.rows[0]
  if (c.client_id !== auth.id && c.freelancer_id !== auth.id) {
    return Response.json({ error: "Only the contract's parties can review it." }, { status: 403 })
  }
  if (!REVIEWABLE.includes(c.status)) {
    return Response.json(
      { error: `Reviews open once the contract is settled (status is '${c.status}').` },
      { status: 409 },
    )
  }

  const revieweeId = c.client_id === auth.id ? c.freelancer_id : c.client_id
  const dupe = await pool.query(
    `SELECT id FROM reviews WHERE contract_id = $1 AND reviewer_id = $2`,
    [body.contractId, auth.id],
  )
  if (dupe.rows.length > 0) {
    return Response.json({ error: "You already reviewed this contract." }, { status: 409 })
  }

  await pool.query(
    `INSERT INTO reviews (contract_id, reviewer_id, reviewee_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5)`,
    [body.contractId, auth.id, revieweeId, body.rating, body.comment?.trim().slice(0, 1000) ?? ""],
  )
  return Response.json({ ok: true })
}
