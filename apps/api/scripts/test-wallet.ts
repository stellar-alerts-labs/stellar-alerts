import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env';

const prisma = new PrismaClient();

async function main() {
  console.log('--- TESTING WALLET ENDPOINTS ---');
  
  // 1. Get existing user
  let user = await prisma.user.findFirst({ where: { email: 'favourtobiloba200@gmail.com' } });
  if (!user) {
    user = await prisma.user.create({ data: { email: 'favourtobiloba200@gmail.com' } });
  }
  
  console.log(`Using user ID: ${user.id}`);
  
  // 2. Sign JWT
  const token = jwt.sign({ id: user.id, email: user.email }, env.JWT_SECRET, { expiresIn: '1h' });
  
  // 3. Unauthenticated request
  console.log('\n[1] Testing UNAUTHENTICATED request...');
  const res1 = await fetch('http://localhost:3001/wallets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: 'GAQOOUC23X66Z54OMV3DEXW4BXY34Q4E5G7R4TDF5B76G5RDBK5Z54E3',
      label: 'My Stash'
    })
  });
  console.log(`Status: ${res1.status}`);
  console.log(await res1.json());
  
  // 4. Authenticated request
  console.log('\n[2] Testing AUTHENTICATED request...');
  const res2 = await fetch('http://localhost:3001/wallets', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      publicKey: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFJZIG262UXYO66EPEJ2Y',
      label: 'My Vault'
    })
  });
  console.log(`Status: ${res2.status}`);
  console.log(await res2.json());
  
  // 5. Check DB
  console.log('\n[3] Verifying Wallet in DB...');
  const wallets = await prisma.wallet.findMany({ where: { userId: user.id } });
  console.table(wallets);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
