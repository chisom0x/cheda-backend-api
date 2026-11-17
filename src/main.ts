import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { Env } from './config/env';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.useBodyParser('json', { limit: '1mb' });
  // The frontend and its admin. subdomain (admin panel) both call the API
  const frontend = new URL(config.get('FRONTEND_URL', { infer: true }));
  app.enableCors({
    origin: [frontend.origin, `${frontend.protocol}//admin.${frontend.host}`],
    credentials: false,
    maxAge: 600,
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      stopAtFirstError: true,
    }),
  );
  app.enableShutdownHooks();

  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Cheda API')
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  Logger.log(
    `API listening on http://localhost:${port}/api (docs at /api/docs)`,
    'Bootstrap',
  );
}

void bootstrap();
