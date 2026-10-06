import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    // Generous on purpose: the draw-entry tests serialize ~12 round trips
    // per entry through the round lock, and from this dev machine to
    // Neon's us-east-2 region that's been measured at ~500-600ms per
    // round trip (not the ~150-300ms assumed when these budgets were
    // first set) — ~6-7s/entry × up to ROUND_SIZE+overflow entries lands
    // right at the old 75s boundary. This is real network RTT from here
    // to there, not a correctness bug: a production deploy co-located
    // with its database (same region) would see this cost evaporate to
    // near-zero, the way wallet-only operations already run fast in these
    // same tests. Not chasing it further with more query-count
    // optimization — it's bounded by physical distance, not code.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Integration tests hit the real (dev) database and take row locks —
    // run test files sequentially so they don't contend with each other.
    fileParallelism: false,
  },
})
