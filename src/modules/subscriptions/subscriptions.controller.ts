import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  Auth,
  CurrentUser,
  type SellerUser,
} from '../../common/auth/auth.decorator';
import { CheckoutPlanDto, ConfirmPlanDto } from './subscriptions.dto';
import { SubscriptionsService } from './subscriptions.service';

@ApiTags('subscription')
@Auth('seller')
@Controller('me/subscription')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  summary(@CurrentUser() user: SellerUser) {
    return this.subscriptions.summary(user.sellerId);
  }

  /** Starts or switches the seller's plan: returns Paystack's payment page. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('checkout')
  checkout(@CurrentUser() user: SellerUser, @Body() dto: CheckoutPlanDto) {
    return this.subscriptions.checkout(user, dto.plan, dto.interval);
  }

  /** After Paystack redirects back: applies the payment without waiting for the webhook. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('confirm')
  confirm(@CurrentUser() user: SellerUser, @Body() dto: ConfirmPlanDto) {
    return this.subscriptions.confirm(user, dto.reference);
  }

  /** Paystack's hosted page for changing the card or cancelling. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('manage')
  manage(@CurrentUser() user: SellerUser) {
    return this.subscriptions.manageLink(user.sellerId);
  }
}
