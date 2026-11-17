import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map, Observable } from 'rxjs';

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(
    _ctx: ExecutionContext,
    next: CallHandler,
  ): Observable<{ success: true; data: unknown }> {
    return next
      .handle()
      .pipe(map((data: unknown) => ({ success: true, data: data ?? null })));
  }
}
