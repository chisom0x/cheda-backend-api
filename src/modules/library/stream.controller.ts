import { Controller, Get, Param, ParseIntPipe, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { LibraryService } from './library.service';

/** HLS playlists; no session auth, the path token (from GET /me/library/:id/files/:id) grants access. */
@ApiTags('library')
@Controller('stream/:token')
export class StreamController {
  constructor(private readonly library: LibraryService) {}

  @Get('master.m3u8')
  async master(@Param('token') token: string, @Res() res: Response) {
    sendPlaylist(res, await this.library.playlist(token));
  }

  @Get(':variant/index.m3u8')
  async variant(
    @Param('token') token: string,
    @Param('variant', ParseIntPipe) variant: number,
    @Res() res: Response,
  ) {
    sendPlaylist(res, await this.library.playlist(token, variant));
  }
}

/**
 * Playlists are raw m3u8, not the JSON envelope; they embed signed URLs so are never cached.
 * Cross-origin resource policy lets the native <video> player on the frontend's origin load them.
 */
function sendPlaylist(res: Response, text: string) {
  res
    .type('application/vnd.apple.mpegurl')
    .set('Cache-Control', 'private, no-store')
    .set('Cross-Origin-Resource-Policy', 'cross-origin')
    .send(text);
}
