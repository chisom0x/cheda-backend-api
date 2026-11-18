import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  Auth,
  type AuthUser,
  CurrentUser,
} from '../../common/auth/auth.decorator';
import { MultipartDto, UploadDto } from './uploads.dto';
import { UploadsService } from './uploads.service';

@ApiTags('uploads')
@Auth()
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: UploadDto) {
    return this.uploads.create(user, dto);
  }

  @Post(':id/complete')
  complete(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: MultipartDto,
  ) {
    return this.uploads.complete(user, id, dto.uploadId);
  }

  @Post(':id/abort')
  abort(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: MultipartDto,
  ) {
    return this.uploads.abort(user, id, dto.uploadId);
  }
}
