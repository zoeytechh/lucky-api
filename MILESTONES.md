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

- [x] **M6.5 — Live draw reveal (Socket.IO pulled forward from M10).** The
      user asked directly whether every connected viewer sees the
      settlement reveal in real time, and the honest answer at the time
      was no — so M10's Socket.IO infrastructure was pulled forward rather
      than shipping a polling workaround. `lucky-api` now broadcasts
      `round:progress` (every fresh entry) and `round:settled` (winner
      slot + next round) over a plain in-memory Socket.IO server attached
      to the same HTTP server (no Redis adapter — unnecessary for Render's
      single instance; revisit only if that changes); `lucky` connects via
      `socket.io-client` and drives the `DrawRoll` reveal component for
      every viewer, not just whoever placed the final entry. Also added: a
      global "recent entries" feed (name/id + slot number, not just the
      viewer's own entries) with a 3-item widget and a dedicated full
      paginated page, and a deliberate 30–60s suspense delay before the
      winner number appears (the backend already knows the outcome the
      instant the round fills; revealing it immediately read as
      anticlimactic). *Done 2026-10-07 — see `progress.md` for a real
      concurrency bug this surfaced and fixed, and the new
      `draw-socket.test.ts` suite verifying the broadcast itself end to
      end against a real socket.io-client, not just the settlement logic
      underneath it. Narrows M10 below to just what's left for the comment
      feed specifically (Redis adapter, JWT handshake auth, persistence,
      rate limiting) — the server/client socket plumbing itself already
      exists.* **Extended 2026-10-08:** only one round may be open at a
      time — the next round exists but is locked from entries until the
      current winner reveal's `entriesOpenAt` passes, and a late-joining
      viewer's first load now reconstructs that same in-progress reveal
      (winner modal included) instead of a blank new round. See
      `progress.md` for the server-authoritative `revealAt` timing design
      and the end-to-end browser verification.

- [ ] **M7 — Paystack deposits.** Dedicated virtual accounts + card
      checkout, webhook-verified wallet crediting. Real money can enter
      the system for the first time.

- [ ] **M8 — Paystack withdrawals.** Bank account resolution, transfer
      initiation, webhook-driven completion/failure/reversal handling.

- [ ] **M9 — Daily leaderboard job.** BullMQ/Redis repeatable cron, the
      idempotent top-3 settlement and prize crediting.

- [x] **M10 — Live comment feed.** `DrawComment` model, an authenticated
      `/comments` Socket.IO namespace (JWT handshake + the same mandatory-
      avatar profile-completeness gate every other authenticated route
      has), an 8s per-user in-memory rate limit, `GET /api/comments/recent`
      for the one-time REST backfill, and a `CommentFeed` component on the
      Draw page — fixed-height, scrollable, capped at the 100 most recent,
      Motion entrance animations on each new comment. No Redis adapter:
      same reasoning as M6.5's round-broadcast socket (Render runs a
      single instance) — revisit only if that changes, not a gap. *Done
      2026-10-07 — see `progress.md` for a real bug caught in the test
      suite's own helper (an explicit `avatarUrl: null` was silently
      replaced by a `??` fallback, meaning the first run of the
      incomplete-profile test wasn't actually testing what it claimed).*

- [ ] **M11 — Hardening.** Standing reconciliation cron, settlement
      audit-log viewer, admin tooling, rate limiting, webhook/reconciliation
      alerting, real PWA icon artwork (currently placeholders). Also now:
      a dedicated test database — `npm test` currently shares the live
      Neon database with dev *and* production, and on 2026-10-08 a
      test's own cleanup logic force-settled a real, live production
      round mid-session (caught and recovered by hand; see progress.md).

- [ ] **M12 — Phase-2 compliance.** BVN/NIN KYC flow, KYC-tiered
      withdrawal limits. Required before scaling past a pilot audience —
      alongside confirming Nigerian gambling/lottery licensing, which is a
      legal prerequisite tracked outside this list.
