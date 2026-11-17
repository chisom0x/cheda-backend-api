import { IsIn, Matches } from 'class-validator';
import {
  BillingInterval,
  SubscriptionPlan,
} from '../../generated/prisma/client';

export class CheckoutPlanDto {
  @IsIn(Object.values(SubscriptionPlan), { message: 'Choose a plan.' })
  plan: SubscriptionPlan;

  @IsIn(Object.values(BillingInterval), {
    message: 'Choose how often to pay.',
  })
  interval: BillingInterval;
}

export class ConfirmPlanDto {
  @Matches(/^[A-Za-z0-9_-]{1,100}$/, { message: 'Invalid payment reference.' })
  reference: string;
}
