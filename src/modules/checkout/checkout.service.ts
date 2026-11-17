import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../config/env';
import type { AuthUser } from '../../common/auth/auth.decorator';
import {
  ImageSource,
  NotificationPrefs,
  Pricing,
} from '../../common/json-fields';
import { bachsFee, calculateFee, formatMoney } from '../../common/money';
import { sellableProduct } from '../../common/plans';
import { liveSeller, toOrder } from '../../common/presenters';
import { randomToken, sha256 } from '../../common/tokens';
import {
  Coupon,
  Order,
  PaymentMethod,
  Product,
} from '../../generated/prisma/client';
import {
  escapeHtml,
  layout,
  MailService,
} from '../../integrations/mail.service';
import {
  BachsEvent,
  BachsOutcomeUnknown,
  BachsService,
  toDecimal,
  toMinor,
} from '../../integrations/bachs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CheckoutDto, QuoteDto } from './checkout.dto';

const ACCESS_LINK_TTL_MS = 7 * 86_400_000;
const RESULT_WINDOW_MS = 86_400_000;
const CHECKOUT_MINUTES = 60;
const CORRIDORS = {
  card: 'NGN_CARD',
  transfer: 'NGN_BANK_TRANSFER',
} as const satisfies Partial<Record<PaymentMethod, string>>;
/** Events that mean a checkout may now be paid; anything else is ignored. */
const PAID_EVENTS = new Set(['checkout.completed', 'collection.succeeded']);

/** Bachs refuses localhost and private addresses as redirect targets, even in the sandbox. */
function isPublicUrl(url: string) {
  const host = URL.parse(url)?.hostname ?? '';
  return !(
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) ||
    host === '[::1]'
  );
}

