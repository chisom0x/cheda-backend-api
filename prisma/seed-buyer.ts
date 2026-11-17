/**
 * Creates a verified buyer who owns every published product, for testing the buyer web view and
 * mobile app. Re-runnable: the buyer's seeded orders and progress are replaced on each run.
 *
 *   pnpm run seed:buyer [email] [password]
 */
import 'dotenv/config';
import { hash } from '@node-rs/argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { bachsFee, calculateFee } from '../src/common/money';
import { basePriceOf, type Pricing } from '../src/common/json-fields';
import { PrismaClient } from '../src/generated/prisma/client';

const REF = 'BUYERSEED_';
const DAY_MS = 86_400_000;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

type CourseModule = { lessons: { id: string }[] };

async function main() {
  const email = (process.argv[2] ?? 'buyer@cheda.test').trim().toLowerCase();
  const password = process.argv[3] ?? 'cheda-buyer-2026';
  const name = 'Demo Buyer';

  const products = await prisma.product.findMany({
    where: { status: 'published' },
    include: { course: { select: { modules: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (!products.length) throw new Error('No published products to buy.');

  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name, passwordHash: await hash(password), emailVerifiedAt: new Date() },
    update: { passwordHash: await hash(password), emailVerifiedAt: new Date() },
    select: { id: true },
  });

  const now = Date.now();
  await prisma.$transaction(async (tx) => {
    await tx.order.deleteMany({ where: { buyerUserId: user.id, paymentReference: { startsWith: REF } } });
    await tx.progress.deleteMany({ where: { userId: user.id } });

    await tx.order.createMany({
      data: products.map((p, i) => {
        const total = basePriceOf(p.pricing as Pricing);
        const fee = calculateFee(total, p.currency);
        const paidAt = new Date(now - (products.length - i) * DAY_MS);
        return {
          productId: p.id,
          productTitle: p.title,
          sellerId: p.sellerId,
          buyerUserId: user.id,
          buyerEmail: email,
          buyerName: name,
          currency: p.currency,
          subtotal: total,
          discount: 0,
          total,
          fee,
          net: total - fee,
          providerFee: bachsFee(total, 'card'),
          paymentMethod: 'card' as const,
          status: 'paid' as const,
          paymentReference: `${REF}${user.id}_${p.id}`,
          paidAt,
          createdAt: paidAt,
        };
      }),
    });

    // Start the first course partway so "Continue learning" has something in it
    const started = products.find(
      (p) => (p.course?.modules as CourseModule[] | undefined)?.flatMap((m) => m.lessons).length,
    );
    if (started) {
      const lessons = (started.course!.modules as CourseModule[]).flatMap((m) => m.lessons);
      const done = lessons.slice(0, Math.max(1, Math.floor(lessons.length / 2)));
      await tx.progress.create({
        data: {
          userId: user.id,
          productId: started.id,
          completedLessonIds: done.map((l) => l.id),
          lastLessonId: lessons[done.length]?.id ?? done[0].id,
          percent: Math.round((done.length / lessons.length) * 100),
        },
      });
    }
  });

  console.log(`Buyer ready: ${email} / ${password}`);
  for (const p of products) console.log(`  owns ${p.type.padEnd(9)} ${p.title}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
