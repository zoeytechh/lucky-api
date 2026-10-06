import 'dotenv/config'

// Small round size for draw tests — exercises the exact same code and
// settlement formula as production (see constants.ts), just fast enough
// to run as part of the normal test suite instead of needing ~1000 real
// serialized entries through the live database every run.
process.env.DRAW_ROUND_SIZE = process.env.DRAW_ROUND_SIZE ?? '12'