type Quote = {
  currency: Product['currency'];
  subtotal: number;
  discount: number;
  total: number;
  coupon: { code: string; label: string } | null;
  couponId: string | null;
};

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bachs: BachsService,
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async quote(dto: QuoteDto) {
    const { currency, subtotal, discount, total, coupon } = await this.price(
      await this.findProduct(dto.productId),
      dto.amount,
      dto.couponCode,
    );
    return { currency, subtotal, discount, total, coupon };
  }

  async start(dto: CheckoutDto, viewer: AuthUser | null) {
    const product = await this.findProduct(dto.productId);
    const quote = await this.price(product, dto.amount, dto.couponCode);
    if (quote.total > 0 && product.currency !== 'NGN')
      throw new BadRequestException(
        'This product can only be bought in NGN for now.',
      );
    const fee = calculateFee(quote.total, product.currency);

    const order = await this.prisma.order.create({
      data: {
        productId: product.id,
        productTitle: product.title,
        sellerId: product.sellerId,
        buyerUserId: viewer?.email === dto.email ? viewer.id : null,
        buyerEmail: dto.email,
        buyerName: dto.name,
        currency: product.currency,
        subtotal: quote.subtotal,
        discount: quote.discount,
        total: quote.total,
        fee,
        net: quote.total - fee,
        providerFee: bachsFee(quote.total, dto.paymentMethod),
        couponId: quote.couponId,
        couponCode: quote.coupon?.code,
        paymentMethod: dto.paymentMethod,
        paymentReference: `CHD_${randomUUID().replace(/-/g, '')}`,
      },
    });

    if (quote.total === 0) {
      await this.markPaid(order.id);
      return { orderId: order.id, checkoutUrl: null };
    }

    const successUrl = `${this.config.get('FRONTEND_URL', { infer: true })}/checkout/success/${order.id}`;
    try {
      // The payment reference doubles as the idempotency key: it's stored with the order and unique to it
      const checkout = await this.bachs.createCheckout(
        {
          pricing: { currency: 'NGN', amount: toDecimal(quote.total) },
          customer: { email: dto.email, name: dto.name },
          payment_method_types: [CORRIDORS[dto.paymentMethod]],
          reference: order.paymentReference,
          metadata: { order_id: order.id },
          expires_in_minutes: CHECKOUT_MINUTES,
          ...(isPublicUrl(successUrl)
            ? { success_url: successUrl, cancel_url: successUrl }
            : {}),
        },
        order.paymentReference,
      );
      await this.prisma.order.update({
        where: { id: order.id },
        data: { providerReference: checkout.checkout_id },
      });
      return { orderId: order.id, checkoutUrl: checkout.checkout_url };
    } catch (e) {
      // If Bachs may have created the checkout, a payment can still arrive for it by reference
      if (!(e instanceof BachsOutcomeUnknown))
        await this.prisma.order.update({
          where: { id: order.id },
          data: { status: 'failed' },
        });
      throw e;
    }
  }

  async result(orderId: string) {
    const found = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        createdAt: { gt: new Date(Date.now() - RESULT_WINDOW_MS) },
      },
    });
    if (!found) throw new NotFoundException("We couldn't find that order.");
    const order =
      found.status === 'pending'
        ? await this.sync(found).catch((e: Error) => {
            this.logger.warn(`Could not verify order ${orderId}: ${e.message}`);
            return found;
          })
        : found;

    const [product, seller] = await Promise.all([
      this.prisma.product.findUnique({
        where: { id: order.productId },
        select: { id: true, title: true, type: true, cover: true },
      }),
      this.prisma.seller.findUnique({
        where: { id: order.sellerId },
        select: { displayName: true },
      }),
    ]);
    return {
      order: toOrder(order),
      product: product
        ? { ...product, cover: product.cover as ImageSource }
        : {
            id: order.productId,
            title: order.productTitle,
            type: 'download',
            cover: { kind: 'gradient', preset: 'sand' },
          },
      sellerName: seller?.displayName ?? 'the creator',
    };
  }

  /**
   * A verified Bachs webhook event. It only says when to look again: the order is paid from the
   * checkout as Bachs reports it now. Throwing makes Bachs deliver the event again.
   */
  async handleEvent(event: BachsEvent) {
    const reference = event.data.reference;
    const checkoutId = event.data.checkout_id;
    const order = await this.prisma.order.findFirst({
      where:
        typeof reference === 'string' && reference
          ? { paymentReference: reference }
          : typeof checkoutId === 'string' && checkoutId
            ? { providerReference: checkoutId }
            : { id: '' },
    });
    if (!order || order.status === 'paid' || order.status === 'refunded')
      return;
    const synced = await this.sync(order, event.id);
    if (PAID_EVENTS.has(event.type) && synced.status !== 'paid')
      throw new ServiceUnavailableException(
        'Checkout is not completed yet; deliver again later.',
      );
  }

  /** Brings an unpaid order up to date with its Bachs checkout. */
  private async sync(order: Order, eventId?: string): Promise<Order> {
    if (!order.providerReference) return order;
    const checkout = await this.bachs.getCheckout(order.providerReference);
    if (checkout.reference && checkout.reference !== order.paymentReference) {
      this.logger.error(`Checkout for order ${order.id} names another order.`);
      return order;
    }
    if (checkout.status === 'completed') {
      const paid = toMinor(checkout.amount);
      if (checkout.currency !== order.currency || paid !== order.total) {
        // Never deliver on a mismatch; leave the order for someone to look at
        this.logger.error(
          `Order ${order.id} not delivered: Bachs reports ${checkout.amount} ${checkout.currency}, expected ${toDecimal(order.total)} ${order.currency}.`,
        );
        return order;
      }
      await this.markPaid(order.id, eventId);
    } else if (checkout.status === 'expired' && order.status === 'pending') {
      // Not final: a late bank transfer can still complete it, and markPaid accepts failed orders
      await this.prisma.order.updateMany({
        where: { id: order.id, status: 'pending' },
        data: { status: 'failed' },
      });
    }
    return this.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  }

  /** Marks the order paid once, recording the event that did it in the same transaction. */
  private async markPaid(orderId: string, eventId?: string) {
    const order = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: { in: ['pending', 'failed'] } },
        data: { status: 'paid', paidAt: new Date() },
      });
      if (!count) return null;
      if (eventId)
        await tx.webhookEvent.create({
          data: { id: eventId, provider: 'bachs', type: 'order.paid' },
        });
      const paid = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      await tx.product.update({
        where: { id: paid.productId },
        data: { salesCount: { increment: 1 } },
      });
      if (paid.couponId)
        await tx.coupon.update({
          where: { id: paid.couponId },
          data: { redemptions: { increment: 1 } },
        });
      return paid;
    });
    if (order)
      await this.deliver(order).catch((e: Error) =>
        this.logger.error(
          `Delivery for order ${order.id} failed: ${e.message}`,
        ),
      );
  }

  private async deliver(order: Order) {
    const token = randomToken();
    await this.prisma.accessLink.create({
      data: {
        orderId: order.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + ACCESS_LINK_TTL_MS),
      },
    });
    const seller = await this.prisma.seller.findUniqueOrThrow({
      where: { id: order.sellerId },
      select: {
        displayName: true,
        notifications: true,
        user: { select: { email: true, name: true } },
      },
    });
    const number = toOrder(order).number;
    const title = escapeHtml(order.productTitle);
    const frontend = this.config.get('FRONTEND_URL', { infer: true });

    await this.mail.send({
      to: { email: order.buyerEmail, name: order.buyerName },
      subject: `Your purchase: ${order.productTitle}`,
      html: layout(
        'Thanks for your purchase',
        `<p>Hi ${escapeHtml(order.buyerName.split(' ')[0])}, thanks for buying <strong>${title}</strong> from ${escapeHtml(seller.displayName)}.</p>
<p>Receipt <strong>${number}</strong> · ${order.total ? formatMoney(order.total, order.currency) : 'Free'}</p>
<p>Use the button below to open it in your Cheda library. No password needed. The link works once and expires in 7 days.</p>`,
        { label: 'Access your purchase', url: `${frontend}/access/${token}` },
      ),
    });

    if ((seller.notifications as NotificationPrefs).newSale) {
      await this.mail.send({
        to: { email: seller.user.email, name: seller.user.name },
        subject: `New sale: ${order.productTitle}`,
        html: layout(
          'You made a sale',
          `<p>${escapeHtml(order.buyerName)} bought <strong>${title}</strong> for ${order.total ? formatMoney(order.total, order.currency) : 'free'}.</p>
<p>You earn <strong>${formatMoney(order.net, order.currency)}</strong> after fees.</p>`,
          { label: 'View orders', url: `${frontend}/dashboard/orders` },
        ),
      });
    }
  }

  private async findProduct(productId: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        id: productId,
        status: 'published',
        seller: liveSeller,
        ...sellableProduct(),
      },
    });
    if (!product)
      throw new NotFoundException("This product isn't available any more.");
    return product;
  }

  private async price(
    product: Product,
    amount?: number,
    couponCode?: string,
  ): Promise<Quote> {
    const subtotal = this.subtotal(product, amount);
    if (!couponCode || subtotal === 0) {
      return {
        currency: product.currency,
        subtotal,
        discount: 0,
        total: subtotal,
        coupon: null,
        couponId: null,
      };
    }
    const coupon = await this.findCoupon(product, couponCode);
    const discount =
      coupon.type === 'percent'
        ? Math.round((subtotal * coupon.value) / 100)
        : Math.min(coupon.value, subtotal);
    const label =
      coupon.type === 'percent'
        ? `${coupon.value}% off`
        : `${formatMoney(coupon.value, product.currency)} off`;
    return {
      currency: product.currency,
      subtotal,
      discount,
      total: subtotal - discount,
      coupon: { code: coupon.code, label },
      couponId: coupon.id,
    };
  }

  private subtotal(product: Product, amount?: number) {
    const pricing = product.pricing as Pricing;
    if (pricing.mode === 'free') return 0;
    if (pricing.mode === 'fixed') return pricing.amount;
    const value = amount ?? pricing.suggestedAmount;
    if (value < pricing.minAmount)
      throw new BadRequestException(
        `The minimum for this product is ${formatMoney(pricing.minAmount, product.currency)}.`,
      );
    return value;
  }

  private async findCoupon(product: Product, code: string): Promise<Coupon> {
    const coupon = await this.prisma.coupon.findUnique({
      where: {
        sellerId_code: { sellerId: product.sellerId, code: code.toUpperCase() },
      },
    });
    if (!coupon?.active)
      throw new BadRequestException("That code isn't valid for this product.");
    if (coupon.expiresAt && coupon.expiresAt < new Date())
      throw new BadRequestException('That code has expired.');
    if (
      coupon.maxRedemptions !== null &&
      coupon.redemptions >= coupon.maxRedemptions
    )
      throw new BadRequestException('That code has been fully redeemed.');
    if (coupon.productIds.length && !coupon.productIds.includes(product.id))
      throw new BadRequestException("That code doesn't apply to this product.");
    return coupon;
  }
}
