import { Module } from '@nestjs/common';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';
import { StreamController } from './stream.controller';

@Module({
  controllers: [LibraryController, StreamController],
  providers: [LibraryService],
})
export class LibraryModule {}
