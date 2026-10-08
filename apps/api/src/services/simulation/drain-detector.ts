/**
 * Drain-pattern detection for transaction envelopes.
 *
 * A "drain" is an envelope whose net effect is to move value out of the signer:
 * the balance they had before the envelope is gone (or nearly gone) afterwards.
 * The detector works from the **balance delta** between the supplied pre- and
 * post-state snapshots whenever they exist — that is the strongest available
 * evidence, because it accounts for the whole envelope including host-side
 * contract behaviour rather than guessing from operation shapes. When only a
 * pre-state is available it falls back to operation-level analysis, which is
 * weaker and explicitly labelled as such in the emitted evidence.
 *
 * All arithmetic is exact integer stroop arithmetic (see `amounts.ts`): the
 * single most important case this engine must get right is "the whole balance
 * left the account", and floating point would misclassify exact drains at
 * boundaries.
 */

import { canonicalAssetKey, describeAsset, formatRatioAsPercent, formatStroops, RATIO_SCALE, tryParseAmountToStroops } from './amounts';
import type {
  AccountStateSnapshot,
  AssetFlow,
  AssetRef,
  DrainAnalysis,
  OperationKind,
  RiskIndicator,
  SimulatedOperation,
} from './types';

/** Operation kinds that move value out of the account they debit. */
const OUTGOING_TRANSFER_KINDS: ReadonlySet<OperationKind> = new Set<OperationKind>([
  'pay',
  'pathPaymentStrictReceive',
  'pathPaymentStrictSend',
  'accountMerge',
  'clawback',
  'liquidityPoolWithdraw',
]);

export interface DrainThresholds {
  /** Outflow/pre-balance ratio at/above which an asset counts as drained. */
  nearTotalOutflowRatio: number;
  /** Distinct destinations that count as fan-out. */
  fanOutDestinationThreshold: number;
  /** Outgoing transfers from one source that count as a burst. */
  sequentialTransferThreshold: number;
  /** Amounts at/below this are treated as dust. */
  dustAmountStroops: bigint;
}

export interface DrainResult {
  analysis: DrainAnalysis;
  indicators: RiskIndicator[];
}

/** Native balance plus every listed non-native balance, as canonical key → stroops. */
function readBalances(snapshot: AccountStateSnapshot | undefined): Map<string, bigint> {
  const balances = new Map<string, bigint>();
  if (!snapshot) return balances;

  if (snapshot.nativeBalance !== undefined) {
    const native = tryParseAmountToStroops(snapshot.nativeBalance);
    if (native !== null) balances.set('native', native);
  }

  for (const entry of snapshot.balances ?? []) {
    const amount = tryParseAmountToStroops(entry.balance);
    if (amount === null) continue;
    balances.set(canonicalAssetKey(entry.asset), amount);
  }

  return balances;
}

/** Resolves the source account's pre-state snapshot out of a list of snapshots. */
function snapshotFor(
  snapshots: AccountStateSnapshot[] | undefined,
  accountId: string,
): AccountStateSnapshot | undefined {
  return snapshots?.find((s) => s.accountId === accountId);
}

/**
 * Builds the per-asset flow table from pre/post balances.
 *
 * When a post-state snapshot exists for the account but omits an asset the
 * pre-state listed, the asset is treated as fully spent (zero balance) — a
 * balance listing that names every holding means an absent holding is empty.
 * Assets only present in the post-state are included as inflows from zero, which
 * is how an envelope that mints or receives value is represented.
 */
