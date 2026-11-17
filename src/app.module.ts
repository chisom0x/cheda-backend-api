import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from './common/auth/auth.guard';
import { EnvelopeInterceptor } from './common/http/envelope.interceptor';
import { AllExceptionsFilter } from './common/http/exception.filter';
import { Env, validateEnv } from './config/env';
import { IntegrationsModule } from './integrations/integrations.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { CheckoutModule } from './modules/checkout/checkout.module';
import { CouponsModule } from './modules/coupons/coupons.module';
import { LibraryModule } from './modules/library/library.module';
import { PayoutsModule } from './modules/payouts/payouts.module';
import { ProductsModule } from './modules/products/products.module';
import { SalesModule } from './modules/sales/sales.module';
import { SellersModule } from './modules/sellers/sellers.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: { algorithm: 'HS256', issuer: 'cheda' },
        verifyOptions: { algorithms: ['HS256'], issuer: 'cheda' },
      }),
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
      errorMessage: 'Too many requests. Please wait a moment and try again.',
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    IntegrationsModule,
    AuthModule,
    SellersModule,
    ProductsModule,
    CheckoutModule,
    LibraryModule,
    SalesModule,
    CouponsModule,
    PayoutsModule,
    UploadsModule,
    SubscriptionsModule,
    WebhooksModule,
    AdminModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
