import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

export const randomToken = (bytes = 32) =>
  randomBytes(bytes).toString('base64url');

export const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export const hmac = (
  secret: string,
  value: string,
  algorithm: 'sha256' | 'sha512' = 'sha256',
) => createHmac(algorithm, secret).update(value).digest('hex');

export const randomDigits = (length: number) =>
  randomInt(0, 10 ** length)
    .toString()
    .padStart(length, '0');

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
