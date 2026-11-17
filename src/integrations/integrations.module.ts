import { Global, Module } from '@nestjs/common';
import { FirebaseService } from './firebase.service';
import { MailService } from './mail.service';
import { PaystackService } from './paystack.service';
import { BachsService } from './bachs.service';
import { StorageService } from './storage.service';

const services = [
  MailService,
  StorageService,
  PaystackService,
  BachsService,
  FirebaseService,
];

@Global()
@Module({ providers: services, exports: services })
export class IntegrationsModule {}
