import * as StellarSdk from 'stellar-sdk';

/** Default SEP-5 derivation path for the first Stellar account on a Ledger. */
export const DEFAULT_BIP32_PATH = "44'/148'/0'";

export interface LedgerPublicKey {
  publicKey: string;
}

export interface LedgerSignResult {
  signature: Buffer;
}

/**
 * Minimal surface of the Ledger Stellar app that this CLI relies on. Kept as an
 * interface so the signer can be swapped for a mock in tests / air-gapped rigs.
 */
export interface LedgerStellarApp {
  getPublicKey(path: string, validate?: boolean, display?: boolean): Promise<LedgerPublicKey>;
  signTransaction(path: string, signatureBase: Buffer): Promise<LedgerSignResult>;
  close(): Promise<void>;
}

/**
 * Opens a USB HID connection to a Ledger device running the Stellar app.
 * The Ledger libraries are loaded lazily so the rest of the CLI works without
 * them (they pull in native HID bindings, which are optional dependencies).
 */
export async function openLedgerStellarApp(): Promise<LedgerStellarApp> {
  let TransportNodeHid: any;
  let Str: any;
  try {
    // Variable specifiers keep TypeScript from requiring the optional packages at compile time.
    const transportModule = '@ledgerhq/hw-transport-node-hid';
    const appModule = '@ledgerhq/hw-app-str';
    TransportNodeHid = (await import(transportModule)).default;
    Str = (await import(appModule)).default;
  } catch {
    throw new Error(
      'Ledger support requires optional packages. Install them with: ' +
        'npm install @ledgerhq/hw-transport-node-hid @ledgerhq/hw-app-str'
    );
  }

  const transport = await TransportNodeHid.create();
  const app = new Str(transport);

  return {
    getPublicKey: (path, validate = true, display = false) =>
      app.getPublicKey(path, validate, display),
    signTransaction: (path, signatureBase) => app.signTransaction(path, signatureBase),
    close: () => transport.close(),
  };
}

export function networkPassphraseFor(network: string): string {
  switch (network.toLowerCase()) {
    case 'public':
    case 'mainnet':
      return StellarSdk.Networks.PUBLIC;
    case 'testnet':
      return StellarSdk.Networks.TESTNET;
    case 'futurenet':
      return StellarSdk.Networks.FUTURENET;
    default:
      // Allow a raw passphrase for private networks.
      return network;
  }
}

/** Splits a StrKey into 4-character groups so it is easy to compare against the device screen. */
export function formatStrKeyForReview(strKey: string): string {
  return strKey.match(/.{1,4}/g)?.join(' ') ?? strKey;
}

/** Collects every StrKey destination the device will be asked to display. */
export function collectDestinations(tx: StellarSdk.Transaction): string[] {
  const out: string[] = [];
  for (const op of tx.operations as any[]) {
    if (typeof op.destination === 'string') out.push(op.destination);
    if (op.type === 'setOptions' && typeof op.inflationDest === 'string') out.push(op.inflationDest);
  }
  return Array.from(new Set(out));
}

/**
 * Signs the transaction with the Ledger. The Stellar app renders the operation
 * details (including the destination StrKey) on the device; the user must
 * approve there, and the host never touches a private key.
 */
export async function signWithLedger(
  app: LedgerStellarApp,
  tx: StellarSdk.Transaction,
  path: string
): Promise<{ signedXdr: string; signerPublicKey: string }> {
  const { publicKey } = await app.getPublicKey(path, true, false);
  const { signature } = await app.signTransaction(path, tx.signatureBase());

  const keypair = StellarSdk.Keypair.fromPublicKey(publicKey);
  if (!keypair.verify(tx.hash(), signature)) {
    throw new Error('Ledger returned a signature that does not verify against the device public key');
  }

  tx.addSignature(publicKey, signature.toString('base64'));
  return { signedXdr: tx.toEnvelope().toXDR('base64'), signerPublicKey: publicKey };
}
