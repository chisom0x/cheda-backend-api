import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { AUTH_MODE, AuthMode, AuthUser } from './auth.decorator';

export type JwtPayload = { sub: string; sid: string };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const mode = this.reflector.getAllAndOverride<AuthMode | undefined>(
      AUTH_MODE,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!mode) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = await this.resolve(req.headers.authorization);
    if (!user) {
      if (mode === 'optional') return true;
      throw new UnauthorizedException('Please log in to continue.');
    }
    if (mode !== 'optional' && mode !== 'unverified' && !user.emailVerified)
      throw new ForbiddenException('Verify your email to continue.');
    if (mode === 'admin' && !user.isAdmin)
      throw new ForbiddenException("You don't have access to this.");
    if (mode === 'seller' && !user.sellerId)
      throw new ForbiddenException(
        'Set up your store to access the dashboard.',
      );
    req.user = user;
    return true;
  }

  private async resolve(header: string | undefined): Promise<AuthUser | null> {
    const [scheme, token] = header?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) return null;
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      return null;
    }
    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      select: {
        userId: true,
        expiresAt: true,
        revokedAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            emailVerifiedAt: true,
            role: true,
            seller: { select: { id: true } },
          },
        },
      },
    });
    if (
      !session ||
      session.userId !== payload.sub ||
      session.revokedAt ||
      session.expiresAt < new Date()
    )
      return null;
    const { user } = session;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: Boolean(user.emailVerifiedAt),
      sellerId: user.seller?.id ?? null,
      isAdmin: user.role === 'admin',
      sessionId: payload.sid,
    };
  }
}
