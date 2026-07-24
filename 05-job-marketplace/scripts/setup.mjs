import { randomBytes, scryptSync } from "node:crypto"
import { readFileSync } from "node:fs"
import pg from "pg"

/**
 * One-shot setup: creates tables and seeds a living marketplace — clients,
 * freelancers, open jobs with competing bids, and contracts in every state
 * of the escrow lifecycle (pending funding, funded, delivered, disputed,
 * completed with two-sided reviews).
 *
 *   npm run setup
 *
 * Reads DATABASE_URL from .env.local (or the environment). Seeded escrow
 * references use mock_* ids so no Stripe account is needed. Safe to re-run:
 * skips seeding if data already exists.
 */

function loadEnvLocal() {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
    }
  } catch {
    /* rely on the environment */
  }
}

loadEnvLocal()

if (!process.env.DATABASE_URL) {
  console.error("\n❌ DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.\n")
  process.exit(1)
}

const SEED_PASSWORD = process.env.SEED_PASSWORD || "ChangeMe123!"
const FEE_BPS = Number(process.env.PLATFORM_FEE_BPS) || 1000
const feeFor = (cents) => Math.round((cents * FEE_BPS) / 10_000)
const mockRef = (prefix) => `mock_${prefix}_${randomBytes(10).toString("hex")}`

function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 16384 })
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  role           TEXT NOT NULL CHECK (role IN ('client', 'freelancer', 'admin')),
  password_hash  TEXT NOT NULL,
  payout_account TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id           SERIAL PRIMARY KEY,
  client_id    INTEGER NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  budget_cents INTEGER NOT NULL CHECK (budget_cents > 0),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'closed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proposals (
  id            SERIAL PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  freelancer_id INTEGER NOT NULL REFERENCES users(id),
  bid_cents     INTEGER NOT NULL CHECK (bid_cents > 0),
  cover_letter  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, freelancer_id)
);

