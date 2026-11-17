import type {
  Coupon,
  Order,
  Payout,
  Prisma,
  Progress,
  Seller,
  User,
} from '../generated/prisma/client';
import {
  ImageSource,
  NotificationPrefs,
  Pricing,
  SocialLinks,
} from './json-fields';

const iso = (d: Date) => d.toISOString();

export const productInclude = {
  files: {
    orderBy: { position: 'asc' },
    select: {
      asset: {
        select: {
          id: true,
          name: true,
          size: true,
          mime: true,
          streamStatus: true,
        },
      },
    },
  },
  course: { select: { id: true } },
} satisfies Prisma.ProductInclude;

/** Stores stay offline until a verified bank account is linked. */
export const liveSeller = {
  accountName: { not: null },
} satisfies Prisma.SellerWhereInput;

export type ProductRecord = Prisma.ProductGetPayload<{
  include: typeof productInclude;
}>;

export function toUser(
  user: Pick<
    User,
    'id' | 'name' | 'email' | 'avatarUrl' | 'createdAt' | 'emailVerifiedAt'
  > & { seller?: { id: string } | null },
) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    sellerId: user.seller?.id,
    avatarUrl: user.avatarUrl ?? undefined,
    emailVerified: Boolean(user.emailVerifiedAt),
    createdAt: iso(user.createdAt),
  };
}

export function toPublicSeller(s: Seller) {
  return {
    id: s.id,
    username: s.username,
    displayName: s.displayName,
    headline: s.headline,
    bio: s.bio,
    location: s.location,
    avatar: (s.avatar as ImageSource | null) ?? undefined,
    banner: s.banner as ImageSource,
    accentColor: s.accentColor,
    socials: s.socials as SocialLinks,
    verified: s.verified,
    live: Boolean(s.accountName),
    joinedAt: iso(s.joinedAt),
  };
}

export function toSeller(s: Seller) {
  return {
    ...toPublicSeller(s),
    userId: s.userId,
    notifications: s.notifications as NotificationPrefs,
    bank:
      s.bankCode && s.bankName && s.accountNumber && s.accountName
        ? {
            bankCode: s.bankCode,
            bankName: s.bankName,
            accountNumber: s.accountNumber,
            accountName: s.accountName,
          }
        : undefined,
  };
}

export function toSellerSummary(
  s: Pick<
    Seller,
    'id' | 'username' | 'displayName' | 'avatar' | 'verified' | 'headline'
  >,
) {
  return {
    id: s.id,
    username: s.username,
    displayName: s.displayName,
    avatar: (s.avatar as ImageSource | null) ?? undefined,
    verified: s.verified,
    headline: s.headline,
  };
}

export function toProduct(p: ProductRecord) {
  return {
    id: p.id,
    sellerId: p.sellerId,
    slug: p.slug,
    type: p.type,
    status: p.status,
    title: p.title,
    tagline: p.tagline,
    description: p.description,
    includes: p.includes,
    category: p.category,
    currency: p.currency,
    pricing: p.pricing as Pricing,
    cover: p.cover as ImageSource,
    files: p.files.map(({ asset }) => ({
      id: asset.id,
      name: asset.name,
      size: Number(asset.size),
      mime: asset.mime,
    })),
    videoDurationSec: p.videoDurationSec ?? undefined,
    downloadable: isDownloadable(p),
    protected: p.protected,
    courseId: p.course?.id,
    salesCount: p.salesCount,
    rating: p.rating,
    reviewCount: p.reviewCount,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

/**
 * Whether buyers can save the product's files: when the seller allows it, except for courses (always
 * online-only) and protected products (app-only). A media product is also stream-only when its file was
 * uploaded for streaming (the original is dropped once transcoded).
 */
function isDownloadable(p: ProductRecord) {
  if (!canDownload(p)) return false;
  if (p.type === 'media')
    return p.files.length > 0 && p.files.every((f) => !f.asset.streamStatus);
  return true;
}

/** The seller's choice, before looking at how the files were uploaded. */
export function canDownload(
  p: Pick<ProductRecord, 'type' | 'downloadable' | 'protected'>,
) {
  return p.type !== 'course' && p.downloadable && !p.protected;
}

export function toOrder(o: Order) {
  return {
    id: o.id,
    number: `CHD-${10000 + o.seq}`,
    productId: o.productId,
    productTitle: o.productTitle,
    sellerId: o.sellerId,
    buyerEmail: o.buyerEmail,
    buyerName: o.buyerName,
    currency: o.currency,
    subtotal: o.subtotal,
    discount: o.discount,
    total: o.total,
    fee: o.fee,
    net: o.net,
    couponCode: o.couponCode ?? undefined,
    paymentMethod: o.paymentMethod,
    status: o.status,
    createdAt: iso(o.createdAt),
  };
}

export function toCoupon(c: Coupon) {
  return {
    id: c.id,
    sellerId: c.sellerId,
    code: c.code,
    type: c.type,
    value: c.value,
    productIds: c.productIds.length ? c.productIds : null,
    maxRedemptions: c.maxRedemptions,
    redemptions: c.redemptions,
    expiresAt: c.expiresAt ? iso(c.expiresAt) : null,
    active: c.active,
    createdAt: iso(c.createdAt),
  };
}

export function toPayout(p: Payout) {
  return {
    id: p.id,
    sellerId: p.sellerId,
    amount: p.amount,
    fee: p.fee,
    /** What lands in the bank */
    netAmount: p.amount - p.fee,
    currency: p.currency,
    status: p.status,
    note: p.note ?? undefined,
    bank: {
      bankCode: p.bankCode,
      bankName: p.bankName,
      accountNumber: p.accountNumber,
      accountName: p.accountName,
    },
    reference: p.reference,
    requestedAt: iso(p.requestedAt),
    settledAt: p.settledAt ? iso(p.settledAt) : undefined,
  };
}

export function toProgress(p: Progress, userEmail: string) {
  return {
    productId: p.productId,
    userEmail,
    completedLessonIds: p.completedLessonIds,
    lastLessonId: p.lastLessonId ?? undefined,
    lastPage: p.lastPage ?? undefined,
    lastPositionSec: p.lastPositionSec ?? undefined,
    percent: p.percent,
    updatedAt: iso(p.updatedAt),
  };
}
