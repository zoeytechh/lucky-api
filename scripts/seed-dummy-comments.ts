/**
 * Dev-only: seeds a handful of dummy comments so the comment feed has
 * something to show before real users have posted. Usage:
 * npx tsx scripts/seed-dummy-comments.ts
 */
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'

const DUMMY_COMMENTS: { name: string; body: string }[] = [
  { name: 'Chidi O.', body: "Just won my first round! Didn't expect it to pay out this fast 🎉" },
  { name: 'Amaka B.', body: 'Entered 3 times today, got refunded twice. Not bad for ₦1,200 a shot.' },
  { name: 'Tunde A.', body: 'The live number roll had me stressed, ngl. Good suspense.' },
  { name: 'Ngozi E.', body: "Lost my stake this round but that's the game — trying again tomorrow." },
  { name: 'Femi K.', body: 'Been playing since the first round opened. Love the design.' },
  { name: 'Blessing I.', body: 'Finally got refunded after 4 tries 😅' },
  { name: 'Yusuf M.', body: 'Wish there was a win-streak tracker, but this is fun regardless.' },
]

async function main() {
  for (const { name, body } of DUMMY_COMMENTS) {
    const phone = `+1DUMMY${randomUUID()}`
    const user = await prisma.user.create({ data: { phoneNumber: phone, fullName: name } })
    await prisma.drawComment.create({ data: { userId: user.id, body } })
  }
  console.log(`Seeded ${DUMMY_COMMENTS.length} dummy comments.`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
