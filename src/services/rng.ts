import { randomInt } from 'node:crypto'

/**
 * Fisher-Yates shuffle using Node's CSPRNG (crypto.randomInt), not a
 * seeded/replayable PRNG — true randomness with a logged outcome for
 * audit, not third-party-replayable "provable fairness" (that's a bigger
 * feature, noted as a gap in the plan, not built here). Does not mutate
 * the input array.
 */
export function secureShuffle<T>(items: readonly T[]): T[] {
  const result = items.slice()
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1)
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}
