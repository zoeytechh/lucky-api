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

---

## 2026-10-05 — Visual identity: Owambe Jackpot

- Built a comparison artifact with three distinct, grounded visual directions (not generic SaaS defaults) for the Draw screen: **Danfo Ticket** (danfo-bus black/safety-yellow, stenciled ticket feel), **Aso-Oke Ledger** (indigo/gold, woven-stripe passbook feel), **Owambe Jackpot** (naira-green/gold, celebratory tombola-ring feel) — each rendered as a real mockup with the same content (wallet balance, round progress, entry CTA, daily leaderboard) plus explicit primary/secondary color roles and a themed loading indicator, so the choice could be made by comparison rather than description.
- **Chosen: Owambe Jackpot**, with an explicit requirement that it not read as AI-generated template output. Concrete commitments made (not just stated): colored surfaces throughout instead of white cards + drop shadows, no gradients/glassmorphism, the secondary coral accent spent in exactly one place (the CTA glow) rather than spread across badges/buttons, semantic state color (loss = muted rust) kept distinct from the brand secondary (coral) — those had been conflated in the original mockup and were fixed before implementing for real. Committed to a single dark theme with no light-mode variant, as a deliberate product decision (a light-mode jackpot theme would undercut the premise), not an oversight.
- Implemented in `lucky`: Tailwind v4 `@theme` token system (`ground`/`ground-raised`/`ink`/`primary`/`secondary`/`success`/`danger`), Anton (display) + Nunito Sans (body) via Google Fonts, PWA manifest colors updated to match. Built two reusable components — `RoundRing` (the circular draw-progress motif) and `Loader` (spinning drum-arc, respects `prefers-reduced-motion` via Tailwind's `motion-safe:`) — and restyled all four pages plus the nav shell.
- **Actually verified in a browser, not just built:** no project skill existed yet for running this app, so stood up a throwaway Playwright driver (headless Chromium, screenshotted all four routes, checked console for errors) rather than just trusting a clean `tsc`/`vite build`. That caught a real bug the build couldn't have: Anton's lowercase glyphs render much weaker than its uppercase ones, so mixed-case headings ("Wallet", "Today's Top 3") looked visually inconsistent with the bold caps treatment everywhere else (nav wordmark, CTA, ring numerals). Fixed by forcing `uppercase` on every Anton heading. Re-screenshotted to confirm before committing.

**Open items carried forward:**

- No project skill yet for running/screenshotting `lucky` — worth generating one (`/run-skill-generator`) if this verify-in-browser step recurs often, so it doesn't need rebuilding from scratch each time.
- Login page currently renders inside the main nav shell (showing wallet balance etc. even when "logged out") — fine as a static placeholder, but will need a proper logged-out layout once real auth (M3) exists.

**Next:** M3 — phone/OTP auth + mandatory avatar onboarding (see `MILESTONES.md`).

---

## 2026-10-05 — M3: phone/OTP auth, onboarding, profile

- **Data model:** `OtpCode` and `RefreshToken`, migrated against the real Neon database (first real migration run — `prisma migrate dev`, no shadow-database issues). Deviated from the plan's "OTP codes in Redis": put them in Postgres instead, same security properties (hashed, 5-minute expiry, 5-attempt limit, rate-limited to one request/60s per number), one fewer external dependency before Redis is otherwise needed (M9 BullMQ, M10 comment feed).
- **Session design:** short-lived access JWT (15 min) + a refresh token that's a signed JWT *and* separately stored hashed server-side — possession of a valid-looking JWT isn't enough, it has to match a non-revoked, non-expired DB row. Rotates on every refresh (old revoked, new issued); this is what let a real bug surface (below). Refresh token lives in an httpOnly cookie scoped to `/api/auth`; access token is never persisted client-side, only held in memory and restored via silent refresh on page load.
- **Avatar upload:** Cloudinary `upload_stream`, face-centered 512×512 crop, `multer` memory storage with a 5MB/JPEG-PNG-WEBP limit.
- **Dev-mode fallbacks, both clearly gated and commented:** fixed `123456` OTP code when `TERMII_API_KEY` is unset (the user asked for this explicitly, to make testing fast while no Termii account exists yet); inline base64 data-URL avatar when `CLOUDINARY_CLOUD_NAME` is unset. Both are real-integration-ready — just waiting on the accounts to exist. **Cloudinary credentials requested from the user, not yet provided** — once they land in `.env`, avatars switch from data-URLs to real hosted image URLs automatically, no code change needed.
- **Frontend:** real two-step phone/OTP `Login`, a new `Onboarding` page (the mandatory first-avatar gate), a new `Profile` page (change photo, edit name, phone display, logout) reachable from the navbar avatar. `App.tsx` became the route guard — loading/unauthenticated/incomplete-profile states redirect before the nav+`Outlet` ever render.

**Bugs caught by actually testing in a browser, not just trusting `tsc`/build** (headless Playwright, full flow each time: login → onboarding → avatar upload → authenticated → reload → profile → edit name → change photo → logout):

1. **React hooks-order violation.** `Login.tsx`/`Onboarding.tsx` had early `return <Navigate />` guards placed *before* their `useState` calls — React requires every hook to run unconditionally in the same order every render. Surfaced as "Rendered fewer hooks than expected" and broke navigation. Fixed by moving every guard clause to after all hook calls.
2. **Refresh-token rotation race.** React StrictMode double-invokes effects in dev; `AuthProvider`'s mount effect called `/api/auth/refresh` twice near-simultaneously, both carrying the same cookie token. The first request rotated it (revoked old, issued new); the second arrived already-revoked and got a 401. Not just a dev artifact — the same race could hit production under genuinely concurrent requests. Fixed with a shared in-flight-promise wrapper (`refreshSession()` in `api.ts`) so every caller shares one request instead of each firing its own.
3. **Mobile nav overlap.** The first nav redesign crammed wallet balance + avatar + a "Log out" text link into one top-bar row; at 420px width "Log out" wrapped and visually collided with the wallet amount. Caught in a screenshot, not a code review. Resolved (after a brief bottom-tab-bar detour that was reverted per direction) by moving logout off the navbar entirely — it now lives on the new Profile page, reached by tapping the avatar, which freed enough space for links + wallet + avatar to sit comfortably in one row.
4. **Global `cursor: pointer`** added for all buttons — browsers default `<button>` to `cursor: default`, not `pointer`, which read as broken/unpolished on every action button in the app.

**Open items carried forward:**

- **Cloudinary and Termii accounts still needed** — both flows are fully built and tested against their dev-mode fallbacks, but need real credentials in `lucky-api/.env` before this ships to real users.
- Refresh-token rotation has no grace-period/reuse-detection window (a legitimate concurrent-tab scenario in production could still hit the same race pattern bug #2 above was built to avoid, just from two real tabs instead of StrictMode). Noted as a future hardening item, not built now — the client-side fix covers the actual current architecture (single SPA instance).
- No project skill yet for running/screenshotting either app — the same gap noted last session, now hit twice.

**Next:** M4 — wallet & ledger foundation (see `MILESTONES.md`). Nothing past this point proceeds until the `balance == sum(ledger)` invariant is solid and tested under concurrency.

---

## 2026-10-06 — M4: wallet & ledger foundation

- **Data model:** `Wallet` (one per user, cached `balanceMinor`) + `LedgerEntry` (append-only, `idempotencyKey`-deduped), migrated against Neon. `postLedgerEntry` (ledger.service) does the insert + balance math; `wallet.service` owns the row-locking (`SELECT ... FOR UPDATE`) that makes it safe to call concurrently, plus `getOrCreateWallet` / `getSystemWallet`.
- **Real test suite, not a trust exercise:** vitest, running actual parallel transactions against the live dev database — not mocked. 8 tests: basic credit/debit math, insufficient-funds rejection, idempotency replay (single and under concurrency), and the two tests that actually prove the row lock works — 50 concurrent credits with zero lost updates, and 30 concurrent debits racing for only enough balance for 10, asserting *exactly* 10 succeed and the wallet never goes negative.

**This test suite earned its keep immediately — four real bugs found, not hypothetical ones:**

1. **Type mismatch in the lock query.** `wallets.id` is Postgres `text` (Prisma's default `String` mapping), not a native `uuid` column. An explicit `::uuid` cast on the query parameter made Postgres refuse the comparison (`operator does not exist: text = uuid`). Removed the cast.
2. **Prisma 7's `upsert()` isn't reliably atomic inside an existing interactive transaction, at least through the pg driver adapter.** Expected it to compile to `INSERT ... ON CONFLICT DO UPDATE`; under real concurrency it surfaced a raw unique-constraint violation instead. Tried a fallback — catch the violation, look up what the other transaction created — and hit a second, more fundamental issue: **one failed statement aborts the entire Postgres transaction**, so a fallback query in the same `catch` block fails too (`current transaction is aborted, commands ignored until end of transaction block`). The fix that's actually safe inside a transaction: raw `INSERT ... ON CONFLICT DO NOTHING` (never raises on conflict — 0 rows back, transaction stays healthy), falling back to a plain `SELECT` only when nothing was inserted. Applied to both `getOrCreateWallet` and `getSystemWallet`.
3. **Infrastructure sized for the happy path, not contention.** node-postgres's default pool (`max: 10`) and Prisma's default interactive-transaction budget (~2s to acquire a slot, 5s to complete) both turned out far too small the moment real concurrency showed up — failures that looked like correctness bugs were actually just connections and clocks too small for the queue, while the locking logic itself was right the whole time. Pool bumped to 50, transaction budget to a shared `runInTransaction()` helper (60s) that every money-moving call now goes through instead of raw `prisma.$transaction`, so this budget is decided once, not per call site.
4. **A finding that changes M5, not just a bug fixed here:** even after all three fixes above, 50 fully-serialized transactions through one row lock took **~30 seconds end to end** against live Neon. The plan's original M5 design serializes up to 1000 entries through a single draw round's row lock, settling synchronously inside the 1000th entry's transaction. Naive extrapolation from the measured number suggests that could take **minutes**, not seconds — not viable for a real user waiting on their entry to confirm. This needs an actual design pass before M5 implementation starts (a lighter critical section? external queue-based serialization instead of DB lock queuing? something else?), not just a bigger timeout. Flagged at the top of the M5 entry in `MILESTONES.md` so it can't be missed.

**Open items carried forward:**

- **M5's design needs rework before implementation**, per finding #4 above — this is now the single most important open item.
- Cloudinary and Termii accounts still needed (carried from M3).
- Refresh-token rotation grace-period/reuse-detection (carried from M3).
- No project skill yet for running/testing either app — carried forward again, now a recurring gap worth actually fixing rather than renoting a third time.

**Next:** resolve the M5 design question above, then build the draw round/entry/settlement module against whatever concurrency approach comes out of it.

---

## 2026-10-06 — M5: draw rounds, entries, decide-then-pay settlement

- **Design confirmed before building:** decide-then-pay, as laid out in response to M4's finding — a fast lock-held "decide" step (shuffle, record outcomes, close/open rounds, no wallet touched) followed by "pay" (crediting the 501 winning/refunded wallets) running after the lock is released, as independent per-wallet-locked transactions in parallel instead of serialized through the round lock. The plan document was updated with this design before implementation started, not after.
- **Data model:** `DrawRound` + `DrawEntry`, migrated against Neon with three hand-added constraints Prisma's schema language can't express — confirmed present in the database via direct query, not assumed from the migration SQL alone: a partial unique index (`one_open_round`, at most one OPEN round ever), and CHECK constraints bounding `entry_count` and `slot_number` to 1..1000.
- **Settlement math made general, not hardcoded:** `refundCount = ceil((n-1)/2)` derived from the actual entry count found, rather than fixed 500/499 constants. This means the exact same code and formula run correctly at the real 1000-entry production scale and at a small `DRAW_ROUND_SIZE` used in tests (12, set in `tests/setup.ts`) — the small-scale test is genuinely exercising production logic, not a parallel test-only calculation standing in for it.
- **Test suite:** 17 tests across `settlement.test.ts` (the decide step in isolation — partition math, payout math balancing, round state transitions) and `draw-entry.test.ts` (the full flow through real `placeEntry` calls — capacity under concurrency, overflow into the next round, idempotency replay, and real wallet balances after real parallel entries, not just entry-row bookkeeping).

**Getting from "code compiles" to "17/17 green" surfaced real things, same pattern as M4:**

1. **Per-entry round-trip count mattered more than expected.** The first full run of the two big entry-flow tests (12 and 17 concurrent entries) consistently hit a 75-second wall. Diagnosed, not just timed-out-and-moved-on: each entry was making ~17 sequential database round trips (lock round, check+insert entry, then three wallet movements — stake debit, fee debit, system fee credit — each itself 4-5 round trips). Cut this to ~12 via two changes: merged each idempotency check into its insert using raw `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` (one round trip instead of a separate `findUnique` before the insert — applied to both `ledger.service.postLedgerEntry` and the draw entry insert itself), and memoized the SYSTEM user's id in-process (`wallet.service.ts`) since it never changes once created, cutting a per-entry lookup to zero round trips after the first one this process ever makes.
2. **Even after that, the same two tests still hit the wall — and this time it wasn't a bug.** Measured it directly: ~12 round trips/entry × this dev machine's actual latency to Neon's us-east-2 region (measured around 500-600ms/round trip, not the ~150-300ms assumed when the M4 timeout budgets were first set) lands right at 75s for 12-17 serialized entries. This is real network RTT from a local dev machine to a remote database region, not a correctness problem — a production deploy co-located with its database (same region) wouldn't pay this cost, the same way the smaller wallet-only tests already run fast. Addressed by sizing `vitest.config.ts`'s timeouts to match measured reality (180s/60s) rather than chasing further query-count reduction against a cost that's bounded by physical distance, not code. Worth remembering when choosing a hosting region for `lucky-api` once it's actually deployed: put it in the same region as the Neon database.
3. **A test-isolation bug, not a product bug:** `settlement.test.ts` originally assumed it could freely create a fresh OPEN round for each test — worked in isolation, broke the moment any other test (or manual testing) had ever left a round open, which the partial unique index correctly refused. Fixed by having the test force-close whatever's currently open before creating its own isolated round — the constraint was doing exactly its job.

Also deepened `/api/health` while reviewing Foundation layer 13's audit checklist (per the user's request) — it was a shallow check (server responds, nothing more), exactly the pitfall layer 13 itself warns about. Now runs `SELECT 1` and reports 503 if the database is unreachable.

**Open items carried forward:**

- Cloudinary and Termii accounts still needed (carried from M3).
- Refresh-token rotation grace-period/reuse-detection (carried from M3).
- No project skill yet for running/testing either app — carried forward a third time; genuinely worth fixing now rather than renoting again.
- Foundation layer 13 audit (uptime monitoring, backup testing, rollback, recovery docs) scored 1/6 — paused at the user's direction to continue milestone work first; revisit once the milestones are further along, before any real deployment.
- Deploy `lucky-api` in the same region as the Neon database once real hosting is set up — see finding #2 above.

**Next:** M6 — wire the UI to real data. Direction set by the user for this milestone: mobile nav becomes a proper slide-out/hamburger menu, interactions lean on Motion throughout (draw-result reveals, transitions, tap feedback) built from the Owambe Jackpot system's own motifs, not generic animation.
