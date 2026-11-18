import { Module } from '@nestjs/common';
import { PayoutsModule } from '../payouts/payouts.module';
import { SellersModule } from '../sellers/sellers.module';
import { AccountDeletionService } from './account-deletion.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';

@Module({
  imports: [SellersModule, PayoutsModule],
  controllers: [AuthController],
  providers: [AuthService, OtpService, AccountDeletionService],
})
export class AuthModule {}
