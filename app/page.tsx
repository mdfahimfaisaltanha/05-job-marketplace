"use client"

import { useCallback, useEffect, useState } from "react"
import type { Contract, Dispute, Job, Proposal, Review, SessionUser } from "@/lib/types"

type Tab = "jobs" | "contracts" | "disputes" | "reviews"
type AdminDispute = Dispute & {
  jobTitle: string
  clientName: string
  freelancerName: string
  deliverableNote: string | null
  amountCents: number
  feeCents: number
}

const fmt = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
const fmtDate = (d: string) =>
  new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n)

const STATUS_BADGE: Record<string, string> = {
  open: "ok", in_progress: "warn", closed: "muted",
  pending: "info", accepted: "ok", rejected: "muted",
  pending_funding: "warn", funded: "info", delivered: "accent",
  disputed: "bad", completed: "ok", refunded: "muted", split: "warn", cancelled: "muted",
  resolved: "ok",
}

function Badge({ value }: { value: string }) {
  return <span className={`badge ${STATUS_BADGE[value] ?? "muted"}`}>{value.replace(/_/g, " ")}</span>
}

export default function Marketplace() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined)
  const [tab, setTab] = useState<Tab>("jobs")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [jobs, setJobs] = useState<Job[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [disputes, setDisputes] = useState<AdminDispute[]>([])
  const [myReviews, setMyReviews] = useState<{ averageRating: number | null; reviews: Review[] }>({ averageRating: null, reviews: [] })
  const [proposalsFor, setProposalsFor] = useState<{ job: Job; proposals: Proposal[] } | null>(null)

  // auth form
  const [mode, setMode] = useState<"login" | "signup">("login")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState("freelancer")

  // forms
  const [jTitle, setJTitle] = useState("")
  const [jDesc, setJDesc] = useState("")
  const [jBudget, setJBudget] = useState("")
  const [bidFor, setBidFor] = useState<Job | null>(null)
  const [bidAmount, setBidAmount] = useState("")
  const [bidLetter, setBidLetter] = useState("")
  const [actionNote, setActionNote] = useState<Record<number, string>>({})
  const [reviewDraft, setReviewDraft] = useState<Record<number, { rating: number; comment: string }>>({})

  const refresh = useCallback(async (u: SessionUser) => {
    const jobsP = fetch("/api/jobs").then(async (r) => {
      if (r.ok) setJobs((await r.json()).jobs)
    })
    const contractsP = fetch("/api/contracts").then(async (r) => {
      if (r.ok) setContracts((await r.json()).contracts)
    })
    const reviewsP = fetch("/api/reviews").then(async (r) => {
      if (r.ok) setMyReviews(await r.json())
    })
    const disputesP =
      u.role === "admin"
        ? fetch("/api/disputes").then(async (r) => {
            if (r.ok) setDisputes((await r.json()).disputes)
          })
        : Promise.resolve()
    await Promise.all([jobsP, contractsP, reviewsP, disputesP]).catch(() =>
      setError("Failed to load data. Did you run `npm run setup`?"),
    )
  }, [])

  useEffect(() => {
    fetch("/api/auth")
      .then(async (r) => {
        const data = await r.json()
        setUser(data.user)
        if (data.user) void refresh(data.user)
      })
      .catch(() => setUser(null))
  }, [refresh])

  async function call(url: string, method: string, body: unknown): Promise<Record<string, unknown> | null> {
    setError(null)
    setNotice(null)
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError((data as { error?: string }).error || "Request failed.")
      return null
    }
    if (user) void refresh(user)
    return data as Record<string, unknown>
  }

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault()
    const data = await call("/api/auth", "POST", { mode, name, email, password, role })
    if (data?.user) {
      setUser(data.user as SessionUser)
      setPassword("")
      void refresh(data.user as SessionUser)
    }
  }

  async function openProposals(job: Job) {
    setError(null)
    const res = await fetch(`/api/proposals?jobId=${job.id}`)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(data.error || "Failed to load proposals.")
      return
    }
    setProposalsFor({ job, proposals: data.proposals })
  }

  if (user === undefined) return <main className="container"><p className="meta">Loading…</p></main>

  if (!user) {
    return (
      <main className="container">
        <div className="login-wrap card">
          <h2>💼 GigLance</h2>
          <p className="meta" style={{ marginBottom: 14 }}>
            Escrow-backed freelance marketplace. Seeded accounts: sara@giglance.test (client), nadia@giglance.test (freelancer), admin@giglance.test — password printed by <code>npm run setup</code>. Or create an account.
          </p>
          <div className="row" style={{ marginBottom: 12 }}>
            <button className={mode === "login" ? "primary" : "ghost"} onClick={() => setMode("login")}>Sign in</button>
            <button className={mode === "signup" ? "primary" : "ghost"} onClick={() => setMode("signup")}>Create account</button>
          </div>
          <form onSubmit={submitAuth}>
            {mode === "signup" && (
              <div className="row" style={{ marginBottom: 10 }}>
                <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="freelancer">I'm a freelancer</option>
                  <option value="client">I'm hiring</option>
                </select>
              </div>
            )}
            <div className="row">
              <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1, minWidth: 170 }} />
              <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ flex: 1, minWidth: 130 }} />
              <button className="primary" type="submit">{mode === "login" ? "Sign in" : "Join"}</button>
            </div>
          </form>
          {error && <div className="error-box">⛔ {error}</div>}
        </div>
      </main>
    )
  }

  const tabs: [Tab, string][] = [
    ["jobs", "📋 Jobs"],
    ["contracts", "🤝 Contracts"],
  ]
  if (user.role === "admin") tabs.push(["disputes", "⚖️ Disputes"])
  tabs.push(["reviews", "⭐ My reviews"])

  return (
    <main className="container">
      <div className="topbar">
        <div>
          <h1>💼 GigLance</h1>
          <div className="sub">
            {user.name} <Badge value={user.role} /> {myReviews.averageRating != null && <span className="stars">{stars(Math.round(myReviews.averageRating))}</span>}
          </div>
        </div>
        <button className="ghost" onClick={async () => { await fetch("/api/auth", { method: "DELETE" }); setUser(null) }}>Sign out</button>
      </div>

      <div className="tabs">
        {tabs.map(([t, label]) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => { setTab(t); setError(null); setNotice(null) }}>{label}</button>
        ))}
      </div>

      {error && <div className="error-box">⛔ {error}</div>}
      {notice && <div className="ok-box">✅ {notice}</div>}

      {tab === "jobs" && (
        <>
          {user.role === "client" && (
            <div className="card">
              <h2>Post a job</h2>
              <form
                onSubmit={async (e) => {
                  e.preventDefault()
                  const ok = await call("/api/jobs", "POST", { title: jTitle, description: jDesc, budgetCents: Math.round(Number(jBudget) * 100) })
                  if (ok) { setJTitle(""); setJDesc(""); setJBudget(""); setNotice("Job posted.") }
                }}
              >
                <div className="row" style={{ marginBottom: 10 }}>
                  <input placeholder="Title" value={jTitle} onChange={(e) => setJTitle(e.target.value)} style={{ flex: 2, minWidth: 200 }} />
                  <input type="number" min={5} step={1} placeholder="Budget ($)" value={jBudget} onChange={(e) => setJBudget(e.target.value)} style={{ width: 120 }} />
                </div>
                <textarea placeholder="Describe the work…" value={jDesc} onChange={(e) => setJDesc(e.target.value)} />
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="primary" type="submit" disabled={!jTitle.trim() || !jDesc.trim() || !jBudget}>Post job</button>
                </div>
              </form>
            </div>
          )}

          <div className="card">
            <h2>{user.role === "client" ? "My postings" : user.role === "admin" ? "All jobs" : "Open jobs"} ({jobs.length})</h2>
            <table>
              <thead><tr><th>Job</th><th>Budget</th><th>Client</th><th>Proposals</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td><strong>{j.title}</strong><div className="meta">{j.description.slice(0, 110)}{j.description.length > 110 ? "…" : ""}</div></td>
                    <td>{fmt(j.budgetCents)}</td>
                    <td>{j.clientName}</td>
                    <td>{j.proposalCount}</td>
                    <td><Badge value={j.status} />{j.myProposalStatus && <div style={{ marginTop: 4 }}><Badge value={j.myProposalStatus} /></div>}</td>
                    <td>
                      {user.role === "client" && j.proposalCount > 0 && <button className="ghost" onClick={() => openProposals(j)}>Proposals</button>}
                      {user.role === "freelancer" && j.status === "open" && !j.myProposalStatus && (
                        <button className="ghost" onClick={() => { setBidFor(j); setBidAmount(String(j.budgetCents / 100)); setBidLetter("") }}>Bid</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {bidFor && user.role === "freelancer" && (
            <div className="card">
              <div className="topbar">
                <h2 style={{ marginBottom: 0 }}>Bid on “{bidFor.title}”</h2>
                <button className="ghost" onClick={() => setBidFor(null)}>Close</button>
              </div>
              <form
                style={{ marginTop: 12 }}
                onSubmit={async (e) => {
                  e.preventDefault()
                  const ok = await call("/api/proposals", "POST", { jobId: bidFor.id, bidCents: Math.round(Number(bidAmount) * 100), coverLetter: bidLetter })
                  if (ok) { setBidFor(null); setNotice("Proposal submitted.") }
                }}
              >
                <div className="row" style={{ marginBottom: 10 }}>
                  <input type="number" min={5} step={1} value={bidAmount} onChange={(e) => setBidAmount(e.target.value)} style={{ width: 130 }} title="Your bid ($)" />
                  <span className="meta">posted budget: {fmt(bidFor.budgetCents)}</span>
                </div>
                <textarea placeholder="Cover letter — why you?" value={bidLetter} onChange={(e) => setBidLetter(e.target.value)} />
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="primary" type="submit" disabled={!bidLetter.trim() || !bidAmount}>Submit proposal</button>
                </div>
              </form>
            </div>
          )}

          {proposalsFor && user.role === "client" && (
            <div className="card">
              <div className="topbar">
                <h2 style={{ marginBottom: 0 }}>Proposals — {proposalsFor.job.title}</h2>
                <button className="ghost" onClick={() => setProposalsFor(null)}>Close</button>
              </div>
              {proposalsFor.proposals.map((p) => (
                <div key={p.id} style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <div>
                      <strong>{p.freelancerName}</strong>{" "}
                      {p.freelancerRating != null ? (
                        <span className="meta"><span className="stars">{stars(Math.round(p.freelancerRating))}</span> {p.freelancerRating} ({p.freelancerReviewCount})</span>
                      ) : (
                        <span className="meta">no reviews yet</span>
                      )}{" "}
                      <Badge value={p.status} />
                    </div>
                    <div><strong>{fmt(p.bidCents)}</strong></div>
                  </div>
                  <div className="note-body">{p.coverLetter}</div>
                  {p.status === "pending" && proposalsFor.job.status === "open" && (
                    <div className="row" style={{ marginTop: 8 }}>
                      <button
                        className="primary"
                        onClick={async () => {
                          const ok = await call("/api/proposals", "PATCH", { proposalId: p.id, action: "accept" })
                          if (ok) { setProposalsFor(null); setNotice("Proposal accepted — contract created. Fund escrow from the Contracts tab."); setTab("contracts") }
                        }}
                      >
                        Accept → create contract
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "contracts" && (
        <div className="card">
          <h2>{user.role === "admin" ? "All contracts" : "My contracts"} ({contracts.length})</h2>
          {contracts.length === 0 && <p className="meta">Nothing yet — contracts appear when a proposal is accepted.</p>}
          {contracts.map((c) => {
            const isClient = c.clientId === user.id
            const isFreelancer = c.freelancerId === user.id
            const draft = reviewDraft[c.id] ?? { rating: 5, comment: "" }
            const reviewable = ["completed", "refunded", "split"].includes(c.status) && (isClient || isFreelancer) && !c.myReviewDone
            return (
              <div key={c.id} style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div>
                    <strong>{c.jobTitle}</strong> <Badge value={c.status} />
                    <div className="meta">{c.clientName} (client) · {c.freelancerName} (freelancer) · opened {fmtDate(c.createdAt)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <strong>{fmt(c.amountCents)}</strong>
                    <div className="meta">fee {fmt(c.feeCents)} · payout {fmt(c.amountCents - c.feeCents)}</div>
                  </div>
                </div>

                {c.paymentRef && <div className="meta" style={{ marginTop: 6 }}>escrow <code>{c.paymentRef}</code>{c.payoutRef && <> · payout <code>{c.payoutRef}</code></>}{c.refundRef && <> · refund <code>{c.refundRef}</code></>} · provider <Badge value={c.provider ?? "—"} /></div>}
                {c.deliverableNote && <div className="note-body">📦 {c.deliverableNote}</div>}
                {c.dispute && (
                  <div className={c.dispute.status === "open" ? "error-box" : "ok-box"}>
                    ⚖️ Dispute by {c.dispute.openedByName}: {c.dispute.reason}
                    {c.dispute.status === "resolved" && <div className="meta" style={{ marginTop: 4 }}>Resolved: {c.dispute.resolution} {c.dispute.note ? `— ${c.dispute.note}` : ""}</div>}
                  </div>
                )}

                <div className="row" style={{ marginTop: 10 }}>
                  {isClient && c.status === "pending_funding" && (
                    <>
                      <button className="primary" onClick={async () => { const r = await call("/api/contracts", "PATCH", { id: c.id, action: "fund" }); if (r) setNotice(`Escrow funded (${r.paymentRef}). Money is held until you approve delivery.`) }}>Fund escrow {fmt(c.amountCents)}</button>
                      <button className="ghost" onClick={() => call("/api/contracts", "PATCH", { id: c.id, action: "cancel" })}>Cancel</button>
                    </>
                  )}
                  {isFreelancer && c.status === "funded" && (
                    <form
                      className="row"
                      style={{ flex: 1 }}
                      onSubmit={async (e) => {
                        e.preventDefault()
                        const ok = await call("/api/contracts", "PATCH", { id: c.id, action: "deliver", note: actionNote[c.id] })
                        if (ok) setNotice("Delivered — waiting for client approval.")
                      }}
                    >
                      <input placeholder="Deliverable note (link, summary…)" value={actionNote[c.id] ?? ""} onChange={(e) => setActionNote({ ...actionNote, [c.id]: e.target.value })} style={{ flex: 1, minWidth: 220 }} />
                      <button className="primary" type="submit" disabled={!(actionNote[c.id] ?? "").trim()}>Deliver</button>
                    </form>
                  )}
                  {isClient && c.status === "delivered" && (
                    <button className="primary" onClick={async () => { const r = await call("/api/contracts", "PATCH", { id: c.id, action: "approve" }); if (r) setNotice(`Payout released: ${fmt(r.payoutCents as number)} to ${c.freelancerName}.`) }}>Approve → release {fmt(c.amountCents - c.feeCents)}</button>
                  )}
                  {(isClient || isFreelancer) && ["funded", "delivered"].includes(c.status) && (
                    <form
                      className="row"
                      onSubmit={async (e) => {
                        e.preventDefault()
                        const ok = await call("/api/contracts", "PATCH", { id: c.id, action: "dispute", note: actionNote[c.id] })
                        if (ok) setNotice("Dispute opened — an admin will resolve it.")
                      }}
                    >
                      <input placeholder="Dispute reason…" value={actionNote[c.id] ?? ""} onChange={(e) => setActionNote({ ...actionNote, [c.id]: e.target.value })} style={{ minWidth: 180 }} />
                      <button className="ghost" type="submit" disabled={!(actionNote[c.id] ?? "").trim()}>⚖️ Dispute</button>
                    </form>
                  )}
                </div>

                {reviewable && (
                  <form
                    className="row"
                    style={{ marginTop: 10 }}
                    onSubmit={async (e) => {
                      e.preventDefault()
                      const ok = await call("/api/reviews", "POST", { contractId: c.id, rating: draft.rating, comment: draft.comment })
                      if (ok) setNotice("Review posted.")
                    }}
                  >
                    <select value={draft.rating} onChange={(e) => setReviewDraft({ ...reviewDraft, [c.id]: { ...draft, rating: Number(e.target.value) } })}>
                      {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{stars(n)}</option>)}
                    </select>
                    <input placeholder={`Review ${isClient ? c.freelancerName : c.clientName}…`} value={draft.comment} onChange={(e) => setReviewDraft({ ...reviewDraft, [c.id]: { ...draft, comment: e.target.value } })} style={{ flex: 1, minWidth: 200 }} />
                    <button className="ghost" type="submit">Leave review</button>
                  </form>
                )}
                {c.myReviewDone && <div className="meta" style={{ marginTop: 6 }}>⭐ You reviewed this contract.</div>}
              </div>
            )
          })}
        </div>
      )}

      {tab === "disputes" && user.role === "admin" && (
        <div className="card">
          <h2>⚖️ Dispute desk ({disputes.filter((d) => d.status === "open").length} open)</h2>
          {disputes.map((d) => (
            <div key={d.id} style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <strong>{d.jobTitle}</strong> <Badge value={d.status} />
                  <div className="meta">{d.clientName} (client) vs {d.freelancerName} (freelancer) · opened by {d.openedByName} · {fmtDate(d.createdAt)}</div>
                </div>
                <div><strong>{fmt(d.amountCents)}</strong> <span className="meta">in escrow</span></div>
              </div>
              <div className="note-body">🗣️ {d.reason}</div>
              {d.deliverableNote && <div className="note-body">📦 {d.deliverableNote}</div>}
              {d.status === "open" ? (
                <div className="row" style={{ marginTop: 10 }}>
                  <input placeholder="Resolution note…" value={actionNote[d.id] ?? ""} onChange={(e) => setActionNote({ ...actionNote, [d.id]: e.target.value })} style={{ flex: 1, minWidth: 200 }} />
                  <button className="primary" onClick={() => call("/api/disputes", "PATCH", { id: d.id, resolution: "release", note: actionNote[d.id] })}>Release to freelancer</button>
                  <button className="ghost" onClick={() => call("/api/disputes", "PATCH", { id: d.id, resolution: "refund", note: actionNote[d.id] })}>Refund client</button>
                  <button className="ghost" onClick={() => call("/api/disputes", "PATCH", { id: d.id, resolution: "split", note: actionNote[d.id] })}>Split 50/50</button>
                </div>
              ) : (
                <div className="meta" style={{ marginTop: 8 }}>Resolved: <Badge value={d.resolution ?? ""} /> {d.note}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "reviews" && (
        <div className="card">
          <h2>⭐ Reviews about me {myReviews.averageRating != null && <span className="meta">— average {myReviews.averageRating}</span>}</h2>
          {myReviews.reviews.length === 0 && <p className="meta">No reviews yet — finish a contract to earn some.</p>}
          {myReviews.reviews.map((r) => (
            <div key={r.id} style={{ marginTop: 12 }}>
              <span className="stars">{stars(r.rating)}</span> <strong>{r.reviewerName}</strong> <span className="meta">{fmtDate(r.createdAt)}</span>
              {r.comment && <div className="note-body">{r.comment}</div>}
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
