import { BadRequestException, ConflictException } from '@nestjs/common';
import { DEFAULT_NOTIFICATIONS } from '../../common/json-fields';

export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_]{1,28}[a-z0-9])?$/;

const RESERVED = new Set([
  'explore',
  'login',
  'signup',
  'forgot-password',
  'dashboard',
  'library',
  'account',
  'checkout',
  'access',
  'api',
  'admin',
  'settings',
  'help',
  'about',
  'pricing',
  'features',
  'terms',
  'privacy',
  'cheda',
  'dev',
]);

export function assertUsernameShape(username: string) {
  if (!USERNAME_PATTERN.test(username))
    throw new BadRequestException(
      'Usernames use 3–30 lowercase letters, numbers or underscores.',
    );
  if (RESERVED.has(username))
    throw new ConflictException('That username is taken. Try another.');
}

export const newSellerData = (username: string, displayName: string) => ({
  username,
  displayName,
  avatar: { kind: 'gradient', preset: 'lemon' },
  banner: { kind: 'gradient', preset: 'ink' },
  notifications: DEFAULT_NOTIFICATIONS,
});
