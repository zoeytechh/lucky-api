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

---

## 2026-10-05 — Scaffold: repos, client, server

- Split into two separate repos per decision: **`lucky`** (React+Vite+TS PWA client) and **`lucky-api`** (Express+TS+Prisma backend), each with its own git history. `progress.md` lives in `lucky-api`.
- Neon Postgres project created (plain database only — skipped Neon Auth/Object Storage/Functions/AI Gateway, none of which fit this app's design: auth is custom phone/OTP owned by Express, photos go to Cloudinary, no serverless functions or AI use).
- **`lucky-api`**: Express app bootstrap (`src/index.ts`, health check route), Prisma `User` model (step 1 scope — phone, avatar, role, kyc status), `.env.example` template, CORS scoped to the client origin.
  - Hit Prisma's version situation head-on: `prisma@latest` resolves to `8.0.0-rc.20` (a release candidate), so pinned to **7.10.0**, the last stable release.
  - Prisma 7 turned out to be a real architecture change from what most docs assume: the datasource `url` no longer lives in `schema.prisma` (moved to `prisma7.config.ts`), and `PrismaClient` now requires an explicit driver adapter at runtime rather than connecting implicitly. Installed `@prisma/adapter-pg` + `pg` to provide that. The IDE's Prisma extension was visibly out of sync with this (flagged a valid Prisma 7 schema as an error) — flagged this tradeoff explicitly; decision was to stay on Prisma 7 anyway.
  - TypeScript config needed `module`/`moduleResolution: "nodenext"` (not classic `"node"`) for modern package `exports` maps (e.g. `dotenv/config`) to resolve correctly.
  - **Caught and fixed a real secret leak before it shipped:** a live Neon connection string (with real credentials) ended up pasted into `.env.example` — the *committed* template file, not the gitignored `.env`. Moved the real string to `.env` only and restored `.env.example` to placeholders, before the first commit. No commit/push had happened yet, so nothing was ever exposed in git history.
- **`lucky`**: Vite React TS app, Tailwind CSS v4 wired in (`@tailwindcss/vite`), `vite-plugin-pwa` configured (manifest, service worker, API routes excluded from caching), routing via `createBrowserRouter` inlined in `main.tsx` (per direction — not a separate router file), placeholder pages for Draw/Wallet/Leaderboard/Login, a typed `apiFetch` client stub pointed at the Express backend. Stripped the default Vite template boilerplate (demo assets, counter button, template CSS).
  - Placeholder 1×1 PWA icons added so the manifest/build doesn't break — **flagged as needing real branded artwork before launch.**
- Both apps build and type-check cleanly. Both repos initialized, committed, and pushed to GitHub (`zoeytechh/lucky`, `zoeytechh/lucky-api`) — hit a permissions error on the first push attempt (wrong GitHub account had access), resolved on the user's end, retried successfully.

**Open items carried forward:**
- Real PWA icon artwork (currently 1×1 placeholders).
- `npm audit` flags 4 high-severity advisories, all transitive through Prisma's own CLI tooling (`@prisma/config` → `deepmerge-ts`, `mysql2`) — not in any code path this app actually uses (Postgres-only, no MySQL). The suggested fix would force a downgrade to Prisma 6, which conflicts with the decision to stay on Prisma 7 — left as-is, noted for periodic re-check as Prisma patches these upstream.
- Redis not yet provisioned (needed before BullMQ/leaderboard job and the Socket.IO comment feed can be built — not blocking the current step).

**Next:** build the ledger/wallet foundation (Wallet + LedgerEntry models, debit/credit service with row locking, idempotency-key handling) — step 2 of the build order. Nothing after this proceeds until it's solid and tested.
