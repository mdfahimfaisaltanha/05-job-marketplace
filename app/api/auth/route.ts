import { createSession, destroySession, getSession, hashPassword, verifyPassword } from "@/lib/auth"
import { getPool } from "@/lib/db"
import { createPayoutAccount } from "@/lib/escrow"

export const runtime = "nodejs"

/**
 * GET: current session.
 * POST { mode: "login" | "signup", ... }: sign in or create an account.
 *   Signup accepts role "client" or "freelancer" only — admins are seeded,
 *   never self-served. Freelancers get a payout account (Stripe Express in
 *   stripe mode, mock reference otherwise) at signup.
 * DELETE: sign out.
 */

export async function GET() {
  const user = await getSession()
  return Response.json({ user })
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    mode?: string
    name?: string
    email?: string
    password?: string
    role?: string
  }
  if (!body.email?.trim() || !body.password) {
    return Response.json({ error: "Email and password are required." }, { status: 400 })
  }
  const email = body.email.trim().toLowerCase()
  const pool = getPool()

  if (body.mode === "signup") {
    if (!body.name?.trim()) {
      return Response.json({ error: "Name is required." }, { status: 400 })
    }
    if (body.role !== "client" && body.role !== "freelancer") {
      return Response.json({ error: "Role must be client or freelancer." }, { status: 400 })
    }
    if (body.password.length < 10) {
      return Response.json({ error: "Password must be at least 10 characters." }, { status: 400 })
    }
    const existing = await pool.query(`SELECT id FROM users WHERE lower(email) = $1`, [email])
    if (existing.rows.length > 0) {
      return Response.json({ error: "An account with that email already exists." }, { status: 409 })
    }
    const payoutAccount = body.role === "freelancer" ? await createPayoutAccount(email) : null
    const res = await pool.query(
      `INSERT INTO users (name, email, role, password_hash, payout_account)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, role`,
      [body.name.trim(), email, body.role, hashPassword(body.password), payoutAccount],
    )
    await createSession(res.rows[0].id)
    return Response.json({ user: res.rows[0] })
  }

  // login — same error for unknown email and wrong password (no enumeration)
  const res = await pool.query(
    `SELECT id, name, email, role, password_hash FROM users WHERE lower(email) = $1`,
    [email],
  )
  const row = res.rows[0]
  if (!row || !verifyPassword(body.password, row.password_hash)) {
    return Response.json({ error: "Invalid email or password." }, { status: 401 })
  }
  await createSession(row.id)
  return Response.json({ user: { id: row.id, name: row.name, email: row.email, role: row.role } })
}

export async function DELETE() {
  await destroySession()
  return Response.json({ ok: true })
}