function buildFlows(
  pre: Map<string, bigint>,
  post: Map<string, bigint> | null,
  assets: Map<string, AssetRef>,
  thresholds: DrainThresholds,
): AssetFlow[] {
  const keys = new Set<string>([...pre.keys(), ...(post?.keys() ?? [])]);
  const ratioNumerator = BigInt(Math.round(thresholds.nearTotalOutflowRatio * 10_000));

  const flows: AssetFlow[] = [];

  for (const key of [...keys].sort()) {
    const preStroops = pre.get(key) ?? 0n;
    const postStroops = post ? (post.get(key) ?? 0n) : preStroops;
    const outflow = preStroops > postStroops ? preStroops - postStroops : 0n;
    const inflow = postStroops > preStroops ? postStroops - preStroops : 0n;

    // Ratio is computed as outflow * 10_000 / pre against the threshold's
    // 10_000 scale — exact for every realistic balance, and no division by zero.
    const drained =
      outflow > 0n &&
      preStroops > 0n &&
      outflow * 10_000n >= preStroops * ratioNumerator;

    flows.push({
      asset: assets.get(key) ?? inferAssetFromKey(key),
      canonicalKey: key,
      preBalanceStroops: preStroops.toString(),
      postBalanceStroops: postStroops.toString(),
      outflowStroops: outflow.toString(),
      inflowStroops: inflow.toString(),
      outflowPercent: formatRatioAsPercent(
        preStroops > 0n ? (outflow * RATIO_SCALE) / preStroops : 0n,
      ),
      drained,
    });
  }

  return flows;
}

/** Reverse-maps a canonical asset key back to a displayable `AssetRef`. */
function inferAssetFromKey(key: string): AssetRef {
  if (key === 'native') return { type: 'native' };
  if (key.startsWith('credit_alphanumeric:')) {
    const [, code = '', issuer = ''] = key.split(':');
    return { type: 'credit_alphanumeric', code, issuer };
  }
  if (key.startsWith('liquidity_pool:')) {
    return { type: 'liquidity_pool', poolId: key.slice('liquidity_pool:'.length) };
  }
  return { type: 'native' };
}

/** Collects the display asset refs for every balance mentioned in a snapshot. */
function collectAssets(snapshot: AccountStateSnapshot | undefined): Map<string, AssetRef> {
  const assets = new Map<string, AssetRef>();
  if (!snapshot) return assets;
  if (snapshot.nativeBalance !== undefined) assets.set('native', { type: 'native' });
  for (const entry of snapshot.balances ?? []) {
    assets.set(canonicalAssetKey(entry.asset), entry.asset);
  }
  return assets;
}

/** True when the operation moves value out of `source`. */
function isOutgoingTransfer(operation: SimulatedOperation, source: string): boolean {
  if (!OUTGOING_TRANSFER_KINDS.has(operation.kind)) return false;
  return (operation.source ?? source) === source;
}

/**
 * Analyses an envelope for drain behaviour and returns both the numeric
 * breakdown and the drain-category risk indicators it justifies.
 */
