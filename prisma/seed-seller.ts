/**
 * Seeds a seller's dashboard (orders, customers, visits, coupons, payouts, reviews)
 * against their existing products. Re-runnable: rows it created are tagged and
 * replaced on each run; real data is left alone.
 *
 *   pnpm run seed:seller <seller-email>
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { bachsFee, calculateFee } from '../src/common/money';
import type { Pricing } from '../src/common/json-fields';
import {
  OrderStatus,
  PaymentMethod,
  Prisma,
  PrismaClient,
} from '../src/generated/prisma/client';

const DAYS = 180; // 90d range plus its comparison period
const SETTLEMENT_DELAY_DAYS = 2;
const REF = 'SEED_';
const REVIEW_ID = 'seed_';
const DAY_MS = 86_400_000;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

// Deterministic so reruns produce the same shape of data
let s = 0x5eed;
const rand = () => {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const weighted = <T>(xs: readonly [T, number][]) => {
  let r = rand() * xs.reduce((sum, [, w]) => sum + w, 0);
  for (const [x, w] of xs) if ((r -= w) <= 0) return x;
  return xs[xs.length - 1][0];
};

const FIRST = ['Chidera', 'Tobi', 'Amaka', 'Emeka', 'Funke', 'Ifeanyi', 'Ngozi', 'Segun', 'Zainab', 'Kunle', 'Adaeze', 'Bayo', 'Halima', 'Uche', 'Temi', 'Obinna', 'Yetunde', 'Musa', 'Chioma', 'Damilola', 'Ikenna', 'Aisha', 'Femi', 'Nkechi', 'Tunde', 'Blessing', 'Kelechi', 'Sade', 'Ibrahim', 'Ebuka'];
const LAST = ['Okafor', 'Adeyemi', 'Eze', 'Bello', 'Okonkwo', 'Balogun', 'Nwosu', 'Abubakar', 'Ogunleye', 'Chukwu', 'Ibe', 'Afolabi', 'Danjuma', 'Obi', 'Lawal'];
const REVIEWS: Record<number, string[]> = {
  5: ['Exactly what I needed. Worth every naira.', 'Clear, practical and well put together.', 'I have recommended this to all my friends.', 'Best purchase I made this year.', 'Super helpful, thank you!'],
  4: ['Really good, a few parts could go deeper.', 'Solid value for the price.', 'Very useful, would love an update with more examples.'],
  3: ['Decent, but I expected a bit more.', 'Good basics, nothing groundbreaking.'],
  2: ['Not quite what I was looking for.'],
};

const buyers = Array.from({ length: 90 }, (_, i) => {
  const first = pick(FIRST);
  const last = pick(LAST);
  return {
    name: `${first} ${last}`,
    email: `${first}.${last}${i}@example.com`.toLowerCase(),
  };
});
// Earlier buyers come back more often, so there are repeat customers
const pickBuyer = () => buyers[Math.floor(buyers.length * rand() ** 2)];

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) throw new Error('Usage: pnpm run seed:seller <seller-email>');
  const seller = await prisma.seller.findFirst({
    where: { user: { email } },
    include: { products: { where: { status: 'published' } } },
  });
  if (!seller) throw new Error(`No seller found for ${email}.`);
  if (!seller.products.length)
    throw new Error('Seller has no published products to sell.');
  if (!seller.bankCode || !seller.accountNumber)
    throw new Error('Seller has no bank account linked (needed for payouts).');

  const now = Date.now();
  const startOfToday = new Date(new Date(now).toISOString().slice(0, 10));
  const daysAgo = (d: number) => new Date(now - d * DAY_MS);
  const courseIds = seller.products
    .filter((p) => p.type === 'course')
    .map((p) => p.id);

  const coupons = [
    { code: 'LAUNCH20', type: 'percent', value: 20, productIds: [], maxRedemptions: 50, expiresAt: daysAgo(120), active: true },
    { code: 'WELCOME10', type: 'percent', value: 10, productIds: [], maxRedemptions: null, expiresAt: null, active: true },
    { code: 'JAMB5K', type: 'fixed', value: 500_000, productIds: courseIds, maxRedemptions: 200, expiresAt: new Date(now + 60 * DAY_MS), active: courseIds.length > 0 },
    { code: 'EASTER15', type: 'percent', value: 15, productIds: [], maxRedemptions: 30, expiresAt: daysAgo(150), active: false },
  ] as const;

  await prisma.$transaction(
    async (tx) => {
      // Clear the previous run
      await tx.order.deleteMany({ where: { sellerId: seller.id, paymentReference: { startsWith: REF } } });
      await tx.payout.deleteMany({ where: { sellerId: seller.id, reference: { startsWith: REF } } });
      await tx.review.deleteMany({ where: { id: { startsWith: REVIEW_ID }, product: { sellerId: seller.id } } });
      await tx.coupon.deleteMany({ where: { sellerId: seller.id, code: { in: coupons.map((c) => c.code) } } });

      const created = await Promise.all(
        coupons.map((c) =>
          tx.coupon.create({
            data: { ...c, productIds: [...c.productIds], sellerId: seller.id, createdAt: daysAgo(DAYS) },
          }),
        ),
      );

      const orders: Prisma.OrderCreateManyInput[] = [];
      const reviews: Prisma.ReviewCreateManyInput[] = [];
      for (let d = DAYS - 1; d >= 0; d--) {
        const day = new Date(startOfToday.getTime() - d * DAY_MS);
        const weekday = day.getUTCDay();
        // Traffic grows over the period, dips on weekends
        const visits = Math.round((20 + (DAYS - d) * 0.4) * (weekday === 0 || weekday === 6 ? 0.75 : 1) * (0.7 + rand() * 0.6));
        // Today's row is real traffic; keep it
        if (d > 0)
          await tx.visit.upsert({
            where: { sellerId_day: { sellerId: seller.id, day } },
            create: { sellerId: seller.id, day, count: visits },
            update: { count: visits },
          });

        const dayEnd = Math.min(day.getTime() + DAY_MS, now);
        const count = Math.round(visits * (0.03 + rand() * 0.04));
        for (let i = 0; i < count; i++) {
          const createdAt = new Date(day.getTime() + rand() * (dayEnd - day.getTime()));
          const product = weighted(seller.products.map((p) => [p, p.type === 'ebook' ? 4 : p.type === 'course' ? 2 : 3]));
          const pricing = product.pricing as Pricing;
          const subtotal =
            pricing.mode === 'fixed' ? pricing.amount
            : pricing.mode === 'pwyw' ? Math.max(pricing.minAmount, pick([1, 1, 1.5, 2, 3, 5]) * pricing.minAmount)
            : 0;

          const usable = created.filter(
            (c) => (c.active || c.code === 'EASTER15') && (!c.expiresAt || createdAt < c.expiresAt) && (!c.productIds.length || c.productIds.includes(product.id)),
          );
          const coupon = subtotal > 0 && usable.length && rand() < 0.18 ? pick(usable) : null;
          const discount = !coupon ? 0
            : coupon.type === 'percent' ? Math.round((subtotal * coupon.value) / 100)
            : Math.min(coupon.value, subtotal);
          const total = subtotal - discount;
          const fee = calculateFee(total, product.currency);

          const paymentMethod = weighted<PaymentMethod>([['card', 6], ['transfer', 3], ['ussd', 1]]);
          const status: OrderStatus = total === 0 ? 'paid' : weighted([['paid', 88], ['failed', 8], ['refunded', 4]]);
          const buyer = pickBuyer();
          orders.push({
            productId: product.id,
            productTitle: product.title,
            sellerId: seller.id,
            buyerEmail: buyer.email,
            buyerName: buyer.name,
            currency: product.currency,
            subtotal,
            discount,
            total,
            fee,
            net: total - fee,
            couponId: coupon?.id,
            couponCode: coupon?.code,
            paymentMethod,
            providerFee: status === 'failed' ? 0 : bachsFee(total, paymentMethod),
            status,
            paymentReference: `${REF}${randomUUID().replace(/-/g, '')}`,
            paidAt: status === 'failed' ? null : new Date(Math.min(createdAt.getTime() + 60_000 + rand() * 120_000, now)),
            createdAt,
            updatedAt: createdAt,
          });

          if (status === 'paid' && rand() < 0.15) {
            const rating = weighted([[5, 55], [4, 30], [3, 10], [2, 5]]);
            reviews.push({
              id: `${REVIEW_ID}${randomUUID()}`,
              productId: product.id,
              authorName: buyer.name,
              rating,
              body: pick(REVIEWS[rating]),
              createdAt: new Date(Math.min(createdAt.getTime() + (1 + rand() * 6) * DAY_MS, now)),
            });
          }
        }
      }
      await tx.order.createMany({ data: orders });
      await tx.review.createMany({ data: reviews });

      // Weekly withdrawals of paid orders; the last couple of days stay in the wallet
      const cutoff = now - SETTLEMENT_DELAY_DAYS * DAY_MS;
      const weeks = new Map<number, Prisma.OrderCreateManyInput[]>();
      for (const o of orders) {
        const paidAt = (o.paidAt as Date | null)?.getTime();
        if (o.status !== 'paid' || o.total <= 0 || !paidAt || paidAt > cutoff) continue;
        const week = Math.floor(paidAt / (7 * DAY_MS));
        weeks.set(week, [...(weeks.get(week) ?? []), o]);
      }
      for (const [week, settled] of weeks) {
        const settledAt = new Date(Math.min((week + 1) * 7 * DAY_MS + 10 * 3_600_000, cutoff));
        const payout = await tx.payout.create({
          data: {
            sellerId: seller.id,
            amount: settled.reduce((sum, o) => sum + o.net, 0),
            status: 'paid',
            bankCode: seller.bankCode!,
            bankName: seller.bankName!,
            accountNumber: seller.accountNumber!,
            accountName: seller.accountName!,
            reference: `${REF}${week}`,
            requestedAt: new Date(settledAt.getTime() - 3_600_000),
            settledAt,
          },
        });
        await tx.order.updateMany({
          where: { paymentReference: { in: settled.map((o) => o.paymentReference) } },
          data: { payoutId: payout.id },
        });
      }

      // Recompute counters the way checkout and reviews maintain them, over all of the seller's data
      for (const p of seller.products) {
        const [salesCount, r] = await Promise.all([
          tx.order.count({ where: { productId: p.id, status: 'paid' } }),
          tx.review.aggregate({ where: { productId: p.id }, _avg: { rating: true }, _count: true }),
        ]);
        await tx.product.update({
          where: { id: p.id },
          data: { salesCount, reviewCount: r._count, rating: Math.round((r._avg.rating ?? 0) * 10) / 10 },
        });
      }
      for (const c of created)
        await tx.coupon.update({
          where: { id: c.id },
          data: { redemptions: await tx.order.count({ where: { couponId: c.id, status: 'paid' } }) },
        });

      const paid = orders.filter((o) => o.status === 'paid');
      console.log(
        `Seeded ${seller.username}: ${orders.length} orders (${paid.length} paid), ` +
          `${new Set(orders.map((o) => o.buyerEmail)).size} customers, ${reviews.length} reviews, ` +
          `${weeks.size} payouts, ${created.length} coupons, ${DAYS - 1} days of visits.`,
      );
    },
    { timeout: 120_000 },
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