CREATE TABLE IF NOT EXISTS contracts (
  id               SERIAL PRIMARY KEY,
  job_id           INTEGER NOT NULL REFERENCES jobs(id),
  proposal_id      INTEGER NOT NULL REFERENCES proposals(id),
  client_id        INTEGER NOT NULL REFERENCES users(id),
  freelancer_id    INTEGER NOT NULL REFERENCES users(id),
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  fee_cents        INTEGER NOT NULL CHECK (fee_cents >= 0),
  status           TEXT NOT NULL DEFAULT 'pending_funding' CHECK (status IN
    ('pending_funding', 'funded', 'delivered', 'disputed', 'completed', 'refunded', 'split', 'cancelled')),
  provider         TEXT,
  payment_ref      TEXT,
  payout_ref       TEXT,
  refund_ref       TEXT,
  deliverable_note TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  funded_at        TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  closed_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS disputes (
  id          SERIAL PRIMARY KEY,
  contract_id INTEGER NOT NULL UNIQUE REFERENCES contracts(id) ON DELETE CASCADE,
  opened_by   INTEGER NOT NULL REFERENCES users(id),
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution  TEXT CHECK (resolution IN ('release', 'refund', 'split')),
  resolved_by INTEGER REFERENCES users(id),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS reviews (
  id          SERIAL PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  reviewee_id INTEGER NOT NULL REFERENCES users(id),
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contract_id, reviewer_id)
);
`

async function main() {
  console.log("⏳ Creating tables…")
  await pool.query(SCHEMA)

  const existing = await pool.query(`SELECT COUNT(*)::int AS item_count FROM users`)
  if (existing.rows[0].item_count > 0) {
    console.log("ℹ️  Data already exists — skipping seed. (Drop the tables to reseed.)")
    await pool.end()
    return
  }

  console.log("👥 Creating users…")
  const users = [
    ["Platform Admin", "admin@giglance.test", "admin", null],
    ["Sara Malik", "sara@giglance.test", "client", null],
    ["Omar Farouk", "omar@giglance.test", "client", null],
    ["Nadia Islam", "nadia@giglance.test", "freelancer", mockRef("acct")],
    ["Jake Torres", "jake@giglance.test", "freelancer", mockRef("acct")],
    ["Priya Sharma", "priya@giglance.test", "freelancer", mockRef("acct")],
  ]
  const ids = {}
  for (const [name, email, role, payout] of users) {
    const r = await pool.query(
      `INSERT INTO users (name, email, role, password_hash, payout_account) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, email, role, hashPassword(SEED_PASSWORD), payout],
    )
    ids[email] = r.rows[0].id
  }
  const sara = ids["sara@giglance.test"]
  const omar = ids["omar@giglance.test"]
  const nadia = ids["nadia@giglance.test"]
  const jake = ids["jake@giglance.test"]
  const priya = ids["priya@giglance.test"]

  console.log("📋 Posting jobs…")
  const jobs = [
    // [client, title, description, budget, status]
    [sara, "Landing page for a coffee subscription startup", "Design + build a responsive landing page (Next.js preferred). Copy is ready; need hero, pricing, FAQ, and an email capture form wired to our API.", 60_000, "closed"],
    [sara, "Logo + brand kit refresh", "Refresh our logo and produce a small brand kit: palette, type scale, and social templates. Deliver as Figma + exported assets.", 35_000, "in_progress"],
    [omar, "Migrate WooCommerce store to Shopify", "~180 SKUs, 3 collections, customer + order history export. Need redirects mapped and theme matched to current look.", 120_000, "in_progress"],
    [omar, "Python script to reconcile bank CSV exports", "Monthly CSVs from two banks need matching against invoices in a Postgres table, with an exceptions report. Include tests.", 25_000, "in_progress"],
    [sara, "Write 6 SEO articles on specialty coffee", "1200-1500 words each, brief provided per article. Native-level English, original content only — we run plagiarism checks.", 30_000, "open"],
    [omar, "Dashboard mockups for logistics SaaS", "5 screens (orders, live map, driver detail, reports, settings) in Figma. We supply a rough wireframe and brand colors.", 45_000, "open"],
  ]
  const jobIds = []
  for (const [clientId, title, desc, budget, status] of jobs) {
    const r = await pool.query(
      `INSERT INTO jobs (client_id, title, description, budget_cents, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [clientId, title, desc, budget, status],
    )
    jobIds.push(r.rows[0].id)
  }

  console.log("✍️  Submitting proposals…")
  const proposals = [
    // [job, freelancer, bid, letter, status]
    [0, nadia, 55_000, "I've shipped 12+ marketing sites in Next.js — happy to share three live ones. I can deliver in 5 days including the email capture integration.", "accepted"],
    [0, jake, 48_000, "Front-end dev, strong on animations. First draft in a week.", "rejected"],
    [1, priya, 32_000, "Brand designer, ex-agency. I'll deliver 3 logo directions, then a full kit for the chosen one. Figma source included.", "accepted"],
    [2, jake, 110_000, "I've done 9 Woo-to-Shopify migrations. I script the product/customer export, map 301s in bulk, and match your theme. Two-week window.", "accepted"],
    [3, nadia, 24_000, "Python + Postgres is my daily stack. I'll ship a typed script with pytest coverage and a README, exceptions report as CSV.", "accepted"],
    [4, nadia, 28_000, "Specialty coffee is literally my hobby — I can write these with real depth. Two articles per week.", "pending"],
    [4, priya, 30_000, "Content designer with SEO background; I include meta descriptions and internal-link suggestions per article.", "pending"],
    [5, priya, 42_000, "Product designer, logistics experience at a courier startup. 5 screens, clickable prototype, 10 days.", "pending"],
    [5, jake, 45_000, "Full package: mockups + a component sheet so your devs can build straight from it.", "pending"],
  ]
  const proposalIds = []
  for (const [jobIdx, freelancerId, bid, letter, status] of proposals) {
    const r = await pool.query(
      `INSERT INTO proposals (job_id, freelancer_id, bid_cents, cover_letter, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [jobIds[jobIdx], freelancerId, bid, letter, status],
    )
    proposalIds.push(r.rows[0].id)
  }

  console.log("🤝 Creating contracts across the whole lifecycle…")
  // 1. COMPLETED: Sara × Nadia landing page — funded, delivered, approved, reviewed both ways.
  const c1 = await pool.query(
    `INSERT INTO contracts (job_id, proposal_id, client_id, freelancer_id, amount_cents, fee_cents, status,
                            provider, payment_ref, payout_ref, deliverable_note,
                            created_at, funded_at, delivered_at, closed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'completed','mock',$7,$8,$9,
             now() - interval '21 days', now() - interval '20 days', now() - interval '9 days', now() - interval '8 days')
     RETURNING id`,
    [jobIds[0], proposalIds[0], sara, nadia, 55_000, feeFor(55_000), mockRef("pi"), mockRef("tr"),
     "Live at staging.brewbox.dev — hero, pricing, FAQ, email capture wired to your API. Lighthouse 98/100/100/100."],
  )
  await pool.query(
    `INSERT INTO reviews (contract_id, reviewer_id, reviewee_id, rating, comment) VALUES
     ($1, $2, $3, 5, 'Nadia was outstanding — shipped early, pixel-perfect, and the form integration just worked.'),
     ($1, $3, $2, 5, 'Clear brief, fast feedback, instant escrow funding. Ideal client.')`,
    [c1.rows[0].id, sara, nadia],
  )

  // 2. PENDING_FUNDING: Sara × Priya brand kit — just accepted, needs escrow.
  await pool.query(
    `INSERT INTO contracts (job_id, proposal_id, client_id, freelancer_id, amount_cents, fee_cents, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending_funding', now() - interval '1 day')`,
    [jobIds[1], proposalIds[2], sara, priya, 32_000, feeFor(32_000)],
  )

  // 3. FUNDED: Omar × Jake migration — escrow held, work in progress.
  await pool.query(
    `INSERT INTO contracts (job_id, proposal_id, client_id, freelancer_id, amount_cents, fee_cents, status,
                            provider, payment_ref, created_at, funded_at)
     VALUES ($1,$2,$3,$4,$5,$6,'funded','mock',$7, now() - interval '6 days', now() - interval '5 days')`,
    [jobIds[2], proposalIds[3], omar, jake, 110_000, feeFor(110_000), mockRef("pi")],
  )

  // 4. DISPUTED: Omar × Nadia reconcile script — delivered, client disputes scope.
  const c4 = await pool.query(
    `INSERT INTO contracts (job_id, proposal_id, client_id, freelancer_id, amount_cents, fee_cents, status,
                            provider, payment_ref, deliverable_note, created_at, funded_at, delivered_at)
     VALUES ($1,$2,$3,$4,$5,$6,'disputed','mock',$7,$8, now() - interval '10 days', now() - interval '9 days', now() - interval '3 days')
     RETURNING id`,
    [jobIds[3], proposalIds[4], omar, nadia, 24_000, feeFor(24_000), mockRef("pi"),
     "Repo link sent — script matches 96% of transactions automatically, exceptions report included, 14 pytest cases."],
  )
  await pool.query(
    `INSERT INTO disputes (contract_id, opened_by, reason, created_at)
     VALUES ($1, $2, 'The script only supports the two CSV formats from the brief — but our third bank was mentioned in chat and is not handled. Requesting partial refund.', now() - interval '2 days')`,
    [c4.rows[0].id, omar],
  )

  console.log(`\n✅ Seeded: ${users.length} users, ${jobs.length} jobs, ${proposals.length} proposals, 4 contracts (completed / pending funding / funded / disputed), 1 open dispute, 2 reviews.`)
  console.log("\n🔑 Demo accounts (all share the same password):")
  console.log("   sara@giglance.test   — client   (has a contract to FUND + one completed)")
  console.log("   omar@giglance.test   — client   (funded contract + the open dispute)")
  console.log("   nadia@giglance.test  — freelancer (5★, party to the dispute)")
  console.log("   jake@giglance.test   — freelancer (has a funded contract to DELIVER)")
  console.log("   priya@giglance.test  — freelancer (waiting on escrow funding)")
  console.log("   admin@giglance.test  — admin    (dispute desk)")
  console.log(`   password: ${SEED_PASSWORD}${process.env.SEED_PASSWORD ? "" : "   (default — set SEED_PASSWORD to override)"}`)
  console.log("\n🎉 Setup complete. Run: npm run dev → http://localhost:3000")
  await pool.end()
}

main().catch((err) => {
  console.error("\n❌ Setup failed:", err.message)
  process.exit(1)
})
