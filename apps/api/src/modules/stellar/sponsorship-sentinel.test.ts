import { describe, it, expect, beforeEach } from 'vitest';
import {
  SponsorshipSentinel,
  SponsorAccountState,
} from './sponsorship-sentinel';

describe('SponsorshipSentinel (#977)', () => {
  let sentinel: SponsorshipSentinel;
  const SPONSOR_ID = 'GSPONSOR_TREASURY_ACCOUNT_123';
  const USER_ID = 'GUSER_WALLET_ACCOUNT_456';
  const UNAUTHORIZED_ID = 'GUNAUTHORIZED_ACTOR_789';

  const makeTreasury = (
    overrides: Partial<SponsorAccountState> = {},
  ): SponsorAccountState => ({
    accountId: SPONSOR_ID,
    balanceXlm: 50,
    sellingLiabilitiesXlm: 0,
    numSubEntries: 2,
    numSponsoring: 40, // 40 * 0.5 = 20 XLM zablokowane
    numSponsored: 0,
    safetyThresholdXlm: 25,
    ...overrides,
  });

  beforeEach(() => {
    sentinel = new SponsorshipSentinel(0.5);
  });

  it('calculates cumulative sponsored reserve and available spendable XLM', () => {
    const state = makeTreasury();
    // MinBalance = (2 + 2 + 40 - 0) * 0.5 = 22 XLM
    // Available = 50 - 22 = 28 XLM (>= 25 XLM safety threshold)
    expect(sentinel.calculateSponsoredReserveXlm(40)).toBe(20);
    expect(sentinel.calculateMinimumBalanceXlm(state)).toBe(22);
    expect(sentinel.calculateAvailableBalanceXlm(state)).toBe(28);
    expect(sentinel.evaluateSafetyThreshold(state)).toBeNull();
  });

  it('triggers threshold alert when adding sponsored entries drops available XLM below safety threshold', () => {
    const accounts = new Map<string, SponsorAccountState>([
      [SPONSOR_ID, makeTreasury()],
      [
        USER_ID,
        {
          accountId: USER_ID,
          balanceXlm: 1,
          sellingLiabilitiesXlm: 0,
          numSubEntries: 0,
          numSponsoring: 0,
          numSponsored: 0,
          safetyThresholdXlm: 0,
        },
      ],
    ]);

    const { updatedAccounts, alerts } = sentinel.inspectTransactionOperations(
      [
        {
          txHash: 'tx_sponsor_add_1',
          operationIndex: 0,
          type: 'begin_sponsoring_future_reserves',
          sourceAccount: SPONSOR_ID,
          sponsoredId: USER_ID,
          createdSubEntriesCount: 10,
        },
        {
          txHash: 'tx_sponsor_add_1',
          operationIndex: 1,
          type: 'end_sponsoring_future_reserves',
          sourceAccount: USER_ID,
        },
      ],
      {
        accounts,
        authorizedSponsors: new Set([SPONSOR_ID]),
      },
    );

    const sponsor = updatedAccounts.get(SPONSOR_ID)!;
    const user = updatedAccounts.get(USER_ID)!;

    expect(sponsor.numSponsoring).toBe(50);
    expect(user.numSponsored).toBe(10);
    expect(sentinel.calculateSponsoredReserveXlm(sponsor.numSponsoring)).toBe(25);
    expect(sentinel.calculateAvailableBalanceXlm(sponsor)).toBe(23);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('SPONSOR_RESERVE_THRESHOLD_BREACHED');
    expect(alerts[0].severity).toBe('WARNING');
  });

  it('reduces sponsor liabilities and parses entry types on revoke_sponsorship', () => {
    const accounts = new Map<string, SponsorAccountState>([
      [
        SPONSOR_ID,
        makeTreasury({ balanceXlm: 100, numSponsoring: 20, safetyThresholdXlm: 10 }),
      ],
      [
        USER_ID,
        {
          accountId: USER_ID,
          balanceXlm: 10,
          sellingLiabilitiesXlm: 0,
          numSubEntries: 2,
          numSponsoring: 0,
          numSponsored: 2,
          safetyThresholdXlm: 1,
        },
      ],
    ]);

    const { updatedAccounts, alerts } = sentinel.inspectTransactionOperations(
      [
        {
          txHash: 'tx_revoke_1',
          operationIndex: 0,
          type: 'revoke_sponsorship',
          sourceAccount: USER_ID,
          trustline_account_id: USER_ID,
          trustline_asset: 'USDC:GISSUER',
          previousSponsor: SPONSOR_ID,
          newSponsor: null,
        },
      ],
      {
        accounts,
        authorizedSponsors: new Set([SPONSOR_ID]),
      },
    );

    const sponsor = updatedAccounts.get(SPONSOR_ID)!;
    const user = updatedAccounts.get(USER_ID)!;

    expect(sponsor.numSponsoring).toBe(19);
    expect(user.numSponsored).toBe(1);
    expect(sentinel.calculateSponsoredReserveXlm(sponsor.numSponsoring)).toBe(9.5);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('SPONSORSHIP_REVOKED');
    expect(alerts[0].revokedEntryType).toBe('trustline');
  });

  it('detects unauthorized sponsorship initiation', () => {
    const accounts = new Map<string, SponsorAccountState>([
      [
        UNAUTHORIZED_ID,
        makeTreasury({ accountId: UNAUTHORIZED_ID, balanceXlm: 500, numSponsoring: 0 }),
      ],
    ]);

    const { alerts } = sentinel.inspectTransactionOperations(
      [
        {
          txHash: 'tx_unauth_1',
          type: 'begin_sponsoring_future_reserves',
          sourceAccount: UNAUTHORIZED_ID,
          sponsoredId: USER_ID,
          createdSubEntriesCount: 1,
        },
      ],
      {
        accounts,
        authorizedSponsors: new Set([SPONSOR_ID]),
      },
    );

    expect(alerts.some((a) => a.type === 'UNAUTHORIZED_SPONSORSHIP_CHANGE')).toBe(
      true,
    );
  });
});
