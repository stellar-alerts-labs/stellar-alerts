import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import {
  SorobanRpcClient,
  isValidBase64Xdr,
  stroopsToXlm,
} from '../lib/soroban-rpc.js';
import {
  executeSimulateCommand,
  registerSimulateCommands,
} from './simulate.js';

const SAMPLE_VALID_XDR = Buffer.from(
  'stellar-soroban-mock-transaction-envelope-payload-0001'
).toString('base64');

describe('Offline Transaction Simulation & Resource Fee Estimation CLI (#635)', () => {
  it('validates base64 XDR envelopes and converts stroops to XLM accurately', () => {
    expect(isValidBase64Xdr(SAMPLE_VALID_XDR)).toBe(true);
    expect(isValidBase64Xdr('not-valid-base64!!!')).toBe(false);
    expect(isValidBase64Xdr('')).toBe(false);
    expect(stroopsToXlm(10_000_000)).toBe('1.0000000');
    expect(stroopsToXlm(74_250)).toBe('0.0074250');
  });

  it('simulates a valid XDR envelope against Soroban RPC and outputs CPU/RAM, footprint, fees, and contract events', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 'stellar-alerts-cli-simulate',
        result: {
          latestLedger: 1_240_500,
          minResourceFee: '68400',
          cost: {
            cpuInsns: '1450200',
            memBytes: '328192',
            readBytes: 2048,
            writeBytes: 512,
          },
          footprint: {
            readOnly: ['ContractCode(CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC)'],
            readWrite: ['ContractData(Balance:GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7)'],
          },
          events: [
            {
              type: 'contract',
              contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
              topics: ['transfer', 'GAAZI4...'],
              data: { amount: '250000000', asset: 'USDC' },
            },
          ],
          results: [{ xdr: 'AAAAEAAA==' }],
        },
      }),
    });

    const logs: string[] = [];
    const errors: string[] = [];
    const client = new SorobanRpcClient(
      'https://soroban-testnet.stellar.org',
      mockFetch as unknown as typeof fetch
    );

    const outcome = await executeSimulateCommand(SAMPLE_VALID_XDR, {
      baseFee: 100,
      client,
      logger: {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => errors.push(msg),
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect(errors).toHaveLength(0);
    expect(outcome.report?.status).toBe('SUCCESS');
    expect(outcome.report?.resources.cpuInstructions).toBe(1_450_200);
    expect(outcome.report?.resources.memoryBytes).toBe(328_192);
    expect(outcome.report?.fees.minResourceFeeStroops).toBe(68_400);
    expect(outcome.report?.fees.totalFeeStroops).toBe(68_500);
    expect(outcome.report?.fees.totalFeeXlm).toBe('0.0068500');
    expect(outcome.report?.events).toHaveLength(1);

    const renderedText = logs.join('\n');
    expect(renderedText).toContain('SUCCESS');
    expect(renderedText).toContain('1,450,200');
    expect(renderedText).toContain('328,192 bytes');
    expect(renderedText).toContain('68500 stroops (0.0068500 XLM)');
    expect(renderedText).toContain('"topics"');
    expect(renderedText).toContain('"transfer"');
  });

  it('returns exitCode 1 and renders error details when simulation fails on-chain or XDR is malformed', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 'stellar-alerts-cli-simulate',
        result: {
          latestLedger: 1_240_505,
          error: 'HostError: Error(WasmVm, InvalidAction) - insufficient allowance',
          cost: {
            cpuInsns: '420000',
            memBytes: '64000',
          },
          events: [],
        },
      }),
    });

    const logs: string[] = [];
    const errors: string[] = [];
    const client = new SorobanRpcClient(
      'https://soroban-testnet.stellar.org',
      mockFetch as unknown as typeof fetch
    );

    const failedSim = await executeSimulateCommand(SAMPLE_VALID_XDR, {
      client,
      logger: {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => errors.push(msg),
      },
    });

    expect(failedSim.exitCode).toBe(1);
    expect(failedSim.report?.status).toBe('FAILED');
    expect(logs.join('\n')).toContain('insufficient allowance');

    // Malformed XDR input
    const badXdrOutcome = await executeSimulateCommand('invalid_xdr_payload!', {
      client,
      logger: {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => errors.push(msg),
      },
    });

    expect(badXdrOutcome.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/Invalid transaction XDR/i);

    // Verify Commander CLI argument parser registration
    const program = new Command();
    registerSimulateCommands(program);
    const simCmd = program.commands.find((c) => c.name() === 'simulate');
    expect(simCmd).toBeDefined();
    expect(simCmd?.description()).toContain('Simulate a base64-encoded Soroban transaction');
  });
});
