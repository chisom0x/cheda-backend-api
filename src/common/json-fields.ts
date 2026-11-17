import { BadRequestException } from '@nestjs/common';

export type ImageSource =
  | { kind: 'gradient'; preset: string }
  | { kind: 'image'; url: string; alt?: string };

export type Pricing =
  | { mode: 'fixed'; amount: number; compareAt?: number }
  | { mode: 'pwyw'; minAmount: number; suggestedAmount: number }
  | { mode: 'free' };

export type SocialLinks = Partial<
  Record<
    'instagram' | 'x' | 'tiktok' | 'youtube' | 'whatsapp' | 'website',
    string
  >
>;

export type NotificationPrefs = {
  newSale: boolean;
  payoutSent: boolean;
  weeklySummary: boolean;
  productUpdates: boolean;
};

export const DEFAULT_NOTIFICATIONS: NotificationPrefs = {
  newSale: true,
  payoutSent: true,
  weeklySummary: true,
  productUpdates: false,
};

const MAX_PRICE = 100_000_000_00;
const SOCIAL_KEYS = [
  'instagram',
  'x',
  'tiktok',
  'youtube',
  'whatsapp',
  'website',
] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isMinor = (v: unknown, min = 0): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= MAX_PRICE;

export function parseImageSource(
  value: unknown,
  publicUrl: string,
): ImageSource {
  if (
    isRecord(value) &&
    value.kind === 'gradient' &&
    typeof value.preset === 'string' &&
    /^[a-z0-9-]{1,32}$/.test(value.preset)
  ) {
    return { kind: 'gradient', preset: value.preset };
  }
  if (
    isRecord(value) &&
    value.kind === 'image' &&
    typeof value.url === 'string'
  ) {
    if (!publicUrl || !value.url.startsWith(`${publicUrl}/`))
      throw new BadRequestException('Images must be uploaded to Cheda.');
    const alt =
      typeof value.alt === 'string' ? value.alt.slice(0, 200) : undefined;
    return { kind: 'image', url: value.url, ...(alt ? { alt } : {}) };
  }
  throw new BadRequestException('Choose a valid image.');
}

export function parsePricing(value: unknown): Pricing {
  if (isRecord(value)) {
    if (value.mode === 'free') return { mode: 'free' };
    if (value.mode === 'fixed' && isMinor(value.amount, 1)) {
      if (value.compareAt === undefined || value.compareAt === null)
        return { mode: 'fixed', amount: value.amount };
      if (isMinor(value.compareAt, value.amount + 1))
        return {
          mode: 'fixed',
          amount: value.amount,
          compareAt: value.compareAt,
        };
      throw new BadRequestException(
        'The compare-at price must be higher than the price.',
      );
    }
    if (
      value.mode === 'pwyw' &&
      isMinor(value.minAmount) &&
      isMinor(value.suggestedAmount, value.minAmount)
    ) {
      return {
        mode: 'pwyw',
        minAmount: value.minAmount,
        suggestedAmount: value.suggestedAmount,
      };
    }
  }
  throw new BadRequestException('Set a valid price.');
}

export function basePriceOf(pricing: Pricing) {
  if (pricing.mode === 'free') return 0;
  return pricing.mode === 'fixed' ? pricing.amount : pricing.suggestedAmount;
}

export function parseSocials(value: unknown): SocialLinks {
  if (!isRecord(value)) throw new BadRequestException('Invalid social links.');
  const socials: SocialLinks = {};
  for (const key of SOCIAL_KEYS) {
    const v = value[key];
    if (typeof v === 'string' && v.trim())
      socials[key] = v.trim().slice(0, 200);
  }
  return socials;
}
