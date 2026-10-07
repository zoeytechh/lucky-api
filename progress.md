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

---

## 2026-10-06 — M6: wire Draw/Wallet to real data, mobile nav, themed errors, Render deploy fix

- **Backend:** new HTTP surface M4/M5's service layer never had — `GET /api/draw/current`, `POST /api/draw/entries`, `GET /api/draw/entries` (the user's own, with outcome), `GET /api/wallet`, `GET /api/wallet/transactions`. Error responses now carry a machine-readable `code` alongside `message` (`INSUFFICIENT_BALANCE`, `OTP_EXPIRED`/`OTP_INVALID`/`OTP_RATE_LIMIT`/`OTP_TOO_MANY_ATTEMPTS`, `VALIDATION_ERROR`) so the frontend can render tailored copy instead of parsing message strings — the user specifically asked for "industry standard" per-error-type display, not a generic red line.
- **Frontend:** Draw and Wallet pages replaced their static placeholders with the real thing — round state, entry submission, wallet balance, transaction history. New `WalletContext` (mirrors `AuthContext`'s pattern) keeps balance in sync across the nav, Draw, and Wallet pages. Mobile nav became a proper slide-out hamburger menu (Motion spring transition), inline links preserved above the `sm` breakpoint. Every page's plain red error text replaced with a themed `ErrorAlert` component — icon + title + message + optional action link, mapped per error code.

**Two real bugs caught by actually testing in a browser against the live backend, not trusting a clean build:**

1. **Wallet balance stuck on `—` forever after onboarding.** `WalletContext`'s fetch effect depended only on auth `status`, which becomes `'authenticated'` at OTP-verify time — *before* onboarding/avatar upload. So the very first fetch correctly got rejected with a 403 (`requireCompleteProfile`), and nothing ever re-triggered it once the profile actually completed, since `status` itself doesn't change again. Fixed by also depending on whether the profile is complete (`user.avatarUrl`).
2. **A test-script bug that looked like a session bug at first:** reusing a saved Playwright session to test the funded-entry path kept landing back on the login page. Root cause: the test saved its session snapshot mid-flow, then kept navigating in the *same* browser afterward — each full page load silently rotates the refresh token (by design, per M3), so the snapshot taken earlier was already stale by the time it got reused. Fixed by saving the snapshot last, not mid-script. Not an app bug, but a good reminder of how easy it is to shoot yourself with single-use rotating tokens even as the one writing the test.

**Also landed this session:**

- **Deployment fix, caught from the user's first real Render attempt:** the build failed with a wall of TypeScript errors (`Cannot find module '../generated/prisma/client'`, plus several seemingly-unrelated `implicit any` and `string|null` errors). Root cause: `src/generated/prisma` is gitignored, so a fresh clone has no generated client at all — everything else was cascading noise from that one missing piece, confirmed by reproducing it locally (deleted the generated client, ran the real build, got the exact same error shape) and fixing it at the source: `prisma generate` now runs as part of `npm run build`, not left to an assumed postinstall hook. Rebuilt clean afterward with zero other changes needed.
- Deepened `/api/health` to check the database, not just that the server responds (per the Foundation layer-13 review).
- `DRAW_ROUND_SIZE` env override (already built for tests) now also used to let the user manually test the full draw/settlement flow with a handful of real entries instead of needing 1000 — currently set to 4 in local `.env`, with two throwaway filler accounts seeded via the new `scripts/seed-filler-entries.ts` so the user and a friend can be the entrants who actually complete a round themselves. **This is a local-only `.env` setting — never appropriate outside manual testing, and `.env` is gitignored so it can't accidentally ship.**
- Removed `lucky/.env.example` per the user's explicit request after discussing the tradeoff (it was the only piece of that env setup actually tracked in git — a fresh clone now has no record of needing `VITE_API_URL` — acceptable here since nothing in that file is sensitive or hard to rediscover).

**Open items carried forward:**

- Cloudinary credentials — the user is actively filling these into `.env` as of this session; not yet complete (cloud name and secret still blank as of this entry). Once done, needs a real verification (upload once, upload again, confirm in the Cloudinary dashboard that it's the same asset overwritten via `public_id`+`overwrite:true`, not two separate uploads) — not just assumed from config.
- Termii account (carried from M3).
- Refresh-token rotation grace-period/reuse-detection (carried from M3/M4).
- No project skill yet for running/testing either app — carried forward a fourth time.
- Foundation layer 13 audit — still paused, revisit before any real deployment.
- `DRAW_ROUND_SIZE=4` in local `.env` must be removed (or left unset) before anything resembling production use.
- Render deployment in progress with the user — build fix shipped, env var configuration and (possibly) `prisma migrate deploy` against whatever database Render points at are the likely next steps.

**Next:** finish the live manual test (user + a friend as real entrants completing round 167), then M7 — Paystack deposits, the first milestone where real money can enter the system.

---

## 2026-10-06 — First real deployment: Vercel (`lucky`) + Render (`lucky-api`)

Live at `lucky-tan-ten.vercel.app` / `lucky-api-0hbe.onrender.com` by the end of this session. Three real deploy issues found and fixed, each diagnosed from actual evidence (response headers, the live JS bundle) rather than guessed at:

1. **Render build failure:** `src/generated/prisma` is gitignored, so a fresh clone has no Prisma client at all — surfaced as a wall of seemingly-unrelated TypeScript errors (missing module, implicit `any`, `string|null` mismatches). Reproduced locally by deleting the generated client and rebuilding, which confirmed all of it traced back to the one missing step. Fixed: `prisma generate` now runs as part of `npm run build`, not left to an assumed postinstall hook.
2. **Cross-domain refresh cookie:** `SameSite=Lax` never sends on a cross-site `fetch()` — fine in local dev (same "site" despite different ports), broken the moment client and API live on genuinely different domains (Vercel vs Render). Fixed: `SameSite=None` + `Secure` in production, verified the local-dev cookie (`Lax`, no `Secure`) was byte-for-byte unchanged after the change.
3. **CORS misconfigured, then a PWA cache gotcha on top of it:** `CLIENT_ORIGIN` wasn't set on Render at first (confirmed directly — `curl`'d the live health endpoint and read `access-control-allow-origin: http://localhost:5173` straight off the response). After setting it correctly, the user still saw the identical `localhost:4000` CORS error on both mobile and their own laptop Chrome. Diagnosed by fetching the actual deployed JS bundle directly — it already had the correct Render URL baked in, proving the server/build side was fine. The real cause: the service worker had already cached the earlier broken build from a prior visit, and kept serving it regardless of what Vercel now had live — exactly the kind of thing a PWA's offline-first caching is designed to do, which makes a one-time cache clear (site data / cookies) necessary after a fix like this. Resolved once the user cleared it.

**Open items carried forward:**

- Service worker update UX — right now a fixed bug can still appear "not fixed" to a user with a stale cached version until they manually clear site data. Worth a future improvement (e.g. a visible "new version available, refresh" prompt) so this isn't a recurring support question after every deploy; not built yet.
- `prisma migrate deploy` against Render's actual `DATABASE_URL` — not yet confirmed either way whether Render points at the same Neon database used throughout development (in which case this is moot, migrations are already applied) or a separate one (in which case it still needs doing).
- Everything else from the previous entry still stands (Cloudinary, Termii, refresh-token grace period, project skill, Foundation audit, `DRAW_ROUND_SIZE=4` must not ship as a real default).

**Next:** same as above — finish the live manual draw test, then M7.

---

## 2026-10-07 — M6.5: live draw reveal over Socket.IO (pulled forward from M10)

The user asked directly: "the moment the DRAW_ROUND_SIZE is complete, do all users see the animation of raffling real time?" The honest answer was no — the reveal was purely local to whoever's own request happened to settle the round. Presented two options (poll `/api/draw/current` on an interval, or pull M10's WebSocket infrastructure forward); the user chose WebSockets.

