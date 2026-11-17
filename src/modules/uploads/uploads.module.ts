import { Module } from '@nestjs/common';
import { TranscodeService } from './transcode.service';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  controllers: [UploadsController],
  providers: [UploadsService, TranscodeService],
})
export class UploadsModule {}
