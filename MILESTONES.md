# Milestones — Lucky

The roadmap we're building to, in order. Each one gates the next — nothing
starts a milestone until the one before it is solid and tested. See
`progress.md` for the detailed log of what actually happened at each step,
and the implementation plan for full technical detail on each.

- [x] **M1 — Repo & app scaffold.** `lucky` (React/Vite/TS PWA) and
      `lucky-api` (Express/TS/Prisma) as separate repos, Neon Postgres
      wired, base `User` model, both apps building clean. *Done 2026-10-05.*

- [x] **M2 — Visual identity.** Owambe Jackpot direction chosen and applied:
      design tokens, typography, the `RoundRing` and `Loader` components,
      all four screens restyled and verified rendering correctly.
      *Done 2026-10-05.*

- [x] **M3 — Auth: phone/OTP + mandatory avatar onboarding.** OTP
      request/verify/refresh/logout/me, rotating JWT sessions, the
      onboarding avatar gate, and a Profile page (photo, name, logout).
      Verified end-to-end in a real browser. *Done 2026-10-05 — with one
      open item: Termii and Cloudinary are both still running on their
      dev-mode fallbacks (fixed OTP code, inline data-URL avatar) because
      neither account exists yet. Code is ready for both; swap in real
      credentials in `lucky-api/.env` before real users touch this.*

- [ ] **M4 — Wallet & ledger foundation.** `Wallet` + `LedgerEntry` models,
      debit/credit service with row locking and idempotency keys, the
      `balance == sum(ledger)` invariant tested under concurrency. Nothing
      past this point proceeds until it's solid.

- [ ] **M5 — Draw rounds, entries, settlement.** The 1000-entry rolling
      round, row-locked entry flow, the CSPRNG shuffle/settlement
      algorithm. Highest-risk module — gated by its own concurrency and
      money-math test suite before anything is built on top of it.

- [ ] **M6 — Wire the UI to real data.** Replace the static placeholder
      numbers on Draw/Wallet/Leaderboard with live data from M3–M5.

- [ ] **M7 — Paystack deposits.** Dedicated virtual accounts + card
      checkout, webhook-verified wallet crediting. Real money can enter
      the system for the first time.

- [ ] **M8 — Paystack withdrawals.** Bank account resolution, transfer
      initiation, webhook-driven completion/failure/reversal handling.

- [ ] **M9 — Daily leaderboard job.** BullMQ/Redis repeatable cron, the
      idempotent top-3 settlement and prize crediting.

- [ ] **M10 — Live comment feed.** Socket.IO + Redis adapter, JWT
      handshake auth, rate-limited comment posting.

- [ ] **M11 — Hardening.** Standing reconciliation cron, settlement
      audit-log viewer, admin tooling, rate limiting, webhook/reconciliation
      alerting, real PWA icon artwork (currently placeholders).

- [ ] **M12 — Phase-2 compliance.** BVN/NIN KYC flow, KYC-tiered
      withdrawal limits. Required before scaling past a pilot audience —
      alongside confirming Nigerian gambling/lottery licensing, which is a
      legal prerequisite tracked outside this list.
