import { Module } from '@nestjs/common';
import { PayoutsModule } from '../payouts/payouts.module';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [PayoutsModule],
  controllers: [AdminController],
  providers: [AdminService, AdminAnalyticsService],
})
export class AdminModule {}
