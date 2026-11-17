import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  Auth,
  type AuthUser,
  CurrentUser,
} from '../../common/auth/auth.decorator';
import { MediaQueryDto, ProgressDto } from './library.dto';
import { LibraryService } from './library.service';

/** Sent by the Cheda app: proves (via Firebase App Check) that protected content is opened in the app. */
const APP_CHECK_HEADER = 'x-firebase-appcheck';

@ApiTags('library')
@Auth()
@Controller('me')
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @Get('library')
  list(@CurrentUser() user: AuthUser) {
    return this.library.list(user);
  }

  @Get('library/:productId')
  get(
    @CurrentUser() user: AuthUser,
    @Param('productId') productId: string,
    @Headers(APP_CHECK_HEADER) appCheck?: string,
  ) {
    return this.library.get(user, productId, appCheck);
  }

  @Put('library/:productId/progress')
  saveProgress(
    @CurrentUser() user: AuthUser,
    @Param('productId') productId: string,
    @Body() dto: ProgressDto,
  ) {
    return this.library.saveProgress(user, productId, dto);
  }

  @Get('library/:productId/files/:fileId')
  media(
    @CurrentUser() user: AuthUser,
    @Param('productId') productId: string,
    @Param('fileId') fileId: string,
    @Query() query: MediaQueryDto,
    @Headers(APP_CHECK_HEADER) appCheck?: string,
  ) {
    return this.library.media(
      user,
      productId,
      fileId,
      query.mode ?? 'download',
      appCheck,
    );
  }

  @Get('purchases')
  purchases(@CurrentUser() user: AuthUser) {
    return this.library.purchases(user);
  }

  @Get('purchases/:id')
  receipt(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.library.receipt(user, id);
  }
}
