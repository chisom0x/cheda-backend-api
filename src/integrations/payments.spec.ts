import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  BachsService,
  BachsWebhookError,
  toDecimal,
  toMinor,
} from './bachs.service';
import { PaystackService } from './paystack.service';

const config = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] ?? '' }) as unknown as ConfigService;

describe('Bachs amounts', () => {
  it('converts kobo to decimal strings and back without floats', () => {
    expect(toDecimal(150000)).toBe('1500.00');
    expect(toDecimal(5)).toBe('0.05');
    expect(toMinor('1500.00')).toBe(150000);
    expect(toMinor('19.9')).toBe(1990);
    expect(toMinor('0.07')).toBe(7);
    expect(toMinor('1,500.00')).toBeNull();
    expect(toMinor(1500)).toBeNull();
  });
});

describe('Bachs webhook verification', () => {
  const secret = 'whsec_test';
  const bachs = new BachsService(
    config({ BACHS_WEBHOOK_SECRET: secret }) as never,
  );
  const body = Buffer.from(
    JSON.stringify({
      id: 'evt_1',
      type: 'checkout.completed',
      created_at: '2026-11-16T00:00:00Z',
      organization_id: 'acct_1',
      data: { reference: 'CHD_1' },
    }),
  );
  const sign = (t: number, raw: Buffer, key = secret) =>
    createHmac('sha256', key).update(`${t}.`).update(raw).digest('hex');
  const now = () => Math.floor(Date.now() / 1000);

  it('accepts a valid V2 signature, including during rotation', () => {
    const t = now();
    const header = `t=${t},v1=${sign(t, body, 'whsec_old')},v1=${sign(t, body)}`;
    const event = bachs.constructEvent(body, {
      'x-bachs-signature-v2': header,
    });
    expect(event.id).toBe('evt_1');
  });

  it('rejects a tampered body', () => {
    const t = now();
    const tampered = Buffer.from(body.toString().replace('CHD_1', 'CHD_2'));
    expect(() =>
      bachs.constructEvent(tampered, {
        'x-bachs-signature-v2': `t=${t},v1=${sign(t, body)}`,
      }),
    ).toThrow(BachsWebhookError);
  });

  it('rejects a replayed (stale) delivery', () => {
    const t = now() - 3600;
    expect(() =>
      bachs.constructEvent(body, {
        'x-bachs-signature-v2': `t=${t},v1=${sign(t, body)}`,
      }),
    ).toThrow(BachsWebhookError);
  });
});

describe('Paystack webhook verification', () => {
  const key = 'sk_test_x';
  const paystack = new PaystackService(
    config({ PAYSTACK_SECRET_KEY: key }) as never,
  );
  const body = Buffer.from('{"event":"charge.success","data":{}}');
  const sig = createHmac('sha512', key).update(body.toString()).digest('hex');

  it('accepts the secret-key HMAC and rejects anything else', () => {
    expect(paystack.isValidSignature(body, sig)).toBe(true);
    expect(paystack.isValidSignature(body, sig.replace(/^./, '0'))).toBe(false);
    expect(paystack.isValidSignature(body, undefined)).toBe(false);
    expect(paystack.isValidSignature(Buffer.from('{}'), sig)).toBe(false);
  });
});
