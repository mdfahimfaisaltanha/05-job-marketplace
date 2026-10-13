import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "GigLance — Job & Freelance Marketplace",
  description:
    "Two-sided marketplace with Stripe Connect escrow, dispute resolution, and two-sided reviews.",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
