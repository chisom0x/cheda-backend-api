import { Module } from '@nestjs/common';
import { CheckoutModule } from '../checkout/checkout.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [CheckoutModule, SubscriptionsModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
