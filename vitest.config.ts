import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 75_000,
    hookTimeout: 20_000,
    // Integration tests hit the real (dev) database and take row locks —
    // run test files sequentially so they don't contend with each other.
    fileParallelism: false,
  },
})
