/**
 * Creates (or resets) the admin account used on the admin subdomain. Re-runnable.
 *
 *   pnpm run seed:admin [email] [password]
 *
 * Falls back to ADMIN_EMAIL / ADMIN_PASSWORD, and generates a password when none is given.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  const email = (
    process.argv[2] ??
    process.env.ADMIN_EMAIL ??
    'admin@cheda.app'
  )
    .trim()
    .toLowerCase();
  const password =
    process.argv[3] ??
    (process.env.ADMIN_PASSWORD || randomBytes(12).toString('base64url'));
  if (password.length < 8)
    throw new Error('Use a password of at least 8 characters.');

  const passwordHash = await hash(password);
  const admin = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: 'Cheda Admin',
      passwordHash,
      role: 'admin',
      emailVerifiedAt: new Date(),
    },
    update: { passwordHash, role: 'admin', emailVerifiedAt: new Date() },
    select: { id: true },
  });
  // A reset password signs the admin out everywhere
  await prisma.session.updateMany({
    where: { userId: admin.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  console.log(`Admin ready: ${email} / ${password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
