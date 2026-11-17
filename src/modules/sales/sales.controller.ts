import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  Auth,
  CurrentUser,
  type SellerUser,
} from '../../common/auth/auth.decorator';
import { OrderFiltersDto, SearchDto, StatsQueryDto } from './sales.dto';
import { SalesService } from './sales.service';

@ApiTags('sales')
@Auth('seller')
@Controller('me')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get('analytics')
  stats(@CurrentUser() user: SellerUser, @Query() query: StatsQueryDto) {
    return this.sales.stats(user.sellerId, query.range);
  }

  @Get('orders')
  orders(@CurrentUser() user: SellerUser, @Query() filters: OrderFiltersDto) {
    return this.sales.orders(user.sellerId, filters);
  }

  @Get('customers')
  customers(@CurrentUser() user: SellerUser, @Query() query: SearchDto) {
    return this.sales.customers(user.sellerId, query.search);
  }

  @Get('customers/:email')
  customer(@CurrentUser() user: SellerUser, @Param('email') email: string) {
    return this.sales.customer(user.sellerId, email);
  }
}
