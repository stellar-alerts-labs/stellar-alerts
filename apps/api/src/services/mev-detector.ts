export interface SorobanCall {
  contractId: string;
  functionName: string;
  args: Record<string, any>;
}

export interface SorobanTransaction {
  txHash: string;
  ledgerSeq: number;
  sourceAccount: string;
  calls: SorobanCall[];
  fee: number;
  index: number;
}

export interface SorobanBlock {
  ledgerSeq: number;
  transactions: SorobanTransaction[];
}

export interface FlashLoanArbitrageDetection {
  txHash: string;
  ledgerSeq: number;
  borrowContract: string;
  borrowAmount: number;
  repayAmount: number;
  netProfit: number;
  poolsInvolved: string[];
}

export interface SandwichAttackDetection {
  ledgerSeq: number;
  targetPool: string;
  frontRunTx: string;
  victimTx: string;
  backRunTx: string;
  attackerAccount: string;
  estimatedProfit: number;
}

export interface ArbitrageLoopDetection {
  ledgerSeq: number;
  txHash: string;
  tokenPath: string[];
  poolPath: string[];
  estimatedProfit: number;
}

export interface MevDetectionResult {
  ledgerSeq: number;
  flashLoans: FlashLoanArbitrageDetection[];
  sandwichAttacks: SandwichAttackDetection[];
  arbitrageLoops: ArbitrageLoopDetection[];
  totalMevEventsCount: number;
}

export class MevDetectorEngine {
  private static FLASH_LOAN_KEYWORDS = ['borrow', 'flash_loan', 'vault_borrow', 'take_flash_loan'];
  private static REPAY_KEYWORDS = ['repay', 'flash_repay', 'return_loan', 'vault_repay'];
  private static SWAP_KEYWORDS = ['swap', 'swap_exact_tokens_for_tokens', 'trade', 'exchange'];

  public analyzeBlock(block: SorobanBlock): MevDetectionResult {
    const flashLoans: FlashLoanArbitrageDetection[] = [];

    for (const tx of block.transactions) {
      const fl = this.detectFlashLoanInTx(tx);
      if (fl) {
        flashLoans.push(fl);
      }
    }

    const sandwichAttacks = this.detectSandwichAttacks(block.transactions, block.ledgerSeq);
    const arbitrageLoops = this.detectArbitrageLoops(block.transactions, block.ledgerSeq);

    return {
      ledgerSeq: block.ledgerSeq,
      flashLoans,
      sandwichAttacks,
      arbitrageLoops,
      totalMevEventsCount: flashLoans.length + sandwichAttacks.length + arbitrageLoops.length,
    };
  }

  public detectFlashLoanInTx(tx: SorobanTransaction): FlashLoanArbitrageDetection | null {
    let borrowCall: SorobanCall | null = null;
    let repayCall: SorobanCall | null = null;
    const poolsInvolved: Set<string> = new Set();

    for (const call of tx.calls) {
      const fn = call.functionName.toLowerCase();
      if (MevDetectorEngine.FLASH_LOAN_KEYWORDS.some((kw) => fn.includes(kw))) {
        borrowCall = call;
      }
      if (MevDetectorEngine.REPAY_KEYWORDS.some((kw) => fn.includes(kw))) {
        repayCall = call;
      }
      if (MevDetectorEngine.SWAP_KEYWORDS.some((kw) => fn.includes(kw))) {
        poolsInvolved.add(call.contractId);
      }
    }

    if (borrowCall && repayCall) {
      const borrowAmount = Number(borrowCall.args.amount || borrowCall.args.borrow_amount || 0);
      const repayAmount = Number(repayCall.args.amount || repayCall.args.repay_amount || 0);
      const netProfit = Math.max(0, repayAmount - borrowAmount - tx.fee);

      return {
        txHash: tx.txHash,
        ledgerSeq: tx.ledgerSeq,
        borrowContract: borrowCall.contractId,
        borrowAmount,
        repayAmount,
        netProfit,
        poolsInvolved: Array.from(poolsInvolved),
      };
    }

    return null;
  }

  public detectSandwichAttacks(transactions: SorobanTransaction[], ledgerSeq: number): SandwichAttackDetection[] {
    const detections: SandwichAttackDetection[] = [];
    if (transactions.length < 3) return detections;

    // Group swaps by contract (pool)
    for (let i = 0; i < transactions.length - 2; i++) {
      const frontRun = transactions[i];
      const victim = transactions[i + 1];
      const backRun = transactions[i + 2];

      // Front run and back run should be from the same attacker or associated account
      if (frontRun.sourceAccount !== backRun.sourceAccount) continue;
      if (frontRun.sourceAccount === victim.sourceAccount) continue;

      const frontSwap = frontRun.calls.find((c) =>
        MevDetectorEngine.SWAP_KEYWORDS.some((kw) => c.functionName.toLowerCase().includes(kw))
      );
      const victimSwap = victim.calls.find((c) =>
        MevDetectorEngine.SWAP_KEYWORDS.some((kw) => c.functionName.toLowerCase().includes(kw))
      );
      const backSwap = backRun.calls.find((c) =>
        MevDetectorEngine.SWAP_KEYWORDS.some((kw) => c.functionName.toLowerCase().includes(kw))
      );

      if (frontSwap && victimSwap && backSwap && frontSwap.contractId === victimSwap.contractId && victimSwap.contractId === backSwap.contractId) {
        const estProfit = Math.max(
          1,
          Number(backSwap.args.amount_out || backSwap.args.amountOut || 0) -
            Number(frontSwap.args.amount_in || frontSwap.args.amountIn || 0)
        );

        detections.push({
          ledgerSeq,
          targetPool: frontSwap.contractId,
          frontRunTx: frontRun.txHash,
          victimTx: victim.txHash,
          backRunTx: backRun.txHash,
          attackerAccount: frontRun.sourceAccount,
          estimatedProfit: estProfit,
        });
      }
    }

    return detections;
  }

  public detectArbitrageLoops(transactions: SorobanTransaction[], ledgerSeq: number): ArbitrageLoopDetection[] {
    const loops: ArbitrageLoopDetection[] = [];

    for (const tx of transactions) {
      const swapCalls = tx.calls.filter((c) =>
        MevDetectorEngine.SWAP_KEYWORDS.some((kw) => c.functionName.toLowerCase().includes(kw))
      );

      if (swapCalls.length >= 2) {
        const poolPath = swapCalls.map((c) => c.contractId);
        const tokenPath: string[] = [];

        for (const call of swapCalls) {
          if (call.args.token_in) tokenPath.push(String(call.args.token_in));
          if (call.args.token_out) tokenPath.push(String(call.args.token_out));
        }

        const estProfit = Math.max(
          0,
          Number(swapCalls[swapCalls.length - 1].args.amount_out || 0) - Number(swapCalls[0].args.amount_in || 0)
        );

        loops.push({
          ledgerSeq,
          txHash: tx.txHash,
          tokenPath,
          poolPath,
          estimatedProfit: estProfit,
        });
      }
    }

    return loops;
  }
}

export const mevDetectorEngine = new MevDetectorEngine();
