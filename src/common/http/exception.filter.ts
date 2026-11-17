import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const [status, error] = this.resolve(exception);
    if (status >= 500)
      this.logger.error(
        exception instanceof Error ? exception.stack : exception,
      );
    res.status(status).json({ success: false, data: null, error });
  }

  private resolve(exception: unknown): [number, string] {
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : (body as { message?: string | string[] }).message;
      return [
        exception.getStatus(),
        (Array.isArray(message) ? message[0] : message) ?? exception.message,
      ];
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002')
        return [HttpStatus.CONFLICT, 'That already exists.'];
      if (exception.code === 'P2025')
        return [HttpStatus.NOT_FOUND, 'Not found.'];
      if (exception.code === 'P2003')
        return [HttpStatus.BAD_REQUEST, 'A referenced record does not exist.'];
    }
    return [
      HttpStatus.INTERNAL_SERVER_ERROR,
      'Something went wrong. Please try again.',
    ];
  }
}
