export type Role = "client" | "freelancer" | "admin"

export type SessionUser = {
  id: number
  name: string
  email: string
  role: Role
}

export type Job = {
  id: number
  clientId: number
  clientName: string
  title: string
  description: string
  budgetCents: number
  status: "open" | "in_progress" | "closed"
  proposalCount: number
  myProposalStatus?: string | null
  createdAt: string
}

export type Proposal = {
  id: number
  jobId: number
  freelancerId: number
  freelancerName: string
  freelancerRating: number | null
  freelancerReviewCount: number
  bidCents: number
  coverLetter: string
  status: "pending" | "accepted" | "rejected"
  createdAt: string
}

/**
 * Contract state machine:
 *
 *   pending_funding ─fund→ funded ─deliver→ delivered ─approve→ completed
 *        │                    │                │
 *        │cancel              └────dispute────┘
 *        ▼                            ▼
 *    cancelled                    disputed ─resolve→ completed | refunded | split
 */
export type ContractStatus =
  | "pending_funding"
  | "funded"
  | "delivered"
  | "disputed"
  | "completed"
  | "refunded"
  | "split"
  | "cancelled"

export type Contract = {
  id: number
  jobId: number
  jobTitle: string
  clientId: number
  clientName: string
  freelancerId: number
  freelancerName: string
  amountCents: number
  feeCents: number
  status: ContractStatus
  provider: "stripe" | "mock" | null
  paymentRef: string | null
  payoutRef: string | null
  refundRef: string | null
  deliverableNote: string | null
  dispute: Dispute | null
  myReviewDone: boolean
  createdAt: string
}

export type Dispute = {
  id: number
  contractId: number
  openedByName: string
  reason: string
  status: "open" | "resolved"
  resolution: "release" | "refund" | "split" | null
  note: string | null
  createdAt: string
}

export type Review = {
  id: number
  contractId: number
  reviewerName: string
  rating: number
  comment: string
  createdAt: string
}
