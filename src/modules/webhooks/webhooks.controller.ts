import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  BachsEvent,
  BachsService,
  BachsWebhookError,
} from '../../integrations/bachs.service';
import {
  PaystackEvent,
  PaystackService,
} from '../../integrations/paystack.service';
import { CheckoutService } from '../checkout/checkout.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

/**
 * Both providers retry on 5xx, so a handler that fails throws and the event is delivered again.
 * Signatures are checked on the raw bytes before anything is parsed.
 */
@ApiExcludeController()
@SkipThrottle()
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly bachs: BachsService,
    private readonly paystack: PaystackService,
    private readonly checkout: CheckoutService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  /** Product sales: checkout.completed, collection.succeeded, checkout.expired. */
  @HttpCode(200)
  @Post('bachs')
  async bachsEvent(@Req() req: RawBodyRequest<Request>) {
    if (!req.rawBody) throw new BadRequestException('Invalid webhook.');
    let event: BachsEvent;
    try {
      event = this.bachs.constructEvent(req.rawBody, req.headers);
    } catch (e) {
      // 400 tells Bachs not to retry a delivery it can never pass
      if (e instanceof BachsWebhookError)
        throw new BadRequestException('Invalid webhook.');
      throw e;
    }
    await this.checkout.handleEvent(event);
    return { received: true };
  }

  /** Plan billing: charges, subscription and invoice events. */
  @HttpCode(200)
  @Post('paystack')
  async paystackEvent(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature?: string,
  ) {
    if (!req.rawBody || !this.paystack.isValidSignature(req.rawBody, signature))
      throw new UnauthorizedException('Invalid signature.');
    const event = JSON.parse(req.rawBody.toString('utf8')) as PaystackEvent;
    await this.subscriptions.handleEvent(event);
    return { received: true };
  }
}
