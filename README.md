# Cheda API

NestJS + Prisma (PostgreSQL). All routes live under `/api` and respond with `{ success, data, error? }`.
Swagger UI: `http://localhost:9001/api/docs` (disabled when `NODE_ENV=production`).

## Setup

```bash
cp .env.example .env          # fill in values; see comments in the file
pnpm install                  # also generates the Prisma client
pnpm run prisma migrate dev   # create/upgrade the schema
pnpm run start:dev
```

Production: `pnpm run build && pnpm run db:migrate && pnpm run start:prod`.

## Services

| Service | Used for | Notes |
| --- | --- | --- |
| ZeptoMail | Purchase emails, new-sale alerts, OTPs | Without `ZEPTOMAIL_TOKEN`, emails are printed to the console (links included). |
| OTP | Password reset, email verification | `OTP_EMAIL_ENABLED=false` sends nothing and the code is always `424242`. The API refuses to boot in production with it off. |
| Firebase Admin | Google sign-in | Verifies Firebase ID tokens sent by the frontend. |
| Backblaze B2 | Product files (private bucket), images (public bucket) | Browsers upload directly with presigned URLs, so add a CORS rule on both buckets allowing `PUT` from `FRONTEND_URL` with `content-type` header. The private bucket also needs `GET` from `FRONTEND_URL` so the player can fetch video segments. |
| ffmpeg | Adaptive video streaming | Uploaded videos are transcoded in the background (every minute) into HLS at 360p/720p/1080p under `hls/<asset id>/` in the private bucket. `ffmpeg` and `ffprobe` must be on `PATH`; without them videos still play from the original file. |
| Monnify | Payments | Sandbox in dev. Checkout returns a Monnify `checkoutUrl`; payment is confirmed by re-querying Monnify, either from the webhook (`POST /api/webhooks/monnify`, set it in the Monnify dashboard) or when the buyer lands on the success page. Also used for bank account name enquiry. |

## Notes

- To use a different port, set `PORT` here and the frontend's `NEXT_PUBLIC_API_URL`.
- Amounts are stored in minor units (kobo / cents).
- Buyers see guest purchases in their library once their email is verified (OTP, Google, or the purchase access link).
