import { Command } from 'commander';
import chalk from 'chalk';
import { apiClient } from '../lib/api.js';
import { PaymentDTO } from '../lib/types.js';
import { CursorStore, defaultCursorFile } from '../lib/cursor-store.js';
import { runResilientStream } from '../lib/resilient-stream.js';

interface WatchOptions {
  wallet?: string;
  token?: string;
  color?: boolean;
  cursor?: string;
  cursorFile?: string;
  resume?: boolean;
  maxRetries?: string;
  maxBackoff?: string;
}

function warn(message: string): void {
  console.warn(chalk.yellow(`⚠  ${message}`));
}

/** Returns undefined when unset, null (after reporting) when invalid. */
function parseNonNegativeInt(value: string | undefined, flag: string): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(chalk.red(`❌ ${flag} must be a non-negative integer, got "${value}"`));
    return null;
  }
  return parsed;
}

function formatPayment(payment: PaymentDTO): string {
  const time = new Date(payment.receivedAt).toLocaleTimeString();
  const amount = chalk.bold.green(`+${payment.amount}`);
  const asset = chalk.cyan(payment.asset);
  const from = chalk.gray(payment.fromAddress.slice(0, 12) + '...' + payment.fromAddress.slice(-4));
  const memo = payment.memo ? chalk.yellow(` [${payment.memo}]`) : '';

  return `${chalk.gray(time)} │ ${amount.padStart(15)} ${asset.padEnd(8)} │ ${from}${memo}`;
}

function printHeader(): void {
  console.log(chalk.bold.blue('\n🌊 Stellar Payment Stream\n'));
  console.log(chalk.gray('─'.repeat(80)));
  console.log(
    chalk.bold(
      'Time'.padEnd(12) +
      '│ ' +
      'Amount'.padEnd(15) +
      'Asset'.padEnd(10) +
      '│ From'.padEnd(25) +
      'Memo'
    )
  );
  console.log(chalk.gray('─'.repeat(80)));
}

export function registerStreamCommands(program: Command): void {
  const stream = program
    .command('stream')
    .description('Watch real-time payment streams');

  stream
    .command('watch')
    .description('Watch real-time payment feed')
    .option('-w, --wallet <walletId>', 'Filter by specific wallet ID')
    .option('-t, --token <token>', 'API authentication token')
    .option('--no-color', 'Disable colored output')
    .option('--cursor <token>', 'Resume after this cursor ("now" = live tail, ignore saved cursor)')
    .option('--cursor-file <path>', 'Where the resume cursor is stored (default: ~/.stellar-alerts/stream-cursor[-<wallet>].json)')
    .option('--no-resume', 'Do not read or write the saved cursor')
    .option('--max-retries <number>', 'Consecutive reconnect attempts before giving up (default: unlimited)')
    .option('--max-backoff <ms>', 'Upper bound for the reconnect delay in milliseconds', '60000')
    .action(async (options: WatchOptions) => {
      if (options.token) {
        apiClient['apiKey'] = options.token;
      }

      const maxRetries = parseNonNegativeInt(options.maxRetries, '--max-retries');
      const maxDelayMs = parseNonNegativeInt(options.maxBackoff, '--max-backoff');
      if (maxRetries === null || maxDelayMs === null) {
        process.exitCode = 1;
        return;
      }

      const abortController = new AbortController();
      const shutdown = () => {
        if (abortController.signal.aborted) {
          // Second signal: the user wants out now.
          process.exit(130);
        }
        abortController.abort();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      const store = options.resume === false
        ? undefined
        : new CursorStore(options.cursorFile ?? defaultCursorFile(options.wallet), warn);
      const initialCursor = options.cursor === undefined ? undefined : options.cursor === 'now' ? '' : options.cursor;

      printHeader();
      console.log(chalk.gray('Connecting to payment stream...'));

      try {
        const result = await runResilientStream({
          connect: (cursor, signal) =>
            apiClient.openPaymentStream({ cursor: cursor || undefined, walletId: options.wallet, signal }),
          onPayment: (payment: PaymentDTO) => {
            console.log(formatPayment(payment));
          },
          signal: abortController.signal,
          store,
          initialCursor,
          maxRetries: maxRetries ?? Infinity,
          maxDelayMs: maxDelayMs ?? undefined,
          onConnected: (cursor) => {
            console.log(chalk.gray(cursor ? `Connected (resuming after ${cursor}).` : 'Connected (live).'));
          },
          onReconnect: ({ attempt, delayMs, error }) => {
            console.log(
              chalk.yellow(`⚠  Stream interrupted (${(error as Error)?.message ?? error}); reconnecting in ${(delayMs / 1000).toFixed(1)}s [attempt ${attempt}]`)
            );
          },
          onWarning: warn,
        });

        console.log(chalk.yellow('\n⏹  Stream stopped.'));
        console.log(chalk.gray(`Total payments received: ${result.received}`));
        if (result.suppressed > 0) {
          console.log(chalk.gray(`Duplicates suppressed: ${result.suppressed}`));
        }
      } catch (error) {
        console.error(chalk.red(`\n❌ Error: ${(error as Error).message}`));
        process.exitCode = 1;
      } finally {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
      }
    });

  stream
    .command('history')
    .description('Show recent payment history')
    .option('-w, --wallet <walletId>', 'Filter by specific wallet ID')
    .option('-l, --limit <number>', 'Number of payments to show', '20')
    .option('-t, --token <token>', 'API authentication token')
    .action(async (options: { wallet?: string; limit?: string; token?: string }) => {
      try {
        if (options.token) {
          apiClient['apiKey'] = options.token;
        }

        const limit = parseInt(options.limit || '20', 10);
        const payments = await apiClient.getPayments(options.wallet, limit);

        if (payments.length === 0) {
          console.log(chalk.yellow('📭 No payments found.'));
          return;
        }

        console.log(chalk.blue(`\n📜 Recent Payments (${payments.length})\n`));
        printHeader();

        for (const payment of payments) {
          console.log(formatPayment(payment));
        }

        console.log(chalk.gray('─'.repeat(80)));
        console.log('');
      } catch (error) {
        console.error(chalk.red(`❌ Error: ${(error as Error).message}`));
        process.exit(1);
      }
    });
}
