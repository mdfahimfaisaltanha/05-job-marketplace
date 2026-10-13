import { requireRole } from "@/lib/auth"
import { getPool } from "@/lib/db"

export const runtime = "nodejs"

/**
 * GET: the job board. Freelancers see open jobs (plus their own bid status);
 *      clients see their own postings; admins see everything.
 * POST: post a job (clients only).
 */

export async function GET() {
  const auth = await requireRole("client", "freelancer", "admin")
  if (auth instanceof Response) return auth

  const pool = getPool()
  let rows
  if (auth.role === "client") {
    rows = (
      await pool.query(
        `SELECT j.id, j.client_id, u.name AS client_name, j.title, j.description, j.budget_cents,
                j.status, j.created_at,
                (SELECT COUNT(*)::int FROM proposals p WHERE p.job_id = j.id) AS proposal_count
         FROM jobs j JOIN users u ON u.id = j.client_id
         WHERE j.client_id = $1
         ORDER BY j.created_at DESC`,
        [auth.id],
      )
    ).rows
  } else if (auth.role === "freelancer") {
    rows = (
      await pool.query(
        `SELECT j.id, j.client_id, u.name AS client_name, j.title, j.description, j.budget_cents,
                j.status, j.created_at,
                (SELECT COUNT(*)::int FROM proposals p WHERE p.job_id = j.id) AS proposal_count,
                (SELECT p.status FROM proposals p WHERE p.job_id = j.id AND p.freelancer_id = $1) AS my_proposal_status
         FROM jobs j JOIN users u ON u.id = j.client_id
         WHERE j.status = 'open'
            OR EXISTS (SELECT 1 FROM proposals p WHERE p.job_id = j.id AND p.freelancer_id = $1)
         ORDER BY j.created_at DESC`,
        [auth.id],
      )
    ).rows
  } else {
    rows = (
      await pool.query(
        `SELECT j.id, j.client_id, u.name AS client_name, j.title, j.description, j.budget_cents,
                j.status, j.created_at,
                (SELECT COUNT(*)::int FROM proposals p WHERE p.job_id = j.id) AS proposal_count
         FROM jobs j JOIN users u ON u.id = j.client_id
         ORDER BY j.created_at DESC`,
      )
    ).rows
  }

  return Response.json({
    jobs: rows.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      clientName: r.client_name,
      title: r.title,
      description: r.description,
      budgetCents: r.budget_cents,
      status: r.status,
      proposalCount: r.proposal_count,
      myProposalStatus: r.my_proposal_status ?? null,
      createdAt: r.created_at,
    })),
  })
}

export async function POST(req: Request) {
  const auth = await requireRole("client")
  if (auth instanceof Response) return auth

  const body = (await req.json().catch(() => ({}))) as {
    title?: string
    description?: string
    budgetCents?: number
  }
  if (!body.title?.trim() || !body.description?.trim()) {
    return Response.json({ error: "title and description are required." }, { status: 400 })
  }
  if (!Number.isInteger(body.budgetCents) || (body.budgetCents as number) < 500) {
    return Response.json({ error: "budgetCents must be an integer ≥ 500 ($5 minimum)." }, { status: 400 })
  }
  if ((body.budgetCents as number) > 5_000_000) {
    return Response.json({ error: "budgetCents must be ≤ 5,000,000 ($50k cap for the demo)." }, { status: 400 })
  }

  const res = await getPool().query(
    `INSERT INTO jobs (client_id, title, description, budget_cents) VALUES ($1, $2, $3, $4) RETURNING id`,
    [auth.id, body.title.trim(), body.description.trim(), body.budgetCents],
  )
  return Response.json({ ok: true, id: res.rows[0].id })
}
