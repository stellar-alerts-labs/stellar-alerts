export interface MultisigSigner {
  address: string;
  weight: number;
  signed: boolean;
  signedAt?: Date;
}

export interface MultisigProposal {
  proposalId: string;
  accountAddress: string;
  requiredThreshold: number;
  currentWeight: number;
  signers: MultisigSigner[];
  validBeforeLedger?: number;
  validBeforeTime?: Date;
  sequenceNumber: number;
  createdAt: Date;
}

export interface MultisigAlertStatus {
  proposalId: string;
  accountAddress: string;
  isExpired: boolean;
  timeRemainingSeconds: number | null;
  ledgersRemaining: number | null;
  quorumPercentage: number;
  isQuorumMet: boolean;
  isUrgent: boolean;
  alertLevel: 'CRITICAL' | 'WARNING' | 'INFO' | 'OK';
  message: string;
}

export class MultisigProposalTracker {
  private proposals: Map<string, MultisigProposal> = new Map();

  public registerProposal(proposal: MultisigProposal): void {
    const totalWeight = proposal.signers
      .filter((s) => s.signed)
      .reduce((sum, s) => sum + s.weight, 0);

    this.proposals.set(proposal.proposalId, {
      ...proposal,
      currentWeight: totalWeight,
    });
  }

  public getProposal(proposalId: string): MultisigProposal | undefined {
    return this.proposals.get(proposalId);
  }

  public processSignerUpdate(proposalId: string, signerAddress: string, weight: number): boolean {
    const prop = this.proposals.get(proposalId);
    if (!prop) return false;

    const signer = prop.signers.find((s) => s.address.toLowerCase() === signerAddress.toLowerCase());
    if (signer) {
      signer.signed = true;
      signer.weight = weight;
      signer.signedAt = new Date();
    } else {
      prop.signers.push({
        address: signerAddress,
        weight,
        signed: true,
        signedAt: new Date(),
      });
    }

    prop.currentWeight = prop.signers
      .filter((s) => s.signed)
      .reduce((sum, s) => sum + s.weight, 0);

    return true;
  }

  public evaluateProposal(
    proposalId: string,
    currentLedgerSeq: number,
    currentTimeMs: number = Date.now()
  ): MultisigAlertStatus | null {
    const prop = this.proposals.get(proposalId);
    if (!prop) return null;

    const quorumPercentage = Number(
      Math.min(100, (prop.currentWeight / Math.max(1, prop.requiredThreshold)) * 100).toFixed(1)
    );
    const isQuorumMet = prop.currentWeight >= prop.requiredThreshold;

    let timeRemainingSeconds: number | null = null;
    if (prop.validBeforeTime) {
      timeRemainingSeconds = Math.max(0, Math.floor((prop.validBeforeTime.getTime() - currentTimeMs) / 1000));
    }

    let ledgersRemaining: number | null = null;
    if (prop.validBeforeLedger) {
      ledgersRemaining = Math.max(0, prop.validBeforeLedger - currentLedgerSeq);
    }

    const isExpired =
      (timeRemainingSeconds !== null && timeRemainingSeconds === 0) ||
      (ledgersRemaining !== null && ledgersRemaining === 0);

    let isUrgent = false;
    let alertLevel: 'CRITICAL' | 'WARNING' | 'INFO' | 'OK' = 'OK';
    let message = `Proposal ${proposalId} is active. Quorum: ${quorumPercentage}% (${prop.currentWeight}/${prop.requiredThreshold}).`;

    if (isExpired) {
      alertLevel = 'CRITICAL';
      message = `CRITICAL: Multi-sig proposal ${proposalId} has expired before reaching required quorum!`;
    } else if (!isQuorumMet) {
      const urgentByTime = timeRemainingSeconds !== null && timeRemainingSeconds < 24 * 3600;
      const urgentByLedgers = ledgersRemaining !== null && ledgersRemaining < 1000;

      if (urgentByTime || urgentByLedgers) {
        isUrgent = true;
        alertLevel = 'WARNING';
        message = `URGENT QUORUM WARNING: Proposal ${proposalId} expires in ${
          timeRemainingSeconds ? `${Math.floor(timeRemainingSeconds / 60)} mins` : `${ledgersRemaining} ledgers`
        } and needs ${prop.requiredThreshold - prop.currentWeight} more weight to reach quorum.`;
      } else {
        alertLevel = 'INFO';
      }
    } else {
      alertLevel = 'OK';
      message = `Quorum met for proposal ${proposalId} (${prop.currentWeight}/${prop.requiredThreshold}). Ready for execution.`;
    }

    return {
      proposalId,
      accountAddress: prop.accountAddress,
      isExpired,
      timeRemainingSeconds,
      ledgersRemaining,
      quorumPercentage,
      isQuorumMet,
      isUrgent,
      alertLevel,
      message,
    };
  }

  public getUrgentProposals(currentLedgerSeq: number, currentTimeMs: number = Date.now()): MultisigAlertStatus[] {
    const results: MultisigAlertStatus[] = [];
    for (const [id] of this.proposals) {
      const status = this.evaluateProposal(id, currentLedgerSeq, currentTimeMs);
      if (status && (status.isUrgent || status.isExpired || status.alertLevel === 'CRITICAL')) {
        results.push(status);
      }
    }
    return results;
  }
}

export const multisigProposalTracker = new MultisigProposalTracker();
