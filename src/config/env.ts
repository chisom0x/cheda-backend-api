import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true';

export class Env {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsInt()
  @Transform(({ value }) => Number(value))
  PORT = 9001;

  @IsUrl({ require_tld: false })
  FRONTEND_URL: string;

  @IsUrl({ require_tld: false })
  API_URL: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  @IsString()
  @MinLength(32)
  JWT_SECRET: string;

  @IsInt()
  @Min(1)
  @Max(90)
  @Transform(({ value }) => Number(value))
  JWT_EXPIRES_IN_DAYS = 30;

  @IsBoolean()
  @Transform(toBool)
  OTP_EMAIL_ENABLED = false;

  @IsOptional() @IsString() ZEPTOMAIL_TOKEN = '';
  @IsOptional() @IsString() ZEPTOMAIL_FROM_EMAIL = 'noreply@cheda.app';
  @IsOptional() @IsString() ZEPTOMAIL_FROM_NAME = 'Cheda';

  @IsOptional() @IsString() FIREBASE_PROJECT_ID = '';
  @IsOptional() @IsString() FIREBASE_CLIENT_EMAIL = '';
  @IsOptional() @IsString() FIREBASE_PRIVATE_KEY = '';

  @IsOptional() @IsString() STORAGE_ENDPOINT = '';
  @IsOptional() @IsString() STORAGE_REGION = '';
  @IsOptional() @IsString() STORAGE_ACCESS_KEY_ID = '';
  @IsOptional() @IsString() STORAGE_SECRET_ACCESS_KEY = '';
  @IsOptional() @IsString() STORAGE_PRIVATE_BUCKET = '';
  @IsOptional() @IsString() STORAGE_PUBLIC_BUCKET = '';
  @IsOptional() @IsString() STORAGE_PUBLIC_URL = '';

  /** Paystack bills plans; it also signs its webhooks with this key. */
  @IsOptional() @IsString() PAYSTACK_SECRET_KEY = '';

  /** Bachs collects product sales; the key's prefix (sk_sandbox_/sk_live_) picks the environment. */
  @IsOptional() @IsString() BACHS_SECRET_KEY = '';
  /** The signing secret (whsec_…) of the Bachs webhook endpoint. */
  @IsOptional() @IsString() BACHS_WEBHOOK_SECRET = '';
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const env = plainToInstance(Env, raw, { exposeDefaultValues: true });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length) {
    const details = errors
      .map(
        (e) =>
          `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
      )
      .join('\n');
    throw new Error(`Invalid environment:\n${details}`);
  }
  if (env.NODE_ENV === 'production' && !env.OTP_EMAIL_ENABLED) {
    throw new Error('OTP_EMAIL_ENABLED must be true in production');
  }
  return env;
}
