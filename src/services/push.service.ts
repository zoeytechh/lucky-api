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

/** Pushes to every subscribed device app-wide, optionally skipping one user's own (e.g. the winner, who gets their own push separately). */
export async function sendPushToAll(payload: PushPayload, excludeUserId?: string) {
  if (!configureWebPush()) return
  const subs = await prisma.pushSubscription.findMany(
    excludeUserId ? { where: { userId: { not: excludeUserId } } } : undefined,
  )
  await Promise.allSettled(subs.map((s) => sendToSubscription(s, payload)))
}
