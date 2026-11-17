import { hash, verify } from '@node-rs/argon2';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Env } from '../../config/env';
import type { AuthUser } from '../../common/auth/auth.decorator';
import type { JwtPayload } from '../../common/auth/auth.guard';
import { toUser } from '../../common/presenters';
import { sha256 } from '../../common/tokens';
import { FirebaseService } from '../../integrations/firebase.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SellersService } from '../sellers/sellers.service';
import { newSellerData } from '../sellers/username';
import {
  ChangePasswordDto,
  GoogleDto,
  LoginDto,
  ResetPasswordDto,
  SignUpDto,
  UpdateAccountDto,
} from './auth.dto';
import { OtpService } from './otp.service';

const userSelect = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true,
  createdAt: true,
  emailVerifiedAt: true,
  seller: { select: { id: true } },
} as const;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly otp: OtpService,
    private readonly firebase: FirebaseService,
    private readonly sellers: SellersService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async signUp(dto: SignUpDto) {
    if (
      await this.prisma.user.findUnique({
        where: { email: dto.email },
        select: { id: true },
      })
    ) {
      throw new ConflictException(
        "An account with this email already exists. If you've never set a password, use Forgot password to create one.",
      );
    }
    const username =
      dto.intent === 'seller'
        ? await this.sellers.assertUsernameFree(dto.username ?? '')
        : null;
    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        passwordHash: await hash(dto.password),
        ...(username
          ? { seller: { create: newSellerData(username, dto.name) } }
          : {}),
      },
      select: userSelect,
    });
    this.otp
      .send(user.email, 'email_verification')
      .catch((e: Error) => this.logger.error(e.message));
    return this.session(user);
  }

  async logIn(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { ...userSelect, passwordHash: true },
    });
    // Buyers who redeemed an access link have an account but no password yet.
    if (user && !user.passwordHash) {
      throw new UnauthorizedException(
        "This account doesn't have a password yet. Use Forgot password to set one, or continue with Google.",
      );
    }
    if (
      !user?.passwordHash ||
      !(await verify(user.passwordHash, dto.password))
    ) {
      throw new UnauthorizedException(
        "That email and password don't match. Try again or reset your password.",
      );
    }
    return this.session(user);
  }

  async google(dto: GoogleDto) {
    const identity = await this.firebase.verifyIdToken(dto.idToken);
    const byUid = await this.prisma.user.findUnique({
      where: { firebaseUid: identity.uid },
      select: userSelect,
    });
    if (byUid) return this.session(byUid);

    const byEmail = await this.prisma.user.findUnique({
      where: { email: identity.email },
      select: { id: true, emailVerifiedAt: true },
    });
    if (byEmail) {
      if (!identity.emailVerified)
        throw new UnauthorizedException(
          'Verify your Google email address, then try again.',
        );
      const linked = await this.prisma.user.update({
        where: { id: byEmail.id },
        data: {
          firebaseUid: identity.uid,
          emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date(),
        },
        select: userSelect,
      });
      return this.session(linked);
    }

    const created = await this.prisma.user.create({
      data: {
        name: identity.name,
        email: identity.email,
        firebaseUid: identity.uid,
        avatarUrl: identity.picture,
        emailVerifiedAt: identity.emailVerified ? new Date() : null,
      },
      select: userSelect,
    });
    return this.session(created);
  }

  async logOut(user: AuthUser) {
    await this.prisma.session.update({
      where: { id: user.sessionId },
      data: { revokedAt: new Date() },
    });
    return true;
  }

  async me(userId: string) {
    return toUser(
      await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: userSelect,
      }),
    );
  }

  async updateAccount(user: AuthUser, dto: UpdateAccountDto) {
    const emailChanged = dto.email !== user.email;
    if (
      emailChanged &&
      (await this.prisma.user.findUnique({
        where: { email: dto.email },
        select: { id: true },
      }))
    ) {
      throw new ConflictException('Another account already uses that email.');
    }
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        name: dto.name,
        email: dto.email,
        ...(emailChanged ? { emailVerifiedAt: null } : {}),
      },
      select: userSelect,
    });
    if (emailChanged)
      this.otp
        .send(updated.email, 'email_verification')
        .catch((e: Error) => this.logger.error(e.message));
    return toUser(updated);
  }

  async changePassword(user: AuthUser, dto: ChangePasswordDto) {
    const { passwordHash } = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (
      passwordHash &&
      !(dto.current && (await verify(passwordHash, dto.current)))
    ) {
      throw new BadRequestException('Your current password is incorrect.');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hash(dto.next) },
      }),
      this.prisma.session.updateMany({
        where: {
          userId: user.id,
          id: { not: user.sessionId },
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      }),
    ]);
    return true;
  }

  async requestPasswordReset(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (user) await this.otp.send(email, 'password_reset');
    return { sent: true };
  }

  async resetPassword(dto: ResetPasswordDto) {
    await this.otp.consume(dto.email, 'password_reset', dto.code);
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true, emailVerifiedAt: true },
    });
    if (!user)
      throw new BadRequestException('That code is invalid or has expired.');
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await hash(dto.password),
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        },
      }),
      this.prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    return { reset: true };
  }

  async requestEmailVerification(user: AuthUser) {
    if (!user.emailVerified)
      await this.otp.send(user.email, 'email_verification');
    return { sent: !user.emailVerified };
  }

  async verifyEmail(user: AuthUser, code: string) {
    if (user.emailVerified) return this.me(user.id);
    await this.otp.consume(user.email, 'email_verification', code);
    return toUser(
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() },
        select: userSelect,
      }),
    );
  }

  async redeemAccessLink(token: string) {
    const link = await this.prisma.accessLink.findUnique({
      where: { tokenHash: sha256(token) },
      select: {
        id: true,
        usedAt: true,
        expiresAt: true,
        order: {
          select: {
            id: true,
            status: true,
            buyerEmail: true,
            buyerName: true,
            buyerUserId: true,
            productId: true,
          },
        },
      },
    });
    const invalid = new NotFoundException(
      'This access link is invalid or has expired. Log in to see your library.',
    );
    if (
      !link ||
      link.usedAt ||
      link.expiresAt < new Date() ||
      link.order.status !== 'paid'
    )
      throw invalid;
    const { count } = await this.prisma.accessLink.updateMany({
      where: { id: link.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (!count) throw invalid;

    const { order } = link;
    const user = await this.prisma.user.upsert({
      where: { email: order.buyerEmail },
      create: {
        email: order.buyerEmail,
        name: order.buyerName,
        emailVerifiedAt: new Date(),
      },
      update: {},
      select: userSelect,
    });
    await this.prisma.$transaction([
      this.prisma.user.updateMany({
        where: { id: user.id, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() },
      }),
      this.prisma.order.updateMany({
        where: { id: order.id, buyerUserId: null },
        data: { buyerUserId: user.id },
      }),
    ]);
    return {
      ...(await this.session({
        ...user,
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      })),
      productId: order.productId,
    };
  }

  private async session(user: Parameters<typeof toUser>[0]) {
    const days = this.config.get('JWT_EXPIRES_IN_DAYS', { infer: true });
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        expiresAt: new Date(Date.now() + days * 86_400_000),
      },
      select: { id: true },
    });
    const payload: JwtPayload = { sub: user.id, sid: session.id };
    return {
      token: await this.jwt.signAsync(payload, { expiresIn: `${days}d` }),
      user: toUser(user),
    };
  }
}
