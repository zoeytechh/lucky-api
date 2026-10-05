# Progress Log — Lucky (Raffle Draw App)

This file is a running log of what's been done, in order. Each build step gets an entry when it's completed — not a plan, a record of what actually happened. See `docs/PRD.pdf` for the full feature spec and the approved implementation plan for architectural detail.

---

## 2026-10-05 — Planning & Design

- Defined the core raffle mechanic: 1000-entry rolling draw rounds, ₦1,200/entry (₦1,000 stake + ₦200 platform fee), 1 winner (₦500,000), 500 refunded, 499 lose their stake.
- Defined the daily top-3 leaderboard (ranked by total ₦ spent that day, entry count as tie-break), paid from platform fee revenue.
- Explored a gamification/mini-game layer (missions, a Babylon.js "Draw Floor" visual draw-reveal, inspired by the viral Nigerian browser game *Lagos Life*) — **decided against it**: the ₦1,000-to-win mechanic is compelling enough on its own, so the game/mission layer was dropped from scope.
- Settled the stack: React + Vite PWA frontend (Motion for animation, Swiper for carousels where useful) + Node/Express + Prisma backend + Neon (serverless Postgres) + BullMQ/Redis for the daily leaderboard job + Paystack for deposits/withdrawals + custom phone/OTP auth.
- Designed the money model: append-only double-entry ledger, a `SYSTEM` wallet for company revenue, Postgres row-locking (`SELECT ... FOR UPDATE` on the single open round) to guarantee exactly 1000 entries per round with no race conditions, CSPRNG shuffle for winner/refund/loss selection, synchronous in-transaction settlement.
- Added a live comment feed (Socket.IO + Redis adapter, JWT handshake auth) as a lightweight social layer — explicitly scoped as non-financial and built after the money flows are solid.
- Added a mandatory profile-picture requirement at onboarding (via Cloudinary) — a deliberate anti-bot/accountability measure for a real-money product; enforced via a `requireCompleteProfile` middleware gating wallet/draw/withdrawal routes.
- Full implementation plan written and approved: `C:\Users\HomePC\.claude\plans\gentle-munching-thimble.md`.
- Produced `docs/PRD.pdf` summarizing all features for reference/sharing.

**Open items carried forward (not blockers, tracked deliberately):**
- Nigerian gambling/lottery licensing (Lagos State Lotteries Board / National Lottery Regulatory Commission) — needs legal counsel before accepting real payments.
- Phase-2 KYC (BVN/NIN) for withdrawals beyond Paystack's own onboarding checks.
- Leaderboard prize tier amounts are placeholders pending a real business decision.

**Next:** scaffold `/client` (Vite+React+TS+PWA) and `/server` (Express+TS+Prisma), wire up Neon, and build the ledger/wallet foundation (step 2 of the build order) — nothing else proceeds until that's solid.
