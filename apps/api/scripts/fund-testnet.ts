

async function fundAccount(publicKey: string) {
  console.log(`Funding testnet account: ${publicKey}`);
  try {
    const response = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
    if (response.ok) {
      const result = await response.json();
      console.log('Successfully funded! Response:', result);
    } else {
      console.error('Failed to fund account. Status:', response.status);
    }
  } catch (error) {
    console.error('Error contacting Friendbot:', error);
  }
}

const key = process.argv[2];
if (!key) {
  console.log('Usage: npx tsx apps/api/scripts/fund-testnet.ts <stellar_public_key>');
  process.exit(1);
}

fundAccount(key);
