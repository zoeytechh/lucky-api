const TERMII_API_KEY = process.env.TERMII_API_KEY
const TERMII_SENDER_ID = process.env.TERMII_SENDER_ID

/**
 * Sends an SMS via Termii. In development, if no API key is configured,
 * logs the message instead of sending — lets auth be exercised end-to-end
 * locally before a Termii account/credit is set up.
 */
export async function sendSms(to: string, message: string): Promise<void> {
  if (!TERMII_API_KEY) {
    console.log(`[sms:dev-mode] to=${to} message="${message}"`)
    return
  }

  const res = await fetch('https://api.ng.termii.com/api/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to,
      from: TERMII_SENDER_ID,
      sms: message,
      type: 'plain',
      channel: 'generic',
      api_key: TERMII_API_KEY,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Termii send failed: ${res.status} ${body}`)
  }
}
