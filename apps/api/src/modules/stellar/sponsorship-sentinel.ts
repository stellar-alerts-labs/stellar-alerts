import { createLogger } from '../../lib/logger';

const logger = createLogger({ module: 'SponsorshipSentinel' });

export const BASE_RESERVE_XLM = 0.5;
export const BASE_ACCOUNT_MULTIPLIER = 2;

export type SponsoredLedgerEntryType =
  | 'account'
  | 'trustline'
  | 'offer'
  | 'data'
  | 'claimable_balance'
  | 'liquidity_pool'
  | 'signer';

export type SponsorshipOperationType =
  | 'begin_sponsoring_future_reserves'
  | 'end_sponsoring_future_reserves'
  | 'revoke_sponsorship';

export interface SponsorshipOperationRecord {
  txHash: string;
  operationIndex?: number;
  type: SponsorshipOperationType | string;
  source_account?: string;
  sourceAccount?: string;
  sponsored_id?: string;
  sponsoredId?: string;
  // Pola specyficzne dla revoke_sponsorship z Horizon / XDR
  account_id?: string;
  claimable_balance_id?: string;
  data_account_id?: string;
  data_name?: string;
  offer_id?: string;
  trustline_account_id?: string;
  trustline_asset?: string;
  liquidity_pool_id?: string;
  signer_account_id?: string;
  signer_key?: string;
  // Metadane stanu sponsorowania
  revokedEntryType?: SponsoredLedgerEntryType;
  previousSponsor?: string;
  newSponsor?: string | null;
  createdSubEntriesCount?: number;
  created_at?: string;
}

export interface SponsorAccountState {
  accountId: string;
  balanceXlm: number;
  sellingLiabilitiesXlm: number;
  numSubEntries: number;
  numSponsoring: number;
  numSponsored: number;
  safetyThresholdXlm: number;
}

export interface SponsorshipAlert {
  type:
    | 'SPONSOR_RESERVE_THRESHOLD_BREACHED'
    | 'UNAUTHORIZED_SPONSORSHIP_CHANGE'
    | 'SPONSORSHIP_REVOKED';
  severity: 'CRITICAL' | 'WARNING';
  accountId: string;
  lockedSponsoredReserveXlm: number;
  minimumBalanceXlm: number;
  availableSpendableXlm: number;
  safetyThresholdXlm: number;
  numSponsoring: number;
  numSponsored: number;
  revokedEntryType?: SponsoredLedgerEntryType;
  txHash?: string;
  details: string;
  timestamp: string;
}

export class SponsorshipSentinel {
  private readonly baseReserveXlm: number;
  private readonly accountStates = new Map<string, SponsorAccountState>();

  constructor(baseReserveXlm: number = BASE_RESERVE_XLM) {
    this.baseReserveXlm = baseReserveXlm;
  }

  public registerOrUpdateAccount(state: SponsorAccountState): void {
    this.accountStates.set(state.accountId, { ...state });
  }

  public getAccountState(accountId: string): SponsorAccountState | undefined {
    const state = this.accountStates.get(accountId);
    return state ? { ...state } : undefined;
  }

  public clearStates(): void {
    this.accountStates.clear();
  }

  /**
   * Oblicza skumulowaną rezerwę XLM zablokowaną przez konto z tytułu sponsorowania podpozycji (0,5 XLM / wpis).
   */
  public calculateSponsoredReserveXlm(numSponsoring: number): number {
    return Math.max(0, numSponsoring) * this.baseReserveXlm;
  }

  /**
   * Oblicza minimalne wymagane saldo konta zgodnie ze wzorem protokołu Stellar (CAP-33):
   * (2 + numSubEntries + numSponsoring - numSponsored) * baseReserve
   */
  public calculateMinimumBalanceXlm(state: SponsorAccountState): number {
    const entries =
      BASE_ACCOUNT_MULTIPLIER +
      state.numSubEntries +
      state.numSponsoring -
      state.numSponsored;

    return Math.max(BASE_ACCOUNT_MULTIPLIER, entries) * this.baseReserveXlm;
  }

  /**
   * Oblicza dostępne saldo XLM do przeniesienia po odjęciu minimalnej rezerwy
   * (wraz ze zobowiązaniami sponsorskimi) oraz selling liabilities.
   */
  public calculateAvailableBalanceXlm(state: SponsorAccountState): number {
    const minBalance = this.calculateMinimumBalanceXlm(state);
    return Number((state.balanceXlm - minBalance - state.sellingLiabilitiesXlm).toFixed(7));
  }

