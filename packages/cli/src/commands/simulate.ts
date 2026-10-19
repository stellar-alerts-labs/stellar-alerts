import { Command } from 'commander';
import chalk from 'chalk';
import {
  SorobanRpcClient,
  TransactionSimulationReport,
  DEFAULT_SOROBAN_RPC_URL,
  DEFAULT_BASE_FEE_STROOPS,
} from '../lib/soroban-rpc.js';

export interface SimulateCommandOptions {
  rpcUrl?: string;
  baseFee?: string | number;
  json?: boolean;
  client?: SorobanRpcClient;
  logger?: Pick<typeof console, 'log' | 'error'>;
}

export function formatSimulationReportText(
  report: TransactionSimulationReport
): string {
  const lines: string[] = [];
  const statusBadge =
    report.status === 'SUCCESS'
      ? chalk.green.bold('SUCCESS')
      : chalk.red.bold('FAILED');

  lines.push(chalk.bold.blue('🔬 Soroban Transaction Simulation Report'));
  lines.push(chalk.gray('─'.repeat(60)));
  lines.push(`  Status:              ${statusBadge}`);
  lines.push(`  RPC Node:            ${report.rpcUrl}`);
  if (report.latestLedger !== null) {
    lines.push(`  Latest Ledger:       ${report.latestLedger}`);
  }
  if (report.error) {
    lines.push(`  Error:               ${chalk.red(report.error)}`);
  }

  lines.push('');
  lines.push(chalk.bold('⚙️  Resource Consumption & Footprint'));
  lines.push(
    `  CPU Instructions:    ${report.resources.cpuInstructions.toLocaleString('en-US')}`
  );
  lines.push(
    `  Memory (RAM) Usage:  ${report.resources.memoryBytes.toLocaleString('en-US')} bytes`
  );
  lines.push(
    `  Ledger Read / Write: ${report.resources.readBytes} B read (${report.resources.ledgerReadCount} keys) / ${report.resources.writeBytes} B write (${report.resources.ledgerWriteCount} keys)`
  );
  if (report.footprint.readOnly.length > 0) {
    lines.push(`  Read-Only Keys:      ${report.footprint.readOnly.join(', ')}`);
  }
  if (report.footprint.readWrite.length > 0) {
    lines.push(`  Read-Write Keys:     ${report.footprint.readWrite.join(', ')}`);
  }

  lines.push('');
  lines.push(chalk.bold('💰 Estimated Network & Resource Fees'));
  lines.push(
    `  Base Inclusion Fee:  ${report.fees.baseFeeStroops} stroops`
  );
  lines.push(
    `  Min Resource Fee:    ${report.fees.minResourceFeeStroops} stroops`
  );
  lines.push(
    `  Total Required Fee:  ${report.fees.totalFeeStroops} stroops (${report.fees.totalFeeXlm} XLM)`
  );

  lines.push('');
  lines.push(chalk.bold(`📡 Simulated Contract Events (${report.events.length})`));
  lines.push(JSON.stringify(report.events, null, 2));

  return lines.join('\n');
}

/**
 * Executes the `simulate <tx-xdr>` CLI workflow and returns `{ exitCode, report }`.
 */
export async function executeSimulateCommand(
  txXdr: string,
  options: SimulateCommandOptions = {}
): Promise<{ exitCode: number; report?: TransactionSimulationReport }> {
  const logger = options.logger ?? console;
  const rpcUrl = options.rpcUrl || DEFAULT_SOROBAN_RPC_URL;
  const baseFeeStroops =
    options.baseFee !== undefined
      ? Number(options.baseFee)
      : DEFAULT_BASE_FEE_STROOPS;

  if (!Number.isFinite(baseFeeStroops) || baseFeeStroops < 0) {
    logger.error(chalk.red('❌ Error: --base-fee must be a non-negative integer'));
    return { exitCode: 1 };
  }

  const client = options.client ?? new SorobanRpcClient(rpcUrl);

  try {
    const report = await client.simulateTransaction(txXdr, {
      baseFeeStroops,
    });

    if (options.json) {
      logger.log(JSON.stringify(report, null, 2));
    } else {
      logger.log(formatSimulationReportText(report));
    }

    return {
      exitCode: report.status === 'SUCCESS' ? 0 : 1,
      report,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      logger.error(
        JSON.stringify({ status: 'FAILED', error: message }, null, 2)
      );
    } else {
      logger.error(chalk.red(`❌ Simulation Error: ${message}`));
    }
    return { exitCode: 1 };
  }
}

export function registerSimulateCommands(program: Command): void {
  program
    .command('simulate')
    .description(
      'Simulate a base64-encoded Soroban transaction envelope and estimate CPU/RAM resource usage, ledger footprint, and fees'
    )
    .argument('<tx-xdr>', 'Base64-encoded Stellar/Soroban transaction envelope XDR')
    .option(
      '--rpc-url <url>',
      'Soroban RPC endpoint URL',
      DEFAULT_SOROBAN_RPC_URL
    )
    .option(
      '--base-fee <stroops>',
      'Base transaction inclusion fee in stroops',
      String(DEFAULT_BASE_FEE_STROOPS)
    )
    .option('--json', 'Output simulation report as structured JSON')
    .action(
      async (
        txXdr: string,
        opts: { rpcUrl?: string; baseFee?: string; json?: boolean }
      ) => {
        const { exitCode } = await executeSimulateCommand(txXdr, opts);
        if (exitCode !== 0) {
          process.exit(exitCode);
        }
      }
    );
}
