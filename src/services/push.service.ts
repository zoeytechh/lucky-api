import webpush from 'web-push'
import { prisma } from '../lib/prisma'

// Subject + keys are required at send time, not import time, so a
// missing/incomplete VAPID env in dev doesn't crash the whole process —
// just push sends, which fail loudly (logged) instead.
function configureWebPush() {
  const { VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env
  if (!VAPID_SUBJECT || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
  return true
}

export type PushPayload = { title: string; body: string; url?: string }

type SubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } }

export async function savePushSubscription(userId: string, sub: SubscriptionInput) {
  await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    update: { userId, keysP256dh: sub.keys.p256dh, keysAuth: sub.keys.auth },
    create: { userId, endpoint: sub.endpoint, keysP256dh: sub.keys.p256dh, keysAuth: sub.keys.auth },
  })
}

export async function removePushSubscription(endpoint: string) {
  await prisma.pushSubscription.deleteMany({ where: { endpoint } })
}

type SubRow = { id: string; endpoint: string; keysP256dh: string; keysAuth: string }

async function sendToSubscription(sub: SubRow, payload: PushPayload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.keysP256dh, auth: sub.keysAuth } },
      JSON.stringify(payload),
    )
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode
    if (statusCode === 404 || statusCode === 410) {
      // The browser revoked or expired this subscription on its end —
      // nothing to retry, just stop trying it again next time.
      await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {})
    } else {
      console.error(`push send failed (status ${statusCode}):`, err)
    }
  }
}

/** Pushes to every device a single user has subscribed from. */
export async function sendPushToUser(userId: string, payload: PushPayload) {
  if (!configureWebPush()) return
  const subs = await prisma.pushSubscription.findMany({ where: { userId } })
  await Promise.allSettled(subs.map((s) => sendToSubscription(s, payload)))
}

/**
 * Pushes to every device belonging to any user in the given list —
 * always sent to everyone it names (unlike sendPushToUser's single
 * target, this doesn't skip anyone). Whether an OS notification
 * actually *shows* for a given recipient is a separate decision the
 * service worker itself makes (see src/sw.ts): if that device currently
 * has the app open and visible, it suppresses the popup and trusts the
 * in-app toast that same live page is already showing instead. The
 * caller here never needs to know which — it just names who should get
 * the content.
 */
export async function sendPushToUserIds(userIds: string[], payload: PushPayload) {
  if (userIds.length === 0) return
  if (!configureWebPush()) return
  const subs = await prisma.pushSubscription.findMany({ where: { userId: { in: userIds } } })
  await Promise.allSettled(subs.map((s) => sendToSubscription(s, payload)))
}

// How long without placing an entry counts as "inactive" for the
// re-engagement nudge below.
const INACTIVITY_MS = 24 * 60 * 60 * 1000

/**
 * The exception to "only round participants get told who won": a user
 * who hasn't played in 24h+ still gets told about a winner once, as a
 * hook back into the app — not every single round while they stay away,
 * just once per inactive stretch. Eligibility resets the moment they
 * play again (their own next entry clears the "already nudged" state,
 * since it's compared against their *own* most recent entry, not a
 * fixed clock).
 *
 * excludeUserIds should be the round's own participants (and the
 * winner) — they already got their own push from the caller and don't
 * need this one too.
 */
export async function notifyInactiveNonParticipants(excludeUserIds: string[], payload: PushPayload) {
  if (!configureWebPush()) return

  const candidates = await prisma.pushSubscription.findMany({
    where: excludeUserIds.length > 0 ? { userId: { notIn: excludeUserIds } } : undefined,
    select: { userId: true },
    distinct: ['userId'],
  })
  if (candidates.length === 0) return
  const candidateIds = candidates.map((c) => c.userId)

  const [users, lastEntries] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: candidateIds } },
      select: { id: true, lastReengagementPushAt: true },
    }),
    prisma.drawEntry.groupBy({
      by: ['userId'],
      where: { userId: { in: candidateIds } },
      _max: { enteredAt: true },
    }),
  ])
  const lastPlayedByUser = new Map(lastEntries.map((e) => [e.userId, e._max.enteredAt]))

  const cutoff = new Date(Date.now() - INACTIVITY_MS)
  const toNotify: string[] = []
  for (const user of users) {
    const lastPlayed = lastPlayedByUser.get(user.id) ?? null
    const inactive = !lastPlayed || lastPlayed < cutoff
    if (!inactive) continue
    // Already nudged since whatever their last entry was (or ever, if
    // they've never played) — don't nudge again until they play and go
    // quiet for another full stretch.
    const alreadyNudged = user.lastReengagementPushAt && (!lastPlayed || user.lastReengagementPushAt > lastPlayed)
    if (alreadyNudged) continue
    toNotify.push(user.id)
  }
  if (toNotify.length === 0) return

  await sendPushToUserIds(toNotify, payload)
  await prisma.user.updateMany({ where: { id: { in: toNotify } }, data: { lastReengagementPushAt: new Date() } })
}
