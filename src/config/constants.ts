// All money in kobo (bigint), never float, to avoid rounding bugs.
//
// Stake dropped from ₦1,000 to ₦800 (fee unchanged at ₦200) so the total
// entry price reads as a cleaner ₦1,000 instead of ₦1,200 — the fee is no
// longer broken out as a separate line item in user-facing copy, but it's
// still tracked exactly as before: still debited, still credited to the
// SYSTEM wallet, still real company revenue. Nothing about how the fee
// itself works changed, only what the stake contributes to the pool, and
// what the UI chooses to show.
export const STAKE_MINOR = 80_000n // ₦800
export const FEE_MINOR = 20_000n // ₦200
export const ENTRY_COST_MINOR = STAKE_MINOR + FEE_MINOR // ₦1,000

// Overridable via env for tests only — production always runs the real
// 1000. Settlement derives its refund/loss split from the actual number
// of entries found (see settlement.service.ts), not from a hardcoded
// 500/499, specifically so this can be tested at a small, fast scale
// using the exact same code path and formula as production, rather than
// a separate test-only partition calculation.
export const ROUND_SIZE = Number(process.env.DRAW_ROUND_SIZE) || 1000

// Half the stake pool, derived from ROUND_SIZE so it stays correct at
// whatever size is actually configured (real 1000: ₦400,000, down from
// ₦500,000 — the payout scales with the stake it's drawn from).
export const WINNER_PAYOUT_MINOR = (STAKE_MINOR * BigInt(ROUND_SIZE)) / 2n

// Not enforced anywhere yet — there's no real deposit/withdrawal route
// until Paystack is wired in (M7). Recorded here now as the agreed
// business rule so it's ready to wire into those routes the moment they
// exist, rather than a decision that only lives in a conversation.
export const MIN_DEPOSIT_MINOR = 100_000n // ₦1,000
export const MAX_DEPOSIT_MINOR = 500_000n // ₦5,000
export const MIN_WITHDRAWAL_MINOR = 100_000n // ₦1,000
// Conservative default for an unverified (no-BVN) account — a winner
// (WINNER_PAYOUT_MINOR, currently ₦400,000) would need a few separate
// withdrawals to cash out in full, which is normal at this KYC tier.
// Revisit once Phase 2 BVN/NIN verification exists (see docs/payment.md)
// — a verified account would reasonably get a much higher ceiling.
export const MAX_WITHDRAWAL_MINOR = 10_000_000n // ₦100,000

// Reference only (the real N=1000 split) — settlement.service computes
// the actual split dynamically from entries.length, it does not import
// these.
export const REFUND_COUNT = Math.ceil((ROUND_SIZE - 1) / 2)
export const LOSS_COUNT = Math.floor((ROUND_SIZE - 1) / 2)

// Decided once, server-side, at the moment a round settles — not
// independently randomized per client (the original design) — so every
// viewer, including one who loads the page mid-reveal, counts down to
// the exact same winner-reveal instant instead of each client guessing
// its own window. REVEAL_HOLD_MS is how long the winner stays on screen
// after that before the next round is allowed to accept entries — this
// is also the actual backend-enforced gate (see DrawRound.entriesOpenAt
// in draw.service.ts), not just a frontend timer, so "only one round is
// ever in play" is a real guarantee, not a UI convention.
export const REVEAL_MIN_MS = 30_000
export const REVEAL_MAX_MS = 59_000
export const REVEAL_HOLD_MS = 4_000

// How full a round has to be before the "almost full" push fires (see
// draw.service.ts) — must match the frontend's own ALMOST_FULL_RATIO in
// DrawSocketContext.tsx exactly, since the in-app toast and this push are
// meant to read as the same moment, not two different thresholds. Not a
// shared import (separate repos/runtimes), so kept as a named constant on
// both sides specifically so a future change to one is easy to find and
// match on the other, rather than hunting down an inline 0.7 by hand.
export const ALMOST_FULL_RATIO = 0.7
