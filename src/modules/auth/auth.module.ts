import { Module } from '@nestjs/common';
import { SellersModule } from '../sellers/sellers.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';

@Module({
  imports: [SellersModule],
  controllers: [AuthController],
  providers: [AuthService, OtpService],
})
export class AuthModule {}
