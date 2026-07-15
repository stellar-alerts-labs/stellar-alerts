import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env';

const prisma = new PrismaClient();

async function main() {
  console.log('--- TESTING API INTEGRATION ---');
  
  let user = await prisma.user.findFirst({ where: { email: 'integration@example.com' } });
  if (!user) {
    user = await prisma.user.create({ data: { email: 'integration@example.com' } });
  }
  
  const token = jwt.sign({ id: user.id, email: user.email }, env.JWT_SECRET, { expiresIn: '1h' });
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
  
  console.log('\n[1] POST /wallets');
  const res1 = await fetch('http://localhost:3001/wallets', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      publicKey: 'GAQOOUC23X66Z54OMV3DEXW4BXY34Q4E5G7R4TDF5B76G5RDBK5Z54E3',
      label: 'Integration Wallet'
    })
  });
  console.log(`Status: ${res1.status}`);
  const data1 = await res1.json();
  console.log(data1);
  
  console.log('\n[2] GET /wallets');
  const res2 = await fetch('http://localhost:3001/wallets', { headers });
  console.log(`Status: ${res2.status}`);
  const data2 = await res2.json();
  console.log('Wallets:', data2.wallets?.length);
  
  const walletId = data2.wallets?.[0]?.id;
  
  console.log('\n[3] GET /payments');
  const res3 = await fetch(`http://localhost:3001/payments?walletId=${walletId}`, { headers });
  console.log(`Status: ${res3.status}`);
  const data3 = await res3.json();
  console.log('Payments:', data3.payments?.length);
  
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