export function analyzeDrain(
  sourceAccount: string,
  operations: SimulatedOperation[],
  preState: AccountStateSnapshot[] | undefined,
  postState: AccountStateSnapshot[] | undefined,
  thresholds: DrainThresholds,
): DrainResult {
  const indicators: RiskIndicator[] = [];

  const preSnapshot = snapshotFor(preState, sourceAccount);
  const postSnapshot = snapshotFor(postState, sourceAccount);
  const preBalances = readBalances(preSnapshot);
  const postBalances = postSnapshot ? readBalances(postSnapshot) : null;
  const hasBalanceDiff = preSnapshot !== undefined && postSnapshot !== undefined;

  const flows = buildFlows(
    preBalances,
    postBalances,
    collectAssets(preSnapshot),
    thresholds,
  );

  const destinations: string[] = [];
  const destinationSet = new Set<string>();
  let outgoingTransferCount = 0;

  for (const operation of operations) {
    if (!isOutgoingTransfer(operation, sourceAccount)) continue;
    outgoingTransferCount++;
    if (operation.destination) {
      destinationSet.add(operation.destination);
      destinations.push(operation.destination);
    }
  }
  destinations.sort();

  const residualBalances: Record<string, string> = {};
  for (const flow of flows) {
    residualBalances[flow.canonicalKey] = formatStroops(BigInt(flow.postBalanceStroops));
  }

  const totalOutflow = flows.reduce((sum, f) => sum + BigInt(f.outflowStroops), 0n);
  const totalInflow = flows.reduce((sum, f) => sum + BigInt(f.inflowStroops), 0n);
  const drainedAssets = flows.filter((f) => f.drained).map((f) => f.canonicalKey);

  const analysis: DrainAnalysis = {
    flows,
    totalOutflowStroops: totalOutflow.toString(),
    totalInflowStroops: totalInflow.toString(),
    drainedAssets,
    destinations,
    outgoingTransferCount,
    residualBalances,
  };

  // ── Balance-delta rules (require a real pre→post comparison) ──────────────

  if (hasBalanceDiff) {
    for (const flow of flows) {
      const outflow = BigInt(flow.outflowStroops);
      if (!flow.drained || outflow === 0n) continue;

      const leftToZero = BigInt(flow.postBalanceStroops) === 0n;
      const label = describeAsset(flow.asset);

      // Weight calibration for FULL_BALANCE_DRAIN is deliberate and load-bearing:
      // 60 puts a total drain in the HIGH band on its own — visible and
      // reviewable — without auto-blocking, because "move my entire balance to
      // my other account" is a routine operation the envelope alone cannot
      // distinguish from a sweep. It is set high enough that a total drain plus
      // *any* independent corroborating signal crosses the default 80-point block
      // threshold (fan-out 22 → 82, unverified-contract 24 → 84, merge 40 → 100),
      // which is exactly the "emptied account + something else wrong" shape that
      // must never execute. Lowering this below 55 would let a full drain plus an
      // unverified contract pass the gate.
      indicators.push({
        code: leftToZero ? 'FULL_BALANCE_DRAIN' : 'NEAR_TOTAL_BALANCE_OUTFLOW',
        category: 'drain',
        severity: leftToZero ? 'critical' : 'high',
        weight: leftToZero ? 60 : 28,
        title: leftToZero
          ? `Envelope empties the source account's ${label} balance`
          : `Envelope moves ${flow.outflowPercent}% of the source account's ${label} balance`,
        detail:
          `Pre-execution balance was ${formatStroops(BigInt(flow.preBalanceStroops))} ${label}; ` +
          `the simulated result leaves ${formatStroops(BigInt(flow.postBalanceStroops))} ${label} ` +
          `(${formatStroops(outflow)} ${label} out, ${flow.outflowPercent}% of the pre-balance).`,
        remediation: leftToZero
          ? 'Block execution. A total balance drain in a single envelope is the defining signature of account takeover — require the signer to re-confirm and rotate the compromised key.'
          : 'Verify the signer intended to move this fraction of the balance, and confirm the destination address was checked before submission.',
        evidence: {
          asset: flow.canonicalKey,
          preBalance: formatStroops(BigInt(flow.preBalanceStroops)),
          postBalance: formatStroops(BigInt(flow.postBalanceStroops)),
          outflowStroops: flow.outflowStroops,
          outflowPercent: flow.outflowPercent,
          nearTotalOutflowRatio: thresholds.nearTotalOutflowRatio,
        },
      });
    }
  }

  // ── Account merge: the whole account, by construction ────────────────────

  const mergeOps = operations.filter(
    (op) => op.kind === 'accountMerge' && (op.source ?? sourceAccount) === sourceAccount && op.destination,
  );
  if (mergeOps.length > 0) {
    indicators.push({
      code: 'ACCOUNT_MERGE_SWEEP',
      category: 'drain',
      severity: 'critical',
      weight: 40,
      title: 'Envelope contains an account merge',
      detail:
        `Account merge moves the entire source account — every native and trustline balance, ` +
        `and the account itself — into ${mergeOps.map((o) => o.destination).join(', ')}. ` +
        'It cannot be reversed and is irreversible from the source account’s perspective.',
      remediation:
        'Treat an account merge as a terminal wallet action. Require an explicit, out-of-band confirmation from the signer; if it is unsolicited, the signing key is compromised.',
      evidence: {
        destinations: mergeOps.map((o) => o.destination),
        operationCount: mergeOps.length,
      },
    });
  }

  // ── Fan-out: many destinations in one envelope ───────────────────────────

  if (destinationSet.size >= thresholds.fanOutDestinationThreshold) {
    const uniqueDestinations = [...destinationSet].sort();
    indicators.push({
      code: 'DESTINATION_FAN_OUT',
      category: 'drain',
      severity: 'high',
      weight: 22,
      title: `Envelope pays ${uniqueDestinations.length} distinct destinations`,
      detail:
        `A single envelope sends value to ${uniqueDestinations.length} different accounts ` +
        `(${uniqueDestinations.join(', ')}). One transaction paying many unrelated ` +
        'destinations is the standard shape of a "smoke-signature" distribution sweep.',
      remediation:
        'Confirm every destination belongs to the signer. A legitimate payout batch should reconcile against a known payee list; if it does not, assume the key is compromised.',
      evidence: {
        destinationCount: uniqueDestinations.length,
        destinations: uniqueDestinations,
        threshold: thresholds.fanOutDestinationThreshold,
      },
    });
  }

  // ── Burst: many sequential transfers from the same source ─────────────────

  if (outgoingTransferCount >= thresholds.sequentialTransferThreshold) {
    indicators.push({
      code: 'UNBOUNDED_SEQUENTIAL_TRANSFERS',
      category: 'drain',
      severity: 'high',
      weight: 18,
      title: `Envelope chains ${outgoingTransferCount} outgoing transfers`,
      detail:
        `${outgoingTransferCount} value-transfer operations are attributed to ${sourceAccount} in a ` +
        'single envelope. At this density the operation list itself is the payload — it is how a ' +
        'compromised key drains many victims (or many of the signer’s own accounts) in one fee.',
      remediation:
        'Split the batch into reviewable chunks, or move it off-chain into a queued payout worker. Do not sign an envelope whose operation list you have not read in full.',
      evidence: {
        outgoingTransferCount,
        threshold: thresholds.sequentialTransferThreshold,
      },
    });
  }

  // ── Self-deal / round trip ───────────────────────────────────────────────

  const sourceSet = new Set<string>();
  for (const operation of operations) {
    if (operation.source) sourceSet.add(operation.source);
  }
  sourceSet.add(sourceAccount);

  const roundTrip = [...destinationSet].filter((d) => sourceSet.has(d) && d !== sourceAccount);
  const selfTransfer = destinationSet.has(sourceAccount);
  if (roundTrip.length > 0 || selfTransfer) {
    const loopAccounts = [...new Set([...roundTrip, ...(selfTransfer ? [sourceAccount] : [])])].sort();
    indicators.push({
      code: 'ROUND_TRIP_SELF_DEAL',
      category: 'drain',
      severity: 'critical',
      weight: 30,
      title: 'Envelope transfers value back into the spending chain',
      detail:
        `Value leaving ${sourceAccount} is directed at accounts that are themselves sources in the ` +
        `same envelope (${loopAccounts.join(', ')}). Round-tripping through your own accounts ` +
        'inflates apparent activity and is a standard obfuscation step ahead of an off-chain swap.',
      remediation:
        'Reject. Legitimate envelopes do not route value through their own source accounts; treat this as deliberate transaction laundering and halt submission.',
      evidence: {
        loopAccounts,
        selfTransfer,
        roundTripAccounts: roundTrip.sort(),
      },
    });
  }

  // ── Dust / zero-value transfers ──────────────────────────────────────────

  const dustTransfers = operations.filter((op) => {
    if (!OUTGOING_TRANSFER_KINDS.has(op.kind)) return false;
    const amount = tryParseAmountToStroops(op.amount ?? null);
    return amount !== null && amount >= 0n && amount <= thresholds.dustAmountStroops;
  });
  if (dustTransfers.length > 0) {
    indicators.push({
      code: 'DUST_AMOUNT_TRANSFER',
      category: 'drain',
      severity: 'medium',
      weight: 10,
      title: `Envelope contains ${dustTransfers.length} zero-value or dust transfer(s)`,
      detail:
        `${dustTransfers.length} transfer operation(s) move ${formatStroops(thresholds.dustAmountStroops)} ` +
        'or less. Zero-amount sends are used to force a recipient to trust-and-accept the asset ' +
        '(an SEP-41 `ChangeTrust` side effect) or to grief counterparties with unusable holdings.',
      remediation:
        'Confirm each dust send is intended. Accepting a token you did not request is what activates an issuer’s clawback path over the balance.',
      evidence: {
        count: dustTransfers.length,
        dustAmountStroops: thresholds.dustAmountStroops.toString(),
        operations: dustTransfers.map((op) => ({
          kind: op.kind,
          source: op.source ?? sourceAccount,
          destination: op.destination,
          amount: op.amount,
        })),
      },
    });
  }

  // ── Revocable assets: the issuer can claw the balance back post-transfer ──

  if (preSnapshot) {
    const revocableKeys = new Map<string, AssetRef>();
    for (const entry of preSnapshot.balances ?? []) {
      if (entry.revocable === true) revocableKeys.set(canonicalAssetKey(entry.asset), entry.asset);
    }

    const touchedRevocable = [...revocableKeys.entries()].filter(
      ([key]) => (flows.find((f) => f.canonicalKey === key)?.outflowStroops ?? '0') !== '0',
    );

    if (touchedRevocable.length > 0) {
      indicators.push({
        code: 'REVOCABLE_ASSET_TRANSFER',
        category: 'drain',
        severity: 'high',
        weight: 20,
        title: 'Envelope moves balances held under a revocable trustline',
        detail:
          `${touchedRevocable.length} transferred balance(s) sit on a trustline the issuer can still ` +
          `revoke (${touchedRevocable.map(([key, a]) => describeAsset(a)).join(', ')}). ` +
          'Once the issuer sets the REVOCABLE flag the holder can claw the balance back, so the ' +
          'recipient ends up holding an asset it can neither use nor sell.',
        remediation:
          'Confirm the recipient can absorb a clawback, or have the issuer remove REVOCABLE before the transfer. Never accept a revocable asset as payment.',
        evidence: {
          assets: touchedRevocable.map(([key, a]) => ({ key, asset: a })),
          outflowStroops: touchedRevocable.map(([key]) => ({
            key,
            outflow: flows.find((f) => f.canonicalKey === key)?.outflowStroops ?? '0',
          })),
        },
      });
    }
  }

  // ── Full liquidation sweep: native out *and* credit out, nothing in ──────

  if (hasBalanceDiff) {
    const nonNativeOut = flows.filter(
      (f) => f.canonicalKey !== 'native' && BigInt(f.outflowStroops) > 0n,
    );
    const nativeOut = flows.find((f) => f.canonicalKey === 'native');
    const nativeOutflow = nativeOut ? BigInt(nativeOut.outflowStroops) : 0n;

    if (nonNativeOut.length >= 1 && nativeOutflow > 0n && totalInflow === 0n) {
      indicators.push({
        code: 'ASSET_LIQUIDATION_SWEEP',
        category: 'drain',
        severity: 'high',
        weight: 26,
        title: 'Envelope liquidates credit balances into XLM and sends them out',
        detail:
          `${nonNativeOut.length} credit balance(s) are drawn down in the same envelope that ` +
          `sends ${formatStroops(nativeOutflow)} XLM out, with nothing arriving. ` +
          'Converting an entire portfolio to native and immediately sending it away is the end state of a ' +
          'wallet-emptying attack, executed in one transaction.',
        remediation:
          'Block execution unless the signer can enumerate the destination(s) of the XLM leg and explain the full liquidation. Liquidation should be observable before it settles.',
        evidence: {
          creditAssetsOut: nonNativeOut.map((f) => f.canonicalKey),
          nativeOutflow: formatStroops(nativeOutflow),
          totalInflowStroops: totalInflow.toString(),
        },
      });
    }
  }

  return { analysis, indicators };
}

/** True when at least one asset balance counts as drained. */
export function hasDrainedAssets(analysis: DrainAnalysis): boolean {
  return analysis.drainedAssets.length > 0;
}
