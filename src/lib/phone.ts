/**
 * Normalizes Nigerian phone numbers to E.164 (+234XXXXXXXXXX).
 * Accepts local (080...), bare country code (234...), or already-E.164
 * (+234...) input. Returns null if the input doesn't look like a valid
 * Nigerian mobile number.
 */
export function normalizeNigerianPhone(input: string): string | null {
  const digits = input.replace(/[^\d]/g, '')

  let national: string | null = null
  if (digits.length === 11 && digits.startsWith('0')) {
    national = digits.slice(1)
  } else if (digits.length === 13 && digits.startsWith('234')) {
    national = digits.slice(3)
  } else if (digits.length === 10) {
    national = digits
  }

  if (!national || national.length !== 10) return null

  return `+234${national}`
}
