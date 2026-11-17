import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { type DecodedIdToken, getAuth } from 'firebase-admin/auth';
import type { Env } from '../config/env';

export type GoogleIdentity = {
  uid: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified: boolean;
};

@Injectable()
export class FirebaseService {
  private readonly logger = new Logger(FirebaseService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  /**
   * Whether a request comes from a genuine, unmodified Cheda app on a real device: its Firebase App Check
   * token (Play Integrity on Android, DeviceCheck on iOS) verifies. Fails closed when Firebase isn't set up.
   */
  async isGenuineApp(appCheckToken: string | undefined): Promise<boolean> {
    if (!appCheckToken) {
      this.logger.warn(
        'No App Check token sent with a protected product request.',
      );
      return false;
    }
    try {
      await getAppCheck(this.app()).verifyToken(appCheckToken);
      return true;
    } catch (e) {
      this.logger.warn(
        e instanceof ServiceUnavailableException
          ? 'App Check needs FIREBASE_* to be set; protected products stay locked.'
          : `App Check token rejected: ${(e as Error).message}`,
      );
      return false;
    }
  }

  async verifyIdToken(idToken: string): Promise<GoogleIdentity> {
    let decoded: DecodedIdToken;
    try {
      decoded = await getAuth(this.app()).verifyIdToken(idToken, true);
    } catch {
      throw new UnauthorizedException(
        'Google sign-in failed. Please try again.',
      );
    }
    if (!decoded.email)
      throw new UnauthorizedException(
        'Your Google account has no email address.',
      );
    return {
      uid: decoded.uid,
      email: decoded.email.toLowerCase(),
      name:
        typeof decoded.name === 'string' && decoded.name.trim()
          ? decoded.name.trim()
          : decoded.email.split('@')[0],
      picture: decoded.picture,
      emailVerified: decoded.email_verified === true,
    };
  }

  private app(): App {
    const existing = getApps()[0];
    if (existing) return existing;
    const projectId = this.config.get('FIREBASE_PROJECT_ID', { infer: true });
    const clientEmail = this.config.get('FIREBASE_CLIENT_EMAIL', {
      infer: true,
    });
    const privateKey = this.config
      .get('FIREBASE_PRIVATE_KEY', { infer: true })
      .replace(/\\n/g, '\n');
    if (!projectId || !clientEmail || !privateKey)
      throw new ServiceUnavailableException(
        'Google sign-in is not configured.',
      );
    return initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
    });
  }
}
