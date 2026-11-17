import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  Auth,
  type AuthUser,
  CurrentUser,
} from '../../common/auth/auth.decorator';
import { AdminAnalyticsService } from './admin-analytics.service';
import {
  DeclineDto,
  ProductsQueryDto,
  PurchasesQueryDto,
  RangeDto,
  SubscriptionPaymentsQueryDto,
  SubscriptionsQueryDto,
  UsersQueryDto,
  WithdrawalsQueryDto,
} from './admin.dto';
import { AdminService } from './admin.service';

@ApiTags('admin')
@Auth('admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly analytics: AdminAnalyticsService,
  ) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.admin.me(user.id);
  }

  @Get('overview')
  overview(@Query() dto: RangeDto) {
    return this.analytics.overview(dto);
  }

  @Get('analytics')
  fullAnalytics(@Query() dto: RangeDto) {
    return this.analytics.analytics(dto);
  }

  @Get('finance')
  finance(@Query() dto: RangeDto) {
    return this.analytics.finance(dto);
  }

  @Get('finance/purchases')
  purchases(@Query() dto: PurchasesQueryDto) {
    return this.admin.purchases(dto);
  }

  @Get('finance/subscription-payments')
  subscriptionPayments(@Query() dto: SubscriptionPaymentsQueryDto) {
    return this.admin.subscriptionPayments(dto);
  }

  @Get('finance/subscriptions')
  subscriptions(@Query() dto: SubscriptionsQueryDto) {
    return this.admin.subscriptions(dto);
  }

  @Get('users')
  users(@Query() dto: UsersQueryDto) {
    return this.admin.users(dto);
  }

  @Get('users/:id')
  user(@Param('id') id: string) {
    return this.admin.user(id);
  }

  @Get('products')
  products(@Query() dto: ProductsQueryDto) {
    return this.admin.products(dto);
  }

  @Get('products/:id')
  product(@Param('id') id: string) {
    return this.admin.product(id);
  }

  @Get('withdrawals')
  withdrawals(@Query() dto: WithdrawalsQueryDto) {
    return this.admin.withdrawals(dto);
  }

  @HttpCode(200)
  @Post('withdrawals/:id/approve')
  approve(@Param('id') id: string) {
    return this.admin.approveWithdrawal(id);
  }

  @HttpCode(200)
  @Post('withdrawals/:id/decline')
  decline(@Param('id') id: string, @Body() dto: DeclineDto) {
    return this.admin.declineWithdrawal(id, dto.reason);
  }
}
