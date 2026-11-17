import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';

/**
 * - optional: attach the user when a valid token is sent, never reject.
 * - unverified: signed in; email verification not required (account/verification endpoints only).
 * - user: signed in with a verified email.
 * - seller: signed in, verified, and owns a store.
 * - admin: signed in, verified, with the admin role.
 */
export type AuthMode = 'optional' | 'unverified' | 'user' | 'seller' | 'admin';

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  sellerId: string | null;
  isAdmin: boolean;
  sessionId: string;
};

export type SellerUser = AuthUser & { sellerId: string };

export const AUTH_MODE = 'auth:mode';

export const Auth = (mode: AuthMode = 'user') =>
  applyDecorators(SetMetadata(AUTH_MODE, mode), ApiBearerAuth());

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<{ user?: AuthUser }>().user ?? null,
);
