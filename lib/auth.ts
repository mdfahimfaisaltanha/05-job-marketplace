import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"
import { getPool } from "./db"
import type { Role, SessionUser } from "./types"

/**
 * Multi-user auth + role guards.
 *
 * - Passwords: scrypt (N=16384) with a per-user random 16-byte salt, stored
 *   as `scrypt:<salt hex>:<hash hex>`. Verified with timingSafeEqual.
 * - Sessions: 32-byte random token in an httpOnly cookie, stored server-side
 *   with a 24h expiry enforced in SQL.
 * - requireRole(...) returns the session user or a ready-to-return 401/403
 *   Response so route handlers stay one-liner-guarded.
 */

const COOKIE = "gig_session"
const SESSION_HOURS = 24

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 16384 })
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":")
  if (parts.length !== 3 || parts[0] !== "scrypt") return false
  const salt = Buffer.from(parts[1], "hex")
  const expected = Buffer.from(parts[2], "hex")
  const actual = scryptSync(password, salt, expected.length, { N: 16384 })
  return timingSafeEqual(actual, expected)
}

export async function createSession(userId: number): Promise<void> {
  const token = randomBytes(32).toString("hex")
  await getPool().query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_HOURS} hours')`,
    [token, userId],
  )
  cookies().set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_HOURS * 3600,
    path: "/",
  })
}

export async function destroySession(): Promise<void> {
  const token = cookies().get(COOKIE)?.value
  if (token) {
    await getPool().query(`DELETE FROM sessions WHERE token = $1`, [token]).catch(() => {})
  }
  cookies().delete(COOKIE)
}

export async function getSession(): Promise<SessionUser | null> {
  const token = cookies().get(COOKIE)?.value
  if (!token) return null
  const res = await getPool().query(
    `SELECT u.id, u.name, u.email, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  )
  if (res.rows.length === 0) return null
  const r = res.rows[0]
  return { id: r.id, name: r.name, email: r.email, role: r.role as Role }
}

/** Returns the session user, or a 401/403 Response ready to be returned. */
export async function requireRole(...roles: Role[]): Promise<SessionUser | Response> {
  const user = await getSession()
  if (!user) {
    return Response.json({ error: "Sign in required." }, { status: 401 })
  }
  if (!roles.includes(user.role)) {
    return Response.json(
      { error: `Forbidden: requires role ${roles.join(" or ")} (you are ${user.role}).` },
      { status: 403 },
    )
  }
  return user
}