  /**
   * Rozpoznaje typ wpisu rejestru dla operacji revoke_sponsorship na podstawie pól Horizon/XDR.
   */
  public resolveRevokedEntryType(
    op: SponsorshipOperationRecord,
  ): SponsoredLedgerEntryType {
    if (op.revokedEntryType) return op.revokedEntryType;
    if (op.account_id) return 'account';
    if (op.trustline_account_id || op.trustline_asset) return 'trustline';
    if (op.offer_id) return 'offer';
    if (op.data_account_id || op.data_name) return 'data';
    if (op.claimable_balance_id) return 'claimable_balance';
    if (op.liquidity_pool_id) return 'liquidity_pool';
    if (op.signer_account_id || op.signer_key) return 'signer';
    return 'account';
  }

  /**
   * Analizuje pojedynczą operację lub sekwencję operacji sponsorowania w transakcji,
   * aktualizuje rejestry num_sponsoring / num_sponsored i emituje alerty.
   */
  public inspectTransactionOperations(
    operations: SponsorshipOperationRecord[],
    options: {
      accounts?: Map<string, SponsorAccountState>;
      authorizedSponsors?: Set<string>;
    } = {},
  ): {
    updatedAccounts: Map<string, SponsorAccountState>;
    alerts: SponsorshipAlert[];
  } {
    const workingMap = new Map<string, SponsorAccountState>();
    const sourceMap = options.accounts ?? this.accountStates;

    for (const [id, st] of sourceMap.entries()) {
      workingMap.set(id, { ...st });
    }

    const alerts: SponsorshipAlert[] = [];
    const touchedAccounts = new Set<string>();
    let activeSponsor: string | null = null;
    let activeSponsoredTarget: string | null = null;

    for (const op of operations) {
      const sourceAccount = op.sourceAccount ?? op.source_account ?? '';
      const timestamp = op.created_at ?? new Date().toISOString();

      if (op.type === 'begin_sponsoring_future_reserves') {
        activeSponsor = sourceAccount;
        activeSponsoredTarget = op.sponsoredId ?? op.sponsored_id ?? null;

        if (
          options.authorizedSponsors &&
          activeSponsor &&
          !options.authorizedSponsors.has(activeSponsor)
        ) {
          const sponsorState = workingMap.get(activeSponsor);
          alerts.push({
            type: 'UNAUTHORIZED_SPONSORSHIP_CHANGE',
            severity: 'CRITICAL',
            accountId: activeSponsor,
            lockedSponsoredReserveXlm: sponsorState
              ? this.calculateSponsoredReserveXlm(sponsorState.numSponsoring)
              : 0,
            minimumBalanceXlm: sponsorState
              ? this.calculateMinimumBalanceXlm(sponsorState)
              : 1,
            availableSpendableXlm: sponsorState
              ? this.calculateAvailableBalanceXlm(sponsorState)
              : 0,
            safetyThresholdXlm: sponsorState?.safetyThresholdXlm ?? 0,
            numSponsoring: sponsorState?.numSponsoring ?? 0,
            numSponsored: sponsorState?.numSponsored ?? 0,
            txHash: op.txHash,
            details: `Unauthorized begin_sponsoring_future_reserves by ${activeSponsor} for ${activeSponsoredTarget ?? 'unknown'}`,
            timestamp,
          });
        }

        const delta = op.createdSubEntriesCount ?? 1;
        if (activeSponsor) {
          this.applyDelta(workingMap, activeSponsor, delta, 0);
          touchedAccounts.add(activeSponsor);
        }
        if (activeSponsoredTarget) {
          this.applyDelta(workingMap, activeSponsoredTarget, 0, delta);
          touchedAccounts.add(activeSponsoredTarget);
        }
      } else if (op.type === 'end_sponsoring_future_reserves') {
        activeSponsor = null;
        activeSponsoredTarget = null;
      } else if (op.type === 'revoke_sponsorship') {
        const entryType = this.resolveRevokedEntryType(op);

        if (op.previousSponsor) {
          this.applyDelta(workingMap, op.previousSponsor, -1, 0);
          touchedAccounts.add(op.previousSponsor);
        }
        if (op.newSponsor) {
          this.applyDelta(workingMap, op.newSponsor, 1, 0);
          touchedAccounts.add(op.newSponsor);
        } else if (sourceAccount) {
          // Brak nowego sponsora — ciężar rezerwy wraca na właściciela podwpisu
          this.applyDelta(workingMap, sourceAccount, 0, -1);
          touchedAccounts.add(sourceAccount);
        }

        const affectedAccountId = op.previousSponsor ?? sourceAccount;
        const affectedState = workingMap.get(affectedAccountId);

        if (affectedState) {
          alerts.push({
            type: 'SPONSORSHIP_REVOKED',
            severity: 'WARNING',
            accountId: affectedAccountId,
            lockedSponsoredReserveXlm: this.calculateSponsoredReserveXlm(
              affectedState.numSponsoring,
            ),
            minimumBalanceXlm: this.calculateMinimumBalanceXlm(affectedState),
            availableSpendableXlm: this.calculateAvailableBalanceXlm(affectedState),
            safetyThresholdXlm: affectedState.safetyThresholdXlm,
            numSponsoring: affectedState.numSponsoring,
            numSponsored: affectedState.numSponsored,
            revokedEntryType: entryType,
            txHash: op.txHash,
            details: `Sponsorship revoked for ${entryType} entry (previous sponsor: ${op.previousSponsor ?? 'none'}, new sponsor: ${op.newSponsor ?? 'owner'})`,
            timestamp,
          });
        }
      }
    }

    // Aktualizacja cache stanu i sprawdzenie progów bezpieczeństwa rezerw
    for (const accountId of touchedAccounts) {
      const state = workingMap.get(accountId);
      if (!state) continue;

      if (!options.accounts) {
        this.accountStates.set(accountId, { ...state });
      }

      const thresholdAlert = this.evaluateSafetyThreshold(state);
      if (thresholdAlert) {
        logger.warn(
          {
            accountId,
            availableSpendableXlm: thresholdAlert.availableSpendableXlm,
            lockedSponsoredReserveXlm: thresholdAlert.lockedSponsoredReserveXlm,
            safetyThresholdXlm: state.safetyThresholdXlm,
          },
          '⚠️ Sponsor treasury reserve buffer dropped below safety threshold',
        );
        alerts.push(thresholdAlert);
      }
    }

    return { updatedAccounts: workingMap, alerts };
  }

