import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as StellarSdk from 'stellar-sdk';
import {
  DEFAULT_BIP32_PATH,
  LedgerStellarApp,
  collectDestinations,
  formatStrKeyForReview,
  networkPassphraseFor,
  openLedgerStellarApp,
  signWithLedger,
} from '../lib/ledger.js';

export interface TxSignOptions {
  xdr?: string;
  xdrFile?: string;
  source?: string;
  destination?: string;
  amount?: string;
  asset?: string;
  sequence?: string;
  fee?: string;
  memo?: string;
  timeout?: string;
  network: string;
  path: string;
  out?: string;
}

function parseAsset(spec: string): StellarSdk.Asset {
  if (spec.toUpperCase() === 'XLM' || spec === 'native') return StellarSdk.Asset.native();
  const [code, issuer] = spec.split(':');
  if (!code || !issuer) throw new Error(`Invalid asset "${spec}", expected XLM or CODE:ISSUER`);
  return new StellarSdk.Asset(code, issuer);
}

/** Builds an unsigned payment envelope fully offline (the sequence number is supplied by the operator). */
export function buildPaymentTransaction(opts: TxSignOptions, passphrase: string): StellarSdk.Transaction {
  if (!opts.source || !opts.destination || !opts.amount || opts.sequence === undefined) {
    throw new Error('Building a transaction requires --source, --destination, --amount and --sequence');
  }
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(opts.source)) {
    throw new Error(`Invalid source StrKey: ${opts.source}`);
  }
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(opts.destination)) {
    throw new Error(`Invalid destination StrKey: ${opts.destination}`);
  }

  const account = new StellarSdk.Account(opts.source, opts.sequence);
  const builder = new StellarSdk.TransactionBuilder(account, {
    fee: opts.fee ?? StellarSdk.BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: opts.destination,
        asset: parseAsset(opts.asset ?? 'XLM'),
        amount: opts.amount,
      })
    )
    .setTimeout(Number(opts.timeout ?? 300));

  if (opts.memo) builder.addMemo(StellarSdk.Memo.text(opts.memo));
  return builder.build();
}

function loadTransaction(opts: TxSignOptions, passphrase: string): StellarSdk.Transaction {
  const rawXdr = opts.xdr ?? (opts.xdrFile ? fs.readFileSync(opts.xdrFile, 'utf8').trim() : undefined);
  if (rawXdr) {
    const parsed = StellarSdk.TransactionBuilder.fromXDR(rawXdr, passphrase);
    if ('innerTransaction' in parsed) {
      throw new Error('Fee-bump envelopes are not supported by the Ledger Stellar app; sign the inner transaction instead');
    }
    return parsed as StellarSdk.Transaction;
  }
  return buildPaymentTransaction(opts, passphrase);
}

export interface TxSignResult {
  signedXdr: string;
  hash: string;
  signer: string;
  destinations: string[];
}

/** Core flow, separated from process I/O so it can be driven with a mock Ledger app. */
export async function runTxSign(
  opts: TxSignOptions,
  app: LedgerStellarApp,
  log: (msg: string) => void = console.error
): Promise<TxSignResult> {
  const passphrase = networkPassphraseFor(opts.network);
  const tx = loadTransaction(opts, passphrase);
  const destinations = collectDestinations(tx);

  const { publicKey } = await app.getPublicKey(opts.path, true, false);
  if (tx.source !== publicKey) {
    throw new Error(
      `Transaction source ${tx.source} does not match the Ledger account ${publicKey} at path ${opts.path}`
    );
  }

  log(chalk.bold('\nTransaction summary'));
  log(`  Network:  ${opts.network}`);
  log(`  Source:   ${tx.source}`);
  log(`  Sequence: ${tx.sequence}`);
  log(`  Fee:      ${tx.fee} stroops`);
  log(`  Hash:     ${tx.hash().toString('hex')}`);
  log(chalk.yellow('\nVerify each destination on the Ledger screen before approving:'));
  for (const dest of destinations) {
    log(`  ${formatStrKeyForReview(dest)}`);
  }
  log(chalk.cyan('\nWaiting for approval on the Ledger device...'));

  const { signedXdr, signerPublicKey } = await signWithLedger(app, tx, opts.path);
  return { signedXdr, hash: tx.hash().toString('hex'), signer: signerPublicKey, destinations };
}

export function registerTxSignCommands(program: Command): void {
  program
    .command('tx-sign')
    .description('Build and sign a Stellar transaction offline using a Ledger hardware wallet')
    .option('--xdr <base64>', 'Unsigned transaction envelope XDR to sign')
    .option('--xdr-file <path>', 'File containing an unsigned transaction envelope XDR')
    .option('--source <G...>', 'Source account (must match the Ledger account)')
    .option('--destination <G...>', 'Payment destination StrKey')
    .option('--amount <amount>', 'Payment amount')
    .option('--asset <asset>', 'Asset as XLM or CODE:ISSUER', 'XLM')
    .option('--sequence <n>', 'Current source account sequence number (transaction uses n+1)')
    .option('--fee <stroops>', 'Fee per operation in stroops')
    .option('--memo <text>', 'Text memo')
    .option('--timeout <seconds>', 'Transaction validity window in seconds', '300')
    .option('--network <network>', 'public | testnet | futurenet | custom passphrase', 'testnet')
    .option('--path <bip32>', 'BIP32 derivation path', DEFAULT_BIP32_PATH)
    .option('-o, --out <file>', 'Write the signed XDR to a file instead of stdout')
    .action(async (opts: TxSignOptions) => {
      let app: LedgerStellarApp | undefined;
      try {
        app = await openLedgerStellarApp();
        const result = await runTxSign(opts, app);
        if (opts.out) {
          fs.writeFileSync(opts.out, result.signedXdr + '\n', 'utf8');
          console.error(chalk.green(`\n✅ Signed by ${result.signer}. XDR written to ${opts.out}`));
        } else {
          console.error(chalk.green(`\n✅ Signed by ${result.signer}`));
          console.log(result.signedXdr);
        }
      } catch (error) {
        console.error(chalk.red(`❌ ${(error as Error).message}`));
        process.exitCode = 1;
      } finally {
        await app?.close().catch(() => undefined);
      }
    });
}
