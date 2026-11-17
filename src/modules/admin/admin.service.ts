import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import type {
  ImageSource,
  NotificationPrefs,
  Pricing,
} from '../../common/json-fields';
import { formatMoney } from '../../common/money';
import { isEntitled } from '../../common/plans';
import { toOrder, toPayout } from '../../common/presenters';
import type { Prisma } from '../../generated/prisma/client';
import {
  escapeHtml,
  layout,
  MailService,
} from '../../integrations/mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PayoutsService } from '../payouts/payouts.service';
import { toRange } from './admin-analytics.service';
import type {
  PageDto,
  ProductsQueryDto,
  PurchasesQueryDto,
  SubscriptionPaymentsQueryDto,
  SubscriptionsQueryDto,
  UsersQueryDto,
  WithdrawalsQueryDto,
} from './admin.dto';

const num = (v: bigint | number | null | undefined) => Number(v ?? 0);
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const contains = (q: string) => ({ contains: q, mode: 'insensitive' as const });
const paging = (dto: PageDto) => ({
  skip: (dto.page - 1) * dto.pageSize,
  take: dto.pageSize,
});
const page = <T>(dto: PageDto, items: T[], total: number) => ({
  items,
  total,
  page: dto.page,
  pageSize: dto.pageSize,
});
const sellerSummary = {
  select: { id: true, username: true, displayName: true },
} as const;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payouts: PayoutsService,
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async me(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, name: true, email: true },
    });
  }

  // ── Users ────────────────────────────────────────────────────────────

  async users(dto: UsersQueryDto) {
    const where: Prisma.UserWhereInput = {
      ...(dto.q && {
        OR: [
          { name: contains(dto.q) },
          { email: contains(dto.q) },
          { seller: { is: { username: contains(dto.q) } } },
          { seller: { is: { displayName: contains(dto.q) } } },
        ],
      }),
      ...(dto.kind === 'seller' && { seller: { isNot: null } }),
      ...(dto.kind === 'buyer' && { seller: { is: null } }),
    };
    const monthAgo = new Date(Date.now() - 30 * 86_400_000);
    const [rows, total, stats] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...paging(dto),
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          emailVerifiedAt: true,
          createdAt: true,
          seller: {
            select: {
              id: true,
              username: true,
              displayName: true,
              accountName: true,
              subscription: true,
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
      Promise.all([
        this.prisma.user.count(),
        this.prisma.seller.count(),
        this.prisma.seller.count({ where: { accountName: { not: null } } }),
        this.prisma.user.count({ where: { createdAt: { gte: monthAgo } } }),
        this.prisma.user.count({ where: { emailVerifiedAt: { not: null } } }),
        this.prisma.order
          .groupBy({ by: ['buyerEmail'], where: { status: 'paid' } })
          .then((g) => g.length),
      ]),
    ]);
    const userIds = rows.map((u) => u.id);
    const sellerIds = rows.flatMap((u) => (u.seller ? [u.seller.id] : []));
    const [bought, sold] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['buyerUserId'],
        where: { buyerUserId: { in: userIds }, status: 'paid' },
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.order.groupBy({
        by: ['sellerId'],
        where: { sellerId: { in: sellerIds }, status: 'paid' },
        _sum: { total: true },
        _count: true,
      }),
    ]);
    const boughtBy = new Map(bought.map((b) => [b.buyerUserId, b]));
    const soldBy = new Map(sold.map((s) => [s.sellerId, s]));
    const [users, sellers, liveStores, newThisMonth, verified, buyers] = stats;
    return {
      stats: { users, sellers, liveStores, newThisMonth, verified, buyers },
      ...page(
        dto,
        rows.map((u) => {
          const b = boughtBy.get(u.id);
          const s = u.seller ? soldBy.get(u.seller.id) : undefined;
          return {
            id: u.id,
            name: u.name,
            email: u.email,
            isAdmin: u.role === 'admin',
            emailVerified: Boolean(u.emailVerifiedAt),
            createdAt: iso(u.createdAt),
            purchases: b?._count ?? 0,
            spent: num(b?._sum.total),
            seller: u.seller && {
              id: u.seller.id,
              username: u.seller.username,
              displayName: u.seller.displayName,
              live: Boolean(u.seller.accountName),
              plan: isEntitled(u.seller.subscription)
                ? u.seller.subscription!.plan
                : null,
              sales: s?._count ?? 0,
              gmv: num(s?._sum.total),
            },
          };
        }),
        total,
      ),
    };
  }

  async user(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { seller: { include: { subscription: true } } },
    });
    if (!user) throw new NotFoundException('User not found.');
    const seller = user.seller;
    const [purchases, purchaseTotals, sellerData] = await Promise.all([
      this.prisma.order.findMany({
        where: { OR: [{ buyerUserId: id }, { buyerEmail: user.email }] },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.order.aggregate({
        where: {
          OR: [{ buyerUserId: id }, { buyerEmail: user.email }],
          status: 'paid',
        },
        _sum: { total: true },
        _count: true,
      }),
      seller &&
        Promise.all([
          this.payouts.balance(seller.id),
          this.prisma.order.aggregate({
            where: { sellerId: seller.id, status: 'paid' },
            _sum: { total: true, fee: true, net: true },
            _count: true,
          }),
          this.prisma.order.findMany({
            where: { sellerId: seller.id },
            orderBy: { createdAt: 'desc' },
            take: 50,
          }),
          this.prisma.product.findMany({
            where: { sellerId: seller.id },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              title: true,
              type: true,
              status: true,
              salesCount: true,
              basePrice: true,
              currency: true,
              createdAt: true,
            },
          }),
          this.prisma.payout.findMany({
            where: { sellerId: seller.id },
            orderBy: { requestedAt: 'desc' },
            take: 50,
          }),
          this.prisma.subscriptionPayment.findMany({
            where: { sellerId: seller.id },
            orderBy: { paidAt: 'desc' },
            take: 50,
          }),
          this.prisma.visit.aggregate({
            where: { sellerId: seller.id },
            _sum: { count: true },
          }),
        ]),
    ]);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      isAdmin: user.role === 'admin',
      avatarUrl: user.avatarUrl,
      emailVerified: Boolean(user.emailVerifiedAt),
      signInMethods: [
        ...(user.passwordHash ? ['password'] : []),
        ...(user.firebaseUid ? ['google'] : []),
      ],
      createdAt: iso(user.createdAt),
      purchases: {
        count: purchaseTotals._count,
        spent: num(purchaseTotals._sum.total),
        orders: purchases.map(toOrder),
      },
      seller:
        seller && sellerData
          ? (() => {
              const [
                balance,
                totals,
                orders,
                products,
                payouts,
                subPayments,
                visits,
              ] = sellerData;
              const sub = seller.subscription;
              return {
                id: seller.id,
                username: seller.username,
                displayName: seller.displayName,
                headline: seller.headline,
                bio: seller.bio,
                location: seller.location,
                verified: seller.verified,
                live: Boolean(seller.accountName),
                socials: seller.socials,
                joinedAt: iso(seller.joinedAt),
                bank: seller.accountName
                  ? {
                      bankName: seller.bankName,
                      bankCode: seller.bankCode,
                      accountNumber: seller.accountNumber,
                      accountName: seller.accountName,
                    }
                  : null,
                subscription: sub && {
                  plan: sub.plan,
                  interval: sub.interval,
                  status: sub.status,
                  active: isEntitled(sub),
                  currentPeriodEnd: iso(sub.currentPeriodEnd),
                  paystackCode: sub.paystackCode,
                },
                balance,
                stats: {
                  sales: totals._count,
                  gmv: num(totals._sum.total),
                  fees: num(totals._sum.fee),
                  earnings: num(totals._sum.net),
                  visits: num(visits._sum.count),
                },
                orders: orders.map(toOrder),
                products: products.map((p) => ({
                  ...p,
                  createdAt: iso(p.createdAt),
                })),
                payouts: payouts.map(toPayout),
                subscriptionPayments: subPayments.map((p) => ({
                  ...p,
                  paidAt: iso(p.paidAt),
                })),
              };
            })()
          : null,
    };
  }

  // ── Products ─────────────────────────────────────────────────────────

  async products(dto: ProductsQueryDto) {
    const where: Prisma.ProductWhereInput = {
      ...(dto.status && { status: dto.status }),
      ...(dto.type && { type: dto.type }),
      ...(dto.q && {
        OR: [
          { title: contains(dto.q) },
          { seller: { displayName: contains(dto.q) } },
          { seller: { username: contains(dto.q) } },
        ],
      }),
    };
    const [rows, total, byStatus, byType] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...paging(dto),
        select: {
          id: true,
          title: true,
          slug: true,
          type: true,
          status: true,
          category: true,
          currency: true,
          basePrice: true,
          pricing: true,
          salesCount: true,
          rating: true,
          reviewCount: true,
          createdAt: true,
          seller: sellerSummary,
        },
      }),
      this.prisma.product.count({ where }),
      this.prisma.product.groupBy({ by: ['status'], _count: true }),
      this.prisma.product.groupBy({ by: ['type'], _count: true }),
    ]);
    const revenue = await this.prisma.order.groupBy({
      by: ['productId'],
      where: { productId: { in: rows.map((p) => p.id) }, status: 'paid' },
      _sum: { total: true },
    });
    const revenueBy = new Map(
      revenue.map((r) => [r.productId, num(r._sum.total)]),
    );
    return {
      stats: {
        total: byStatus.reduce((n, s) => n + s._count, 0),
        byStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
        byType: byType.map((t) => ({ type: t.type, count: t._count })),
      },
      ...page(
        dto,
        rows.map((p) => ({
          ...p,
          pricingMode: (p.pricing as Pricing).mode,
          pricing: undefined,
          gmv: revenueBy.get(p.id) ?? 0,
          createdAt: iso(p.createdAt),
        })),
        total,
      ),
    };
  }

  async product(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        seller: sellerSummary,
        files: {
          orderBy: { position: 'asc' },
          select: { asset: { select: { name: true, size: true, mime: true } } },
        },
        course: { select: { modules: true } },
      },
    });
    if (!product) throw new NotFoundException('Product not found.');
    const [totals, orders, reviews, byStatus] = await Promise.all([
      this.prisma.order.aggregate({
        where: { productId: id, status: 'paid' },
        _sum: { total: true, fee: true, net: true, discount: true },
        _count: true,
      }),
      this.prisma.order.findMany({
        where: { productId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.review.findMany({
        where: { productId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.order.groupBy({
        by: ['status'],
        where: { productId: id },
        _count: true,
      }),
    ]);
    const modules = (product.course?.modules ?? []) as {
      lessons?: unknown[];
    }[];
    return {
      id: product.id,
      title: product.title,
      slug: product.slug,
      tagline: product.tagline,
      description: product.description,
      includes: product.includes,
      type: product.type,
      status: product.status,
      category: product.category,
      currency: product.currency,
      pricing: product.pricing as Pricing,
      cover: product.cover as ImageSource,
      downloadable: product.downloadable,
      protected: product.protected,
      rating: product.rating,
      reviewCount: product.reviewCount,
      createdAt: iso(product.createdAt),
      updatedAt: iso(product.updatedAt),
      seller: product.seller,
      files: product.files.map((f) => ({
        ...f.asset,
        size: Number(f.asset.size),
      })),
      course: product.course && {
        modules: modules.length,
        lessons: modules.reduce((n, m) => n + (m.lessons?.length ?? 0), 0),
      },
      stats: {
        sales: totals._count,
        gmv: num(totals._sum.total),
        fees: num(totals._sum.fee),
        earnings: num(totals._sum.net),
        discounts: num(totals._sum.discount),
        ordersByStatus: byStatus.map((s) => ({
          status: s.status,
          count: s._count,
        })),
      },
      orders: orders.map(toOrder),
      reviews: reviews.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
    };
  }

  // ── Finance lists ────────────────────────────────────────────────────

  async purchases(dto: PurchasesQueryDto) {
    const range = dto.from || dto.to ? toRange(dto) : null;
    const where: Prisma.OrderWhereInput = {
      ...(dto.status && { status: dto.status }),
      ...(range && { createdAt: { gte: range.start, lt: range.end } }),
      ...(dto.q && {
        OR: [
          { buyerEmail: contains(dto.q) },
          { buyerName: contains(dto.q) },
          { productTitle: contains(dto.q) },
          { paymentReference: contains(dto.q) },
          { seller: { displayName: contains(dto.q) } },
        ],
      }),
    };
    const [rows, total, sums] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...paging(dto),
        include: { seller: sellerSummary },
      }),
      this.prisma.order.count({ where }),
      this.prisma.order.aggregate({
        where: { ...where, status: 'paid' },
        _sum: { total: true, fee: true },
      }),
    ]);
    return {
      stats: { gmv: num(sums._sum.total), fees: num(sums._sum.fee) },
      ...page(
        dto,
        rows.map((o) => ({
          ...toOrder(o),
          seller: o.seller,
          paymentReference: o.paymentReference,
          providerReference: o.providerReference,
          paidAt: iso(o.paidAt),
        })),
        total,
      ),
    };
  }

  async subscriptionPayments(dto: SubscriptionPaymentsQueryDto) {
    const range = dto.from || dto.to ? toRange(dto) : null;
    const where: Prisma.SubscriptionPaymentWhereInput = {
      ...(range && { paidAt: { gte: range.start, lt: range.end } }),
      ...(dto.q && {
        OR: [
          { reference: contains(dto.q) },
          { seller: { displayName: contains(dto.q) } },
          { seller: { username: contains(dto.q) } },
        ],
      }),
    };
    const [rows, total, sums] = await Promise.all([
      this.prisma.subscriptionPayment.findMany({
        where,
        orderBy: { paidAt: 'desc' },
        ...paging(dto),
        include: { seller: sellerSummary },
      }),
      this.prisma.subscriptionPayment.count({ where }),
      this.prisma.subscriptionPayment.aggregate({
        where,
        _sum: { amount: true },
      }),
    ]);
    return {
      stats: { amount: num(sums._sum.amount) },
      ...page(
        dto,
        rows.map((p) => ({ ...p, paidAt: iso(p.paidAt) })),
        total,
      ),
    };
  }

  async subscriptions(dto: SubscriptionsQueryDto) {
    const where: Prisma.SubscriptionWhereInput = {
      ...(dto.status && { status: dto.status }),
      ...(dto.q && {
        seller: {
          OR: [{ displayName: contains(dto.q) }, { username: contains(dto.q) }],
        },
      }),
    };
    const [rows, total, byStatus] = await Promise.all([
      this.prisma.subscription.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        ...paging(dto),
        include: {
          seller: { select: { ...sellerSummary.select, userId: true } },
        },
      }),
      this.prisma.subscription.count({ where }),
      this.prisma.subscription.groupBy({ by: ['status'], _count: true }),
    ]);
    return {
      stats: {
        byStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
      },
      ...page(
        dto,
        rows.map((s) => ({
          sellerId: s.sellerId,
          seller: s.seller,
          plan: s.plan,
          interval: s.interval,
          status: s.status,
          active: isEntitled(s),
          currentPeriodEnd: iso(s.currentPeriodEnd),
          paystackCode: s.paystackCode,
          createdAt: iso(s.createdAt),
          updatedAt: iso(s.updatedAt),
        })),
        total,
      ),
    };
  }

  // ── Withdrawals ──────────────────────────────────────────────────────

  async withdrawals(dto: WithdrawalsQueryDto) {
    const where: Prisma.PayoutWhereInput = {
      ...(dto.status && { status: dto.status }),
      ...(dto.q && {
        OR: [
          { reference: contains(dto.q) },
          { accountName: contains(dto.q) },
          { accountNumber: { contains: dto.q } },
          { seller: { displayName: contains(dto.q) } },
          { seller: { username: contains(dto.q) } },
        ],
      }),
    };
    const [rows, total, byStatus] = await Promise.all([
      this.prisma.payout.findMany({
        where,
        // Oldest requests first while they wait, newest first otherwise
        orderBy: { requestedAt: dto.status === 'processing' ? 'asc' : 'desc' },
        ...paging(dto),
        include: { seller: sellerSummary },
      }),
      this.prisma.payout.count({ where }),
      this.prisma.payout.groupBy({
        by: ['status'],
        _sum: { amount: true, fee: true },
        _count: true,
      }),
    ]);
    const stat = (status: string) => {
      const g = byStatus.find((s) => s.status === status);
      return {
        count: g?._count ?? 0,
        amount: num(g?._sum.amount),
        fees: num(g?._sum.fee),
      };
    };
    const paid = stat('paid');
    return {
      stats: {
        pending: stat('processing'),
        paid: { ...paid, sent: paid.amount - paid.fees },
        declined: stat('failed'),
      },
      ...page(
        dto,
        rows.map((p) => ({ ...toPayout(p), seller: p.seller })),
        total,
      ),
    };
  }

  /** Mark a withdrawal as paid once the bank transfer has been sent by hand. */
  async approveWithdrawal(id: string) {
    const { count } = await this.prisma.payout.updateMany({
      where: { id, status: 'processing' },
      data: { status: 'paid', settledAt: new Date() },
    });
    const payout = await this.findPayout(id);
    if (!count)
      throw new ConflictException(
        `This withdrawal is already ${payout.status === 'failed' ? 'declined' : payout.status}.`,
      );
    void this.notify(payout.id, 'paid');
    return toPayout(payout);
  }

  /** Declines a withdrawal and returns its orders to the creator's wallet. */
  async declineWithdrawal(id: string, reason: string) {
    const declined = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payout.updateMany({
        where: { id, status: 'processing' },
        data: { status: 'failed', settledAt: new Date(), note: reason },
      });
      if (!count) return false;
      await tx.order.updateMany({
        where: { payoutId: id },
        data: { payoutId: null },
      });
      return true;
    });
    const payout = await this.findPayout(id);
    if (!declined)
      throw new ConflictException(
        `This withdrawal is already ${payout.status === 'failed' ? 'declined' : payout.status}.`,
      );
    void this.notify(payout.id, 'declined');
    return toPayout(payout);
  }

  private async findPayout(id: string) {
    const payout = await this.prisma.payout.findUnique({ where: { id } });
    if (!payout) throw new NotFoundException('Withdrawal not found.');
    return payout;
  }

  private async notify(payoutId: string, outcome: 'paid' | 'declined') {
    try {
      const payout = await this.prisma.payout.findUniqueOrThrow({
        where: { id: payoutId },
        include: {
          seller: {
            select: {
              notifications: true,
              user: { select: { email: true, name: true } },
            },
          },
        },
      });
      const { user } = payout.seller;
      const prefs = payout.seller.notifications as NotificationPrefs;
      if (outcome === 'paid' && !prefs.payoutSent) return;
      const sent = formatMoney(payout.amount - payout.fee, payout.currency);
      const url = `${this.config.get('FRONTEND_URL', { infer: true })}/dashboard/payouts`;
      await this.mail.send({
        to: { email: user.email, name: user.name },
        subject:
          outcome === 'paid'
            ? `Your withdrawal of ${sent} has been paid`
            : 'Your withdrawal was declined',
        html:
          outcome === 'paid'
            ? layout(
                'Withdrawal paid',
                `<p>We've sent <strong>${sent}</strong> to ${escapeHtml(payout.bankName)} ••••${escapeHtml(payout.accountNumber.slice(-4))}.</p>
<p>Reference ${escapeHtml(payout.reference)}. It can take a few minutes to show in your account.</p>`,
                { label: 'View payouts', url },
              )
            : layout(
                'Withdrawal declined',
                `<p>Your withdrawal of ${formatMoney(payout.amount, payout.currency)} was declined: ${escapeHtml(payout.note ?? '')}</p>
<p>The money is back in your balance, so you can withdraw again.</p>`,
                { label: 'View payouts', url },
              ),
      });
    } catch (e) {
      this.logger.error(
        `Withdrawal email for ${payoutId} failed: ${(e as Error).message}`,
      );
    }
  }
}
