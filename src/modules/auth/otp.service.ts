import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import { OtpPurpose } from '../../generated/prisma/client';
import { MailService, layout } from '../../integrations/mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { hmac, randomDigits, safeEqual } from '../../common/tokens';

const DEV_CODE = '424242';
const TTL_MS = 10 * 60_000;
const RESEND_AFTER_MS = 60_000;
const MAX_ATTEMPTS = 5;

const SUBJECTS: Record<OtpPurpose, string> = {
  email_verification: 'Verify your email',
  password_reset: 'Reset your password',
};

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async send(email: string, purpose: OtpPurpose): Promise<void> {
    const recent = await this.prisma.otp.findFirst({
      where: {
        email,
        purpose,
        createdAt: { gt: new Date(Date.now() - RESEND_AFTER_MS) },
      },
      select: { id: true },
    });
    if (recent) return;

    const enabled = this.config.get('OTP_EMAIL_ENABLED', { infer: true });
    const code = enabled ? randomDigits(6) : DEV_CODE;
    await this.prisma.$transaction([
      this.prisma.otp.updateMany({
        where: { email, purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      this.prisma.otp.create({
        data: {
          email,
          purpose,
          codeHash: this.hash(email, purpose, code),
          expiresAt: new Date(Date.now() + TTL_MS),
        },
      }),
    ]);
    if (!enabled) return;

    await this.mail
      .send({
        to: { email },
        subject: `${SUBJECTS[purpose]}: ${code}`,
        html: layout(
          SUBJECTS[purpose],
          `<p>Your Cheda code is</p><p style="font-size:32px;font-weight:800;letter-spacing:6px">${code}</p><p>It expires in 10 minutes. If you didn't ask for it, you can ignore this email.</p>`,
        ),
      })
      .catch((e: Error) =>
        this.logger.error(`OTP email to ${email} failed: ${e.message}`),
      );
  }

  async consume(
    email: string,
    purpose: OtpPurpose,
    code: string,
  ): Promise<void> {
    const invalid = new BadRequestException(
      'That code is invalid or has expired.',
    );
    const otp = await this.prisma.otp.findFirst({
      where: {
        email,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp || otp.attempts >= MAX_ATTEMPTS) throw invalid;
    if (!safeEqual(otp.codeHash, this.hash(email, purpose, code))) {
      await this.prisma.otp.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw invalid;
    }
    const { count } = await this.prisma.otp.updateMany({
      where: { id: otp.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (!count) throw invalid;
  }

  private hash(email: string, purpose: OtpPurpose, code: string) {
    return hmac(
      this.config.get('JWT_SECRET', { infer: true }),
      `${purpose}:${email}:${code}`,
    );
  }
}
