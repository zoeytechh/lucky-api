// Shared by every numbered-page feed (draw entries, winners, wallet
// transactions): a far-back page is one bounded request, not N pages'
// worth of rows sitting in memory once a history keeps growing
// indefinitely. Both page and pageSize get a floor *and* a ceiling —
// an unclamped lower bound lets a negative value reach Prisma's `take`,
// which treats a negative number as "take from the end" instead of
// erroring, silently reversing the sort rather than rejecting the
// request.
export function pagination(req: { query: Record<string, unknown> }, defaultPageSize: number) {
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || defaultPageSize, 1), 100)
  const page = Math.max(Number(req.query.page) || 1, 1)
  return { page, pageSize, skip: (page - 1) * pageSize }
}

// Same clamping as above but for a flat limit (no page/skip) — the
// shape /api/draw/entries and similar single-page "most recent N" reads
// need.
export function clampLimit(req: { query: Record<string, unknown> }, defaultLimit: number, max: number) {
  return Math.min(Math.max(Number(req.query.limit) || defaultLimit, 1), max)
}
