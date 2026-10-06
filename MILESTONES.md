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

- [x] **M4 — Wallet & ledger foundation.** `Wallet` + `LedgerEntry` models,
      debit/credit service with row locking and idempotency keys, the
      `balance == sum(ledger)` invariant tested under real concurrency
      (vitest + the live dev database, not mocks). *Done 2026-10-06 — see
      `progress.md` for four real bugs the test suite caught, including a
      finding that changes M5's design (next item).*

- [x] **M5 — Draw rounds, entries, settlement.** Built on the
      decide-then-pay split designed in response to M4's finding: a fast
      lock-held "decide" step (shuffle, record outcomes, close/open
      rounds) followed by parallel, lock-free "pay" (crediting the 501
      winning/refunded wallets independently). 17 concurrency + money-math
      tests, all against the live dev database. *Done 2026-10-06 — see
      `progress.md` for the per-entry round-trip optimizations made along
      the way and the dev-vs-production latency finding from getting the
      slow tests green.*

- [x] **M6 — Wire the UI to real data.** Draw and Wallet pages replaced
      their static placeholders with real data from M3–M5 — real round
      state, real entries, real balance, real transaction history.
      Leaderboard stays placeholder *on purpose*: it genuinely has no real
      data source until M9's daily job exists, not an oversight. Mobile
      nav became a proper slide-out hamburger menu; errors across every
      page now render through a themed, per-error-code `ErrorAlert`
      instead of plain text. *Done 2026-10-06 — verified end-to-end via
      Playwright against the live dev database, including a real bug
      caught that way (see `progress.md`). Two things still open: live
      manual testing with the user and a friend as real entrants
      (in progress), and Cloudinary credentials still being filled in to
      replace the dev-mode avatar fallback.*

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