  /**
   * Sprawdza, czy dostępne saldo XLM po odliczeniu zobowiązań rezerwowych spadło poniżej progu bezpieczeństwa.
   */
  public evaluateSafetyThreshold(
    state: SponsorAccountState,
    txHash?: string,
  ): SponsorshipAlert | null {
    const lockedSponsoredReserveXlm = this.calculateSponsoredReserveXlm(
      state.numSponsoring,
    );
    const minimumBalanceXlm = this.calculateMinimumBalanceXlm(state);
    const availableSpendableXlm = this.calculateAvailableBalanceXlm(state);

    if (availableSpendableXlm < state.safetyThresholdXlm) {
      return {
        type: 'SPONSOR_RESERVE_THRESHOLD_BREACHED',
        severity: availableSpendableXlm <= 0 ? 'CRITICAL' : 'WARNING',
        accountId: state.accountId,
        lockedSponsoredReserveXlm,
        minimumBalanceXlm,
        availableSpendableXlm,
        safetyThresholdXlm: state.safetyThresholdXlm,
        numSponsoring: state.numSponsoring,
        numSponsored: state.numSponsored,
        txHash,
        details: `Available XLM (${availableSpendableXlm} XLM) fell below safety threshold (${state.safetyThresholdXlm} XLM) with ${lockedSponsoredReserveXlm} XLM locked across ${state.numSponsoring} sponsored entries.`,
        timestamp: new Date().toISOString(),
      };
    }

    return null;
  }

  private applyDelta(
    map: Map<string, SponsorAccountState>,
    accountId: string,
    sponsoringDelta: number,
    sponsoredDelta: number,
  ): void {
    const state = map.get(accountId);
    if (!state) return;

    state.numSponsoring = Math.max(0, state.numSponsoring + sponsoringDelta);
    state.numSponsored = Math.max(0, state.numSponsored + sponsoredDelta);
  }
}

export const sponsorshipSentinel = new SponsorshipSentinel();