- **Backend:** `src/realtime/socket.ts` — a plain in-memory Socket.IO server attached to the same `http.Server` Express already uses (`src/index.ts` now builds its own `createServer(app)` instead of calling `app.listen` directly, so Socket.IO can share the port). No Redis adapter (Render runs one instance; the adapter is only needed to fan out across multiple), no handshake auth (round outcomes are already public — everyone sees who won). `settlement.service.decideSettlement` now returns what it decided (`winnerSlotNumber`, `nextRoundId`, `nextRoundNumber`) instead of discarding it; `draw.service.placeEntry` emits `round:progress` on every fresh (non-replay) entry and `round:settled` once, after the transaction has already committed — same "never emit from inside a transaction that could still roll back" rule the existing `payOutRound` call already followed.
- **A real regression caught before it shipped:** `placeEntry` is called directly (no HTTP server, no socket) by every integration test and by `scripts/seed-filler-entries.ts`. The first cut used `getIo()`, which throws if `initSocket()` never ran — would have broken the entire test suite and the filler script. Fixed by adding `tryGetIo()` (returns `null` instead of throwing) and using that in `draw.service.ts` — broadcasting is a best-effort side effect, not a correctness requirement, so entries must still work correctly with no socket server running at all.
- **Frontend:** new `useDrawSocket()` hook (`socket.io-client`, no auth, same public-broadcast reasoning as the backend) feeds `Draw.tsx`, which now renders the already-built `DrawRoll` component (rolling numbers, the viewer's own number in the secondary color, bubble-party winner reveal) instead of the old static `RoundRing`. Every connected viewer's progress ring now advances on *every* entry system-wide, and the winner reveal fires for everyone at once, not just whoever placed the final entry.
- **Deliberate suspense delay:** per the user's follow-up request, the winner number no longer appears the instant `round:settled` arrives — the backend already knows the outcome the moment the round fills, but revealing it that fast read as anticlimactic. `Draw.tsx` now waits a random 30–60s (via `setTimeout`, re-rolled each round so it never feels mechanically identical) with the numbers still rolling before showing the winner, then holds the winner on screen for 4s before resetting to the newly-opened round.
- **"Recent entries" became a real social feed, not a private list.** The user noticed the existing widget only ever showed the *viewer's own* past entries with no way to tell whose slot was whose — not useful when testing with a friend who's also entering. New `GET /api/draw/recent-entries` (paginated via `limit`/`offset`) returns entries across *all* users with a display name (`fullName`, falling back to a masked `•••1234` phone suffix since `fullName` isn't mandatory at onboarding — only the avatar is). `Draw.tsx` shows the 3 most recent inline with a "View all" link to a new dedicated `/draw/recent` page (`RecentEntries.tsx`) with "Load more" pagination.

**Testing, same discipline as every prior milestone — real infrastructure, not mocks, and this surfaced a real bug:**

- Added `tests/integration/draw-socket.test.ts`: boots an actual `http.Server` + `initSocket()`, connects a real `socket.io-client`, fills a round through real `placeEntry` calls, and asserts the broadcast itself — exactly `ROUND_SIZE` `round:progress` events with the correct `entryCount`/`capacity`, exactly one `round:settled` with a valid winner slot and the correct next-round id/number, and that a replayed idempotency key does *not* re-broadcast. 2/2 passing.
- Running the full existing suite turned up a real, previously-undiscovered concurrency bug, not a flake: `tests/integration/draw-entry.test.ts`'s overflow test used a hardcoded `overflowBy = 5`, written when `ROUND_SIZE` was assumed to be the real 1000 (5 is trivially smaller than 1000). With the local `DRAW_ROUND_SIZE=4` testing override, 9 total entries (`4 + 5`) actually overflow across **three** rounds (4 + 4 + 1), not the two the test's assertions assumed — which also meant more than `ROUND_SIZE` requests ended up queued on the same round's lock at the moment it settled, a scenario the test was never actually exercising at the real production scale. Fixed by scaling the test itself (`overflowBy = Math.max(1, Math.min(5, ROUND_SIZE - 1))`) so it stays "a small overflow into a second round that itself stays open" regardless of which `ROUND_SIZE` is configured — the same "same formula/code, any scale" principle M5 already established for the settlement math itself, just missed in this one test's constant. Also saw a one-off balance-assertion failure in the same file when run with full file-level parallelism — reproduced in isolation (`--no-file-parallelism`) and it disappeared, confirming that one actually was ordinary cross-file flakiness against the shared dev database (the single-entry test doesn't account for its one entry happening to be the one that both fills *and wins* a round under heavy concurrent load from other test files) rather than a real bug — left as-is.
- Full suite after both fixes: **19/19 passing** (17 existing + 2 new), run both with and without `--no-file-parallelism`. Both `lucky-api` (`prisma generate && tsc`) and `lucky` (`tsc -b && vite build`, PWA service worker regenerating correctly) build clean.

**Open items carried forward:**

- Cloudinary verification still pending — credentials are filled in but the actual overwrite-on-reupload behavior hasn't been confirmed against the live dashboard (carried from M6).
- Termii account (carried from M3).
- Refresh-token rotation grace-period/reuse-detection (carried from M3/M4).
- No project skill yet for running/testing either app (carried forward again).
- Foundation layer 13 audit — still paused.
- `DRAW_ROUND_SIZE=4` must be set on Render's dashboard too if live multi-person testing continues there, and removed (or unset) before anything resembling production use either way.
- `socket.io-client` was added as a `lucky-api` *dev* dependency purely for `draw-socket.test.ts`; `npm install` flagged 4 high-severity advisories in its transitive tree — not investigated yet, worth a look before this becomes a habit.

**Next:** finish the live manual draw test with the user and their friend now that the reveal is actually live for both of them simultaneously, then M7 — Paystack deposits.

---

## 2026-10-07 — One entry per user per round, enforced backend-first

The user asked for the "ENTER — ₦1,200" button to disable once someone already has an entry in the round they're waiting on, explicitly specifying the backend as the real guard ("backend is more safer for control") with the frontend only reinforcing it. Until now nothing stopped a user from buying multiple slots in the same round — not a bug exactly, just never decided either way — this makes it an explicit one-entry-per-round rule.

- **Backend:** new `AlreadyEnteredError`, checked inside `placeEntryOnce` right after the round lock is acquired — `SELECT ... WHERE round_id = ? AND user_id = ?`, serialized correctly against any other concurrent attempt from the same user because it's inside the same lock that already serializes entries into that round. A replay of the *same* idempotency key still succeeds (existing retry/double-tap semantics unchanged); a genuinely different key for a user who already has an entry in this round is rejected before any wallet debit happens. `draw.routes.ts` maps it to `409 ALREADY_ENTERED`. `placeEntry`'s outer retry-once logic (for the first-boot round-creation race) now explicitly skips retrying this error — it's a real rejection, not a transient race, so retrying would just throw the same thing again.
- **Frontend:** `Draw.tsx` already computed `myCurrentEntry` (the user's entry in the currently-open round, used to feed `DrawRoll`'s "your number") — reused it to disable the Enter button and relabel it `YOU'RE IN — SLOT N` with a "Waiting for the draw to complete…" line, before the user ever gets a chance to hit the backend rule. `ErrorAlert` gained an `ALREADY_ENTERED` variant for the case the backend rejection surfaces anyway (stale state, a second tab, etc).
- **Test:** new case in `draw-entry.test.ts` — drains the current round first (same pattern the capacity/overflow tests already use) so the user's one entry can't itself fill and settle the round, places one entry, then asserts a second distinct-key attempt throws `AlreadyEnteredError`, the wallet balance is unchanged (rejected before any debit), and exactly one entry row exists for that user in that round.

Full suite: **20/20 passing** (19 + this one). Both apps build clean.

**Next:** same as the entry above — live manual draw test, then M7.

---

## 2026-10-07 — Reveal reliability, pagination, past winners, balance animation

The user ran the first real live multi-person test (themselves + two filler accounts + a friend) and reported two things: the winner animation never appeared, and nobody appeared to get credited. Checked the database directly before touching any code — round 370 had, in fact, settled correctly and every wallet had been credited exactly right (winner +₦2,000, both refunded entrants +₦1,000 each, all with `settledAt` timestamps proving the credit went through). So the backend settlement/payout logic was never the problem — the bug was entirely on the frontend.

- **Root cause:** whoever's own entry fills the round gets the full settlement result (`winnerSlotNumber`, `nextRoundId`, `nextRoundNumber`) back synchronously in that same HTTP response — but `Draw.tsx`'s `handleEnter` ignored it and called `load()` immediately, which replaces `round` with the brand-new next round before the suspense window even starts. The reveal was relying entirely on the socket broadcast instead, which can race that same request's own socket handshake if the page had only just connected — exactly the failure mode that left the entrant who completed the round seeing nothing and a stale wallet balance (the balance *was* credited; the UI never refreshed it because the reveal that triggers that refresh never fired).
- **Fix:** `pendingSettlement` state is now fed by either source — the socket's `round:settled` event, or (new) `handleEnter` constructing the same shape directly from its own response when `roundSettled` is true. One shared effect drives the reveal regardless of which source fed it, guarded against double-processing if both arrive for the same round. `handleEnter` also stopped calling `load()` immediately on a settling entry — that's deferred until after the reveal's hold period, same as the socket-driven path, so the entrant who just completed the round sees the exact same full-ring/suspense/reveal sequence as everyone else instead of jumping straight to the next round.
- **Also fixed while in there:** `DrawRoll`'s rolling-numbers animation was unconditional any time there was no winner yet — including while entries were still being collected, reported separately as "the numbers are changing rapidly but the draw has not started" on both mobile and web. Now gated on `entered >= capacity`; before that it shows a static state (the viewer's own slot number if entered, or just the entry count if not).

**New: paginated history, requested explicitly as backend-driven numbered pages, not "load more" accumulation** (~100 rounds/day means this history grows indefinitely):

- `GET /api/draw/recent-entries` reworked from `limit`/`offset` to `page`/`pageSize` + a `total` count; `GET /api/draw/winners` (new) is the same shape filtered to `outcome: WON`. Both default to `pageSize=20` (unified after an initial ask for 50 on the winners page specifically — the user later asked for both pages to match). A shared `pagination()` helper in `draw.routes.ts` caps `pageSize` at 100.
- Both now also return each round's `openedAt` as `roundDate` — directly answers the user's request to "know the date for that round" in these lists without changing how rounds are numbered (no schema change, no risk to the sequential `roundNumber` other logic depends on — just surfaced the date that already existed on `DrawRound`).
- Frontend: new shared `Paginator` component (Prev/Next + a small window of page numbers around the current one, since a full page-number list isn't practical once history runs into dozens of pages), new `Winners.tsx` page (`/draw/winners`), `RecentEntries.tsx` converted from its old "Load more" append pattern to the same numbered-page pattern, both backed by one real backend request per page. `lib/date.ts` added a small `formatRoundDate` helper shared by both.

**New: `AnimatedBalance`** — the wallet balance (nav + Wallet page) now counts up/down over ~1.1s via Motion's `animate()` instead of snapping straight to the new number, most noticeable right after a win/refund credit lands. Previous value tracked via a ref so it animates from wherever it last was, not from zero, and skips animating on first load (shows the real number immediately rather than counting up from nothing).

**Testing note — real infra flakiness encountered and diagnosed, not a regression:** two full-suite runs today (after the full feature set above landed) both failed a handful of tests, every failure inside `afterEach` cleanup's plain `prisma.wallet.findUnique` calls — never an actual assertion. Measured Neon latency directly (`SELECT 1`) and got 2–3.5s round trips, against the historical ~500–600ms baseline — this database had already taken three full-suite runs and multiple individual-file runs earlier today, and was simply slow at that moment, not broken by anything in this session's changes. Re-ran just the two files covering this session's actual code changes (`draw-entry.test.ts`, `draw-socket.test.ts`) once latency was checked — **8/8 passing**. Both apps build clean.

Also answered a standing question from the user about why they keep seeing OTP prompts: confirmed by reading `AuthContext.tsx` that session restore via the refresh-token cookie already works correctly and silently on app open (no OTP) for up to 30 days — the repeated prompts are a side effect of the "clear site data" instructions given repeatedly this session to fix PWA cache staleness, which also wipes that cookie. Also asked directly whether to add password-based login; the user chose to keep OTP-only (no change made).

**Open items carried forward:** same as the previous entry (Cloudinary verification, Termii, refresh-token grace period, project skill, Foundation audit, `DRAW_ROUND_SIZE=4` must not ship as a real default).

**Next:** finish the live manual draw test now that the reveal is actually reliable for the entrant who completes the round, then M7.

---

## 2026-10-07 — Two small UI fixes: Past Winners CTA, OTP resend

- **"View past winners" was an 11px text link** — easy to miss entirely on the Draw page. Replaced with a full-width card: a gold trophy icon in a filled badge, a one-line subtitle, hover state — matches the visual weight the other actions on that page already have. New `TrophyIcon` added to the shared icon set (`lucky/src/components/icons.tsx`).
- **OTP rate-limit confusion:** the user hit "too many requests, please wait" when tapping Send Code. That's the backend's existing 60-second per-phone cooldown (`otp.service.ts`'s `REQUEST_COOLDOWN_MS`) working exactly as designed — not a bug. The actual gap: the code-entry screen had no resend affordance at all; the only way to retry was "Use a different number," which resets the whole flow back to square one. Added a proper **Resend code** button with a visible countdown (`Resend code in 47s`, mirrored client-side from the same 60s window — cosmetic only, the server is still the real guard) that enables itself once the wait is over.

Both are UI-only; no backend logic changed, no new tests needed (nothing here touches money, settlement, or auth correctness — just surfaces existing server behavior properly). Both apps build clean.

**Open items carried forward:** unchanged from the previous entry (Cloudinary verification, Termii, refresh-token grace period, project skill, Foundation audit, `DRAW_ROUND_SIZE=4` must not ship as a real default).

**Next:** finish the live manual draw test, then M7 — Paystack deposits.

---

## 2026-10-07 — Real app branding: PWA icons, iOS install, social preview

The user asked how an iOS user installs the app, and to make that easy — checking `lucky/public/` surfaced that this had never actually been done properly: `pwa-192x192.png`/`pwa-512x512.png` were literal placeholder stubs (68 bytes each, essentially blank), there was no `apple-touch-icon.png` at all despite being referenced in `vite.config.ts`'s `includeAssets`, and `favicon.svg` was still the default Vite/React template logo (an unrelated purple mark) — none of this had ever been replaced with real artwork, a gap already flagged under M11 ("real PWA icon artwork, currently placeholders") but not yet acted on.

- **Real icon designed:** the same dancing-mascot figure as the nav's `PartyMascot` (gold figure, raised arms, mid-dance pose, on the deep-green ground color) — `lucky/pwa-assets/icon.svg`, a hand-written SVG (no external design tool), chosen specifically so the brand is the same character everywhere (nav, home screen, browser tab, social preview) rather than a different mark per surface.
- **Generated via `@vite-pwa/assets-generator`** (new devDependency) — `favicon.ico`, `pwa-192x192.png`, `pwa-512x512.png`, a maskable 512 variant, and `apple-touch-icon.png`. Its default behavior pads maskable/apple icons 30% against a **white** background — wrong for a full-bleed dark-green source, it put a visible white halo around both. Fixed with a custom `pwa-assets.config.ts` overriding padding to 0 and background to the app's own `#0b3d24` — verified by actually viewing the generated PNGs before shipping them, not just trusting the tool's defaults.
- **`index.html` gained the tags iOS Safari actually reads** for "Add to Home Screen" — none of these existed before: `<link rel="apple-touch-icon">`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style` (`black`, so the status bar stays opaque and matches the dark theme without needing safe-area-inset CSS), `apple-mobile-web-app-title`. Before this, installing on iOS would have fallen back to a screenshot thumbnail instead of a real icon.
- **New `IosInstallBanner`** — iOS Safari has no equivalent of Chrome's `beforeinstallprompt`; there is no native "install" prompt at all, only the manual Share → Add to Home Screen path, which most users don't know exists. A small dismissible banner (detects iOS Safari specifically, not already standalone, not previously dismissed via `localStorage`) now surfaces that path directly in-app.
- **Real meta description + Open Graph/Twitter card tags**, plus a generated 1200×630 social-preview image (`pwa-assets/og-image.svg`, rasterized via `sharp`, same mascot + wordmark) — so a link shared in WhatsApp/Twitter/etc. actually unfurls with a title, description, and branded image instead of a bare URL.

Both source SVGs (`pwa-assets/icon.svg`, `pwa-assets/og-image.svg`) are kept in the repo so the full icon set can be regenerated later if the design changes — `npx pwa-assets-generator` picks up `pwa-assets.config.ts` automatically.

**iOS install steps** (now also shown in-app via the banner): open the site in **Safari** specifically (Add to Home Screen only works from Safari, not Chrome/Firefox on iOS) → tap the **Share** icon → scroll down and tap **Add to Home Screen** → tap **Add**. The app icon then appears on the home screen and launches standalone (no browser chrome).

Both apps build clean; no backend changes, no new tests needed (static assets + markup, nothing touching money/auth/settlement logic).

**Open items carried forward:** unchanged (Cloudinary verification, Termii, refresh-token grace period, project skill, Foundation audit, `DRAW_ROUND_SIZE=4` must not ship as a real default).

**Next:** finish the live manual draw test, then M7 — Paystack deposits.

---

## 2026-10-07 — M10: live comment feed, pulled forward (same move as M6.5)

The user asked for a comment section — this is M10 from the original plan, pulled forward the same way the live draw reveal (M6.5) pulled forward its Socket.IO infrastructure ahead of schedule. Since that infrastructure already exists, this landed as additive work on top of it, not a new system.

- **Data model:** `DrawComment` (`user_id`, `body`, `is_hidden` default false — moderation-ready even though no admin UI exists yet to set it, matching the original plan's §5a), migrated clean.
- **`comment.service.ts`:** 280-char validation, and an 8-second per-user post cooldown via a plain in-memory `Map` — same reasoning as `realtime/socket.ts`'s "no Redis adapter" decision (Render runs a single instance; revisit only if that changes). `displayNameFor` (masked-phone-or-fullName) got pulled out of `draw.routes.ts` into a shared `lib/displayName.ts` so comments and the draw feeds use the exact same identity-masking logic rather than two copies drifting apart.
- **Realtime:** a new authenticated `/comments` Socket.IO namespace (a namespace, not a second server — shares the same port/instance) — unlike the default namespace used for round progress/settlement (deliberately public, no per-user identity needed), posting a comment needs a real identity to attribute and rate-limit. Handshake middleware requires a valid JWT *and* enforces the same mandatory-avatar profile-completeness gate every other authenticated route has (`requireCompleteProfile`'s own logic, SYSTEM/ADMIN exempt) — there's no Express middleware layer on a socket connection, so this check lives directly in the namespace's `use()` middleware instead.
- **REST:** `GET /api/comments/recent` — one-time backfill for a client that just connected, capped at 100; everything after that arrives live over the socket (`comment:new`), never polled.
- **Frontend:** `CommentFeed.tsx` on the Draw page — fixed-height (`h-[320px]`), scrollable, newest-first, capped at 100 client-side to match the backend cap. Each incoming comment (including the poster's own, via the same broadcast everyone gets — no optimistic local insert, so nothing to reconcile) animates in via Motion (`AnimatePresence` + spring transition). `useCommentSocket.ts` connects with `auth` as a function (not a static object) so a reconnect re-reads whatever access token is current rather than replaying a stale one.
- **Dummy content:** `scripts/seed-dummy-comments.ts` seeds 7 realistic comments under fake accounts with real names, so the feed isn't empty on first load. Dev-only, same pattern as `seed-filler-entries.ts`.
- **Also landed:** `PartyMascot.tsx` — a small animated figure (gold, continuous gentle bounce+sway via Motion, not tied to any app state) next to the LUCKY wordmark in the nav, matching the "Owambe" (Nigerian party) framing the visual identity is already built around, per the user's request for the nav to have "automatic movement" animation.

**Testing:** new `tests/integration/comments-socket.test.ts`, same real-infrastructure pattern as `draw-socket.test.ts` — boots an actual `http.Server` + `initSocket()`, connects real `socket.io-client`s. Covers: a connection with no token (and one from a user with an incomplete profile) both get rejected; a posted comment broadcasts to every connected client (not just acks the sender) and is actually persisted; an empty or over-280-char comment is rejected without writing a row; a second post from the same user inside the cooldown window gets `RATE_LIMIT`, not silently queued or dropped.

**A real bug the test suite caught in its own helper, not the feature:** the first draft of `createUser({ avatarUrl })` defaulted via `opts.avatarUrl ?? 'https://example.com/a.png'` — `??` treats an explicit `avatarUrl: null` the same as "not provided" and falls back to the default, so the incomplete-profile test was accidentally creating a user *with* a real avatar and asserting a rejection that had nothing to do with profile completeness. Caught because the test failed with the connection unexpectedly succeeding. Fixed by switching to default-parameter destructuring (`{ avatarUrl = '...' }`), which only applies on `undefined`, not `null`. Worth remembering for any future test helper with an optional-but-nullable field.

Full suite after the fix: **24/24 passing** (6 files). Both apps build clean.

**Open items carried forward:** unchanged (Cloudinary verification, Termii, refresh-token grace period, project skill, Foundation audit, `DRAW_ROUND_SIZE=4` must not ship as a real default). New, deliberately deferred: no admin UI yet for hiding a comment (`is_hidden` exists in the schema for exactly this, per the original plan — building the UI isn't blocking anything else, so it's tracked here rather than built now).

**Next:** finish the live manual draw test, then M7 — Paystack deposits.

---

## 2026-10-07 — Fixed the draw reveal freeze, added a winner modal, verified the OTP timer, built a splash screen

The user reported two issues from live use: the draw screen gets stuck on the rolling numbers once a round starts, never showing who won even though recent entries clearly update behind it; and the OTP rate-limit screen gives no countdown, leaving a rate-limited user stuck with no sense of when they can retry.

**Root cause of the freeze, found by actually reproducing it, not guessing from the code:** stood up both apps locally against the live dev Neon database and drove the Draw page with a throwaway Playwright harness (still no project skill for this — the same gap noted at the end of nearly every session above, hit again). First reproduction attempt was invalid and worth remembering: filling a round via `seed-filler-entries.ts` calls `placeEntry()` directly in its own standalone process, which never calls `initSocket()` — so `tryGetIo()` returns `null` there and nothing ever broadcasts, regardless of what's wrong (or not) in the real server. Switched to placing filler entries over real HTTP against the actual running dev server (the same process `initSocket()` runs in), which is what actually exercises the broadcast path.

With that, the bug reproduced immediately and clearly: `Draw.tsx`'s live-progress effect depended on `round` while also calling `setRound` inside itself —

```js
useEffect(() => {
  if (!progress || !round || progress.roundId !== round.roundId) return
  setRound((r) => (r ? { ...r, entryCount: progress.entryCount } : r))
}, [progress, round])
```

— so the instant the first `round:progress` socket event of the round arrived, it looped: `setRound` changes `round`'s identity even when `entryCount` is unchanged, which re-triggers the effect (a dependency), which calls `setRound` again, forever. Confirmed directly — 860+ "Maximum update depth exceeded" console errors logged across a single round, and the winner never revealed even 70+ seconds past the maximum 60s suspense window. Fixed by moving the staleness check inside the updater (bailing out with the *same* object reference when nothing actually changed) and dropping `round` from the dependency array, so the effect only re-runs once per genuine socket event. Reran the identical scenario after the fix: zero loop errors, correct monotonic progress, winner revealed on schedule.

**New: `WinnerModal`** — the user asked for a proper reveal on top of the fix: the app's own mascot, falling ribbons in the brand palette, and the actual winner's photo, name, slot, and prize, dismissible (backdrop tap, ✕, or the "NICE!" button; auto-dismisses after 8s otherwise). Needed the winner's identity to actually reach the client, which it never had before (only `winnerSlotNumber` existed anywhere) — `settlement.service.decideSettlement` now resolves the winning entry's `userId` to a user record and returns `winnerDisplayName`/`winnerAvatarUrl` (reusing `displayNameFor`'s existing masked-phone-or-fullName logic) alongside the slot number it already returned; `draw.service.ts` threads both through `PlaceEntryResult` into the `round:settled` socket broadcast and the HTTP response, the same way every other settlement field already flows. Frontend keeps the snapshot that opens the modal in its own state (`winnerModalData`), separate from `pendingSettlement`, so the modal's own dismiss lifecycle doesn't get tangled with the queue-draining logic that advances to the next round.

**OTP timer — already fixed, not by this session.** Checked the code before touching anything: `Login.tsx`'s `applyError` already reads `retryAfterSeconds` off an `OTP_RATE_LIMIT` error and starts the countdown, and the backend already returns it (`otp.service.ts`'s `OtpRateLimitError`). Verified live rather than assuming: curled the production API directly (`retryAfterSeconds: 60` on the second request) and pulled the deployed Vercel JS bundle (contains the `retryAfterSeconds`/`WAIT ${s}s` code), then drove it in a real browser — "WAIT 60s" ticked down to "WAIT 57s" correctly. The fix was real and live; if the user was still seeing it stuck, the far more likely explanation is the PWA caching gap already flagged after the first Render/Vercel deploy session — no "new version available" prompt exists, so a previously-visited browser can keep serving an old cached bundle after a deploy with no signal to the user that anything changed. Flagged back to the user, not built (not asked for yet).

**New: `SplashLoader`** — `App.tsx`'s top-level `status === 'loading'` gate (first paint, or a cold Render instance waking up) was a bare spinner with no branding and no nav/mascot at all, which the user flagged directly. Replaced with the LUCKY wordmark + `PartyMascot`, the existing ring spinner, and a rotating one-line fact underneath. First draft only rotated draw-mechanic facts; the user asked directly whether it actually summarizes the app — it didn't — so broadened it to lead with a real one-line summary of what Lucky *is*, then touch every core feature in turn (draw, refund, wallet funding, the live reveal, the leaderboard, the comment feed), not just the draw math. Verified by throttling the `/api/auth/refresh` call in a Playwright run and screenshotting mid-splash — wordmark, spinner, and fact rotation all confirmed visually.

**Testing:** full backend suite re-run after the `settlement.service.ts`/`draw.service.ts` changes — **24/24 passing**, both apps type-check clean. The draw-reveal fix and the winner modal were both verified against the real running dev server and a real browser, not just inferred from the diff — same discipline as every milestone above, applied here to a bug-fix-plus-feature session instead of a new milestone.

**Open items carried forward:** unchanged (Cloudinary verification, Termii, refresh-token grace period, project skill for running/testing — now hit a sixth time, Foundation audit, `DRAW_ROUND_SIZE=4` must not ship as a real default, no admin UI for hiding comments). New: a "new version available — refresh" prompt for the PWA service worker, to stop future deploys from silently failing to reach already-visited users (flagged twice now — after the first Vercel/Render deploy session, and again here).

**Next:** finish the live manual draw test, then M7 — Paystack deposits.

---

## 2026-10-07 — Splash screen: live feedback turned the facts into a numbered flow

The user checked the splash screen live on Vercel (after being pointed at visiting `/` directly, logged out — `/login` is a separate top-level route that never renders `App.tsx`, so it can never show the splash, cold Render instance or not) and gave two notes: the summary should read as the actual step-by-step flow of the app, not a set of interchangeable facts: "1. fund wallet, 2. enter draw 1,200, 3. play etc" — and the text was too faint.

- Replaced the single rotating `<motion.p>` line with a static `<ol>` of five real steps (fund wallet → enter the draw → round fills, winner picked live → win/refund/try again → cash out), each a numbered gold badge + bold ink text, staggered in on mount rather than swapping one at a time — a sequence reads better as a list than as a fact ticker.
- Dropped the rotation interval entirely (`FACTS`/`factIndex`/`ROTATE_MS` all gone) — a static list doesn't need it, and it was the thing making the text feel like disconnected trivia rather than "how this app works."
- Text went from `text-xs text-ink-muted` to `text-sm font-bold text-ink`, per the direct "bolder" feedback.

Verified the same way as the first version — a Playwright run throttling `/api/auth/refresh` to hold the splash on screen, screenshotted mid-render. Both apps type-check clean; no backend changes, no new tests needed (static UI only).

**Next:** finish the live manual draw test, then M7 — Paystack deposits.

---

## 2026-10-07 — Skippable intro screen before the phone/OTP form

The user asked for the splash screen's step list to double as a real intro screen, shown for first-time visitors and for anyone whose session expired and got bounced back to `/login` — both land there with zero context otherwise — with a way to skip past it.

- **New `LoginIntro`:** the same wordmark/mascot/step-list layout as `SplashLoader`, minus the loading icon (this screen isn't waiting on anything — it's deliberate, read-or-skip), plus a single `SKIP` button that advances past it.
- **Extracted `AppFlowSteps`** out of `SplashLoader` — the numbered step list (fund wallet → enter the draw → round fills → win/refund → cash out) is now a shared component instead of being duplicated between the two screens, so they can't quietly drift into describing the app two different ways.
- **`Login.tsx`:** `step` state gained a third value, `'intro'`, and now starts there instead of on `'phone'`. No persisted "already seen it" flag — the intro shows on every fresh mount of `Login`, which naturally covers both a genuine first-time visit and a session-expiry redirect back to `/login` without needing to tell those two cases apart in code; skipping is purely local state, so it reappears on the next visit.

Verified live in a real browser: `/login` shows the intro (phone input not yet in the DOM), `SKIP` reveals the phone form, and navigating to `/login` again afterward (simulating the session-expired redirect) shows the intro again rather than remembering the skip. Both apps type-check clean; no backend changes, no new tests needed (static UI + local component state only).

**Next:** finish the live manual draw test, then M7 — Paystack deposits.

---

## 2026-10-07 — Service worker: a visible "update available" prompt, and two more reports chased down

The user reported two more things after logging out and back in: no onboarding/intro screen, and the OTP rate-limit countdown firing on what felt like a single fresh click. Reproduced the exact real flow (login → Profile → tap the real Log out button → redirected to `/login`) in a live browser rather than guessing — the intro showed correctly every time, both locally and in the already-deployed bundle (confirmed by pulling the live Vercel JS and grepping for the intro's own strings). So the rate-limit report turned out not to be a bug either, once asked directly: the 60-second cooldown is tracked server-side by time since the last SMS sent to that phone number, not per login attempt — logging out and back in within a minute of the previous login's own OTP request will correctly still be in cooldown, no matter how fresh that click feels from the user's side.

That's now three separate reports in one session (this one, the OTP timer before it, and the splash screen before that) where the code and the deploy were both already correct, and the actual cause was the PWA's service worker quietly serving an old cached bundle with zero signal that anything was stale. Rather than keep explaining that same gap after each report, built the fix it's been missing: a real "new version available" prompt.

- **`vite.config.ts`:** `registerType` changed from `'autoUpdate'` to `'prompt'` — autoUpdate reloads the page the instant a new service worker takes control, which is invisible and only as reliable as whenever the browser happens to re-check for an update (typically on the next full navigation, not spontaneously while the SPA stays open) — exactly the kind of timing that made every report above look like a code bug instead of a cache one.
- **New `UpdatePrompt.tsx`:** uses vite-plugin-pwa's `useRegisterSW()` hook (`virtual:pwa-register/react` — added `vite-plugin-pwa/client` to `tsconfig.app.json`'s `types` so TypeScript resolves the virtual module) and renders a small dismissed-by-action "A new version of Lucky is ready — Refresh" banner the moment `needRefresh` flips true. Mounted in `main.tsx` at the root, outside the router entirely, so it's visible on `/login` too — the exact route every one of these three reports happened on.
- Verified with a real production build (`npm run build`, not just `tsc`/dev mode — the PWA plugin only fully runs in a real build): `dist/sw.js` and the Workbox runtime both generate correctly, and a `vite preview` smoke test confirmed the service worker actually registers and the intro screen still renders with no new console errors (the one CORS error seen was from testing the preview build against the real production API from `localhost:4173`, not an app issue).

**Also confirmed, no changes needed:** the user separately described wanting the Past Winners and Recent Entries lists capped at 20 with backend-driven pagination (Next requests the next 20 from the server, nothing accumulated client-side) — checked `Winners.tsx`/`RecentEntries.tsx`/`Paginator.tsx`/`draw.routes.ts` and this is exactly what was already built in the 2026-10-07 "Reveal reliability, pagination, past winners" session above; nothing to do here.

**Open items carried forward:** unchanged, minus the "new version available" prompt item from two entries above — now built. Still open: Cloudinary verification, Termii, refresh-token grace period, project skill for running/testing, Foundation audit, `DRAW_ROUND_SIZE=4` must not ship as a real default, no admin UI for hiding comments.

**Next:** finish the live manual draw test, then M7 — Paystack deposits.

---

## 2026-10-07 — SplashLoader: dropped the step list, reload was showing it everywhere

Immediate follow-up report: reloading the page from anywhere in the app — not just landing fresh — was showing the app-flow step list, which read as the onboarding screen resurfacing for someone already logged in. Root cause was obvious once named: `SplashLoader` covers `App.tsx`'s `status === 'loading'` gate, which fires on *every* page reload while the silent refresh-token check is in flight, not just a genuine first visit — and it had been given the same `AppFlowSteps` list as `LoginIntro` a few entries back. Removed it; `SplashLoader` is back to just the wordmark, mascot, and spinner. The step list now belongs only to `LoginIntro`'s deliberate one-time "about to log in" screen.

Also, on request: renamed the intro's `SKIP` button to `LET'S GO` — "skip" implied the screen was something worth avoiding, when it's just a one-time intro. Renamed `onSkip` to `onContinue` throughout `LoginIntro`/`Login.tsx` to match.

---

## 2026-10-07 — Made the ₦200 fee explicit on the Enter button and intro

The user pointed out "ENTER — ₦1,200" doesn't tell anyone ₦200 of that is a separate platform fee, not part of the ₦1,000 stake. Rather than cram the breakdown into the CTA button itself (considered it — "ENTER — ₦1,000 + ₦200 fee" read as cluttered for a primary action button), kept the button short (`ENTER ₦1,200`, dash dropped per a follow-up request) and added a caption underneath it: `₦1,000 stake + ₦200 fee`, sourced from the round's real `stakeMinor`/`feeMinor` (added `feeMinor` to the frontend `Round` type — the backend's `/api/draw/current` already returned it, just wasn't read) rather than hardcoded, so it can never drift from whatever the actual constants are. `AppFlowSteps`' "Enter the draw" line got the same breakdown.

**Next:** finish the live manual draw test, then M7 — Paystack deposits.

**Next:** finish the live manual draw test, then M7 — Paystack deposits.
