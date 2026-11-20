/**
 * Builds realistic `LedgerCloseMeta` XDR with the Stellar SDK so the WASM
 * scanner can be checked against the SDK's own decoder.
 */
import * as StellarSdk from 'stellar-sdk';

const { xdr, Keypair, Operation, Asset, TransactionBuilder, Account, Networks, Contract, nativeToScVal } = StellarSdk;

export const PASSPHRASE = Networks.TESTNET;

/** Deterministic keypair from a small integer so fixtures are reproducible. */
export function kp(n: number): StellarSdk.Keypair {
  const seed = Buffer.alloc(32);
  seed.writeUInt32BE(n + 1, 28);
  return Keypair.fromRawEd25519Seed(seed);
}

const USDC = new Asset('USDC', kp(900).publicKey());

export type TxEnvelope = StellarSdk.xdr.TransactionEnvelope;

function builder(source: StellarSdk.Keypair, seq: number, memo?: StellarSdk.Memo) {
  const b = new TransactionBuilder(new Account(source.publicKey(), String(seq)), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
    timebounds: { minTime: 0, maxTime: 0 },
    ...(memo ? { memo } : {}),
  });
  return b;
}

function finish(b: StellarSdk.TransactionBuilder, signer: StellarSdk.Keypair): StellarSdk.Transaction {
  const tx = b.setTimeout(30).build();
  tx.sign(signer);
  return tx;
}

/** A catalogue of envelopes covering every operation body shape the scanner must skip. */
export function sampleEnvelopes(): TxEnvelope[] {
  const a = kp(1);
  const b = kp(2);
  const c = kp(3);
  const out: TxEnvelope[] = [];
  const push = (tx: StellarSdk.Transaction) => out.push(tx.toEnvelope());

  // payments (incl. muxed destination, op-level source, text memo)
  push(
    finish(
      builder(a, 10, StellarSdk.Memo.text('hello'))
        .addOperation(Operation.payment({ destination: b.publicKey(), asset: Asset.native(), amount: '12.5' }))
        .addOperation(Operation.payment({ destination: b.publicKey(), asset: USDC, amount: '3', source: c.publicKey() }))
        .addOperation(
          Operation.payment({
            destination: new StellarSdk.MuxedAccount(new Account(b.publicKey(), '0'), '12345').accountId(),
            asset: Asset.native(),
            amount: '1',
          }),
        ),
      a,
    ),
  );

  // account creation, merge, inflation-free admin ops
  push(
    finish(
      builder(b, 20, StellarSdk.Memo.id('77'))
        .addOperation(Operation.createAccount({ destination: c.publicKey(), startingBalance: '10' }))
        .addOperation(Operation.accountMerge({ destination: a.publicKey() }))
        .addOperation(Operation.bumpSequence({ bumpTo: '1000' }))
        .addOperation(Operation.manageData({ name: 'k', value: Buffer.from('v') }))
        .addOperation(Operation.manageData({ name: 'gone', value: null })),
      b,
    ),
  );

  // set_options: every optional present, then signer variants
  push(
    finish(
      builder(c, 30)
        .addOperation(
          Operation.setOptions({
            inflationDest: a.publicKey(),
            clearFlags: 1,
            setFlags: 2,
            masterWeight: 0,
            lowThreshold: 1,
            medThreshold: 2,
            highThreshold: 3,
            homeDomain: 'example.com',
            signer: { ed25519PublicKey: b.publicKey(), weight: 5 },
          }),
        )
        .addOperation(Operation.setOptions({ signer: { sha256Hash: Buffer.alloc(32, 7), weight: 1 } }))
        .addOperation(Operation.setOptions({ signer: { preAuthTx: Buffer.alloc(32, 8), weight: 1 } }))
        .addOperation(Operation.setOptions({ masterWeight: 1 }))
        .addOperation(Operation.setOptions({})),
      c,
    ),
  );

  // DEX + trust
  push(
    finish(
      builder(a, 40)
        .addOperation(Operation.manageSellOffer({ selling: Asset.native(), buying: USDC, amount: '5', price: '1.5', offerId: '0' }))
        .addOperation(Operation.manageBuyOffer({ selling: Asset.native(), buying: USDC, buyAmount: '5', price: '1.5', offerId: '0' }))
        .addOperation(Operation.createPassiveSellOffer({ selling: Asset.native(), buying: USDC, amount: '5', price: '2' }))
        .addOperation(
          Operation.pathPaymentStrictReceive({
            sendAsset: Asset.native(),
            sendMax: '10',
            destination: b.publicKey(),
            destAsset: USDC,
            destAmount: '4',
            path: [new Asset('EUR', kp(901).publicKey()), new Asset('LONGASSET12', kp(902).publicKey())],
          }),
        )
        .addOperation(
          Operation.pathPaymentStrictSend({
            sendAsset: USDC,
            sendAmount: '10',
            destination: c.publicKey(),
            destMin: '1',
            destAsset: Asset.native(),
            path: [],
          }),
        )
        .addOperation(Operation.changeTrust({ asset: USDC, limit: '1000' }))
        .addOperation(
          Operation.changeTrust({
            asset: new StellarSdk.LiquidityPoolAsset(Asset.native(), USDC, StellarSdk.LiquidityPoolFeeV18),
          }),
        ),
      a,
    ),
  );

  // claimables, sponsorship, clawback, flags, liquidity pools
  const poolId = Buffer.alloc(32, 9).toString('hex');
  push(
    finish(
      builder(b, 50)
        .addOperation(
          Operation.createClaimableBalance({
            asset: Asset.native(),
            amount: '1',
            claimants: [
              new StellarSdk.Claimant(a.publicKey(), StellarSdk.Claimant.predicateUnconditional()),
              new StellarSdk.Claimant(
                c.publicKey(),
                StellarSdk.Claimant.predicateAnd(
                  StellarSdk.Claimant.predicateBeforeAbsoluteTime('4102444800'),
                  StellarSdk.Claimant.predicateNot(StellarSdk.Claimant.predicateBeforeRelativeTime('60')),
                ),
              ),
            ],
          }),
        )
        .addOperation(Operation.claimClaimableBalance({ balanceId: '00000000' + Buffer.alloc(32, 3).toString('hex') }))
        .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: c.publicKey() }))
        .addOperation(Operation.endSponsoringFutureReserves())
        .addOperation(Operation.revokeAccountSponsorship({ account: c.publicKey() }))
        .addOperation(Operation.revokeTrustlineSponsorship({ account: c.publicKey(), asset: USDC }))
        .addOperation(Operation.revokeOfferSponsorship({ seller: c.publicKey(), offerId: '5' }))
        .addOperation(Operation.revokeDataSponsorship({ account: c.publicKey(), name: 'k' }))
        .addOperation(Operation.revokeSignerSponsorship({ account: c.publicKey(), signer: { ed25519PublicKey: a.publicKey() } }))
        .addOperation(Operation.clawback({ asset: USDC, from: c.publicKey(), amount: '1' }))
        .addOperation(Operation.clawbackClaimableBalance({ balanceId: '00000000' + Buffer.alloc(32, 3).toString('hex') }))
        .addOperation(Operation.setTrustLineFlags({ trustor: c.publicKey(), asset: USDC, flags: { authorized: true } }))
        .addOperation(
          Operation.liquidityPoolDeposit({
            liquidityPoolId: poolId,
            maxAmountA: '1',
            maxAmountB: '2',
            minPrice: '0.5',
            maxPrice: '2',
          }),
        )
        .addOperation(
          Operation.liquidityPoolWithdraw({ liquidityPoolId: poolId, amount: '1', minAmountA: '0.1', minAmountB: '0.1' }),
        ),
      b,
    ),
  );

  // Soroban invocation with rich args + footprint (tx ext = SorobanTransactionData)
  const contract = new Contract('CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA');
  const args = [
    nativeToScVal(42, { type: 'u32' }),
    nativeToScVal('sym', { type: 'symbol' }),
    nativeToScVal(Buffer.from('bytes!')),
    nativeToScVal(123456789012345678901234567890n, { type: 'i128' }),
    nativeToScVal([1, 2, 3], { type: 'u64' }),
    nativeToScVal({ a: 1, b: 'two' }),
    nativeToScVal(a.publicKey(), { type: 'address' }),
    nativeToScVal(true),
    nativeToScVal(null),
  ];
  const sorobanData = new StellarSdk.SorobanDataBuilder()
    .setResources(1_000_000, 2_000, 3_000)
    .setFootprint(
      [xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: a.xdrPublicKey() }))],
      [
        xdr.LedgerKey.contractData(
          new xdr.LedgerKeyContractData({
            contract: contract.address().toScAddress(),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent(),
          }),
        ),
      ],
    )
    .build();
  push(
    finish(
      new TransactionBuilder(new Account(a.publicKey(), '60'), { fee: '100000', networkPassphrase: PASSPHRASE })
        .addOperation(contract.call('transfer', ...args))
        .setSorobanData(sorobanData),
      a,
    ),
  );

  // Soroban upload + create + extend + restore
  push(
    finish(
      new TransactionBuilder(new Account(a.publicKey(), '70'), { fee: '100000', networkPassphrase: PASSPHRASE })
        .addOperation(Operation.invokeHostFunction({ func: xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.alloc(37, 1)), auth: [] }))
        .addOperation(Operation.extendFootprintTtl({ extendTo: 500 }))
        .addOperation(Operation.restoreFootprint({}))
        .setSorobanData(
          new StellarSdk.SorobanDataBuilder().setResources(1, 2, 3).setFootprint([], []).build(),
        ),
      a,
    ),
  );

  // Fee-bump wrapping a payment
  const inner = finish(
    builder(b, 80).addOperation(Operation.payment({ destination: c.publicKey(), asset: Asset.native(), amount: '2' })),
    b,
  );
  const bump = TransactionBuilder.buildFeeBumpTransaction(a, '400', inner, PASSPHRASE);
  bump.sign(a);
  out.push(bump.toEnvelope());

  // Legacy V0 envelope
  const v1 = finish(
    builder(a, 90).addOperation(Operation.payment({ destination: b.publicKey(), asset: USDC, amount: '9' })),
    a,
  ).toEnvelope();
  const v1tx = v1.v1().tx();
  out.push(
    xdr.TransactionEnvelope.envelopeTypeTxV0(
      new xdr.TransactionV0Envelope({
        tx: new xdr.TransactionV0({
          sourceAccountEd25519: a.rawPublicKey(),
          fee: v1tx.fee(),
          seqNum: v1tx.seqNum(),
          timeBounds: null,
          memo: v1tx.memo(),
          operations: v1tx.operations(),
          ext: new xdr.TransactionV0Ext(0),
        }),
        signatures: [],
      }),
    ),
  );

  // Preconditions V2 with extra signer + ledger bounds + min seq
  out.push(
    finish(
      builder(c, 100)
        .addOperation(Operation.payment({ destination: a.publicKey(), asset: Asset.native(), amount: '1' })),
      c,
    ).toEnvelope(),
  );
  const pre = new TransactionBuilder(new Account(c.publicKey(), '110'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
    ledgerbounds: { minLedger: 1, maxLedger: 999999 },
    minAccountSequence: '5',
    minAccountSequenceAge: 10,
    minAccountSequenceLedgerGap: 2,
    extraSigners: [a.publicKey()],
    timebounds: { minTime: 0, maxTime: 4102444800 },
  })
    .addOperation(Operation.payment({ destination: a.publicKey(), asset: Asset.native(), amount: '1' }))
    .build();
  pre.sign(c);
  out.push(pre.toEnvelope());

  return out;
}

/** Many simple payments, for load-shaped benchmarks. */
export function paymentEnvelopes(count: number, opsPerTx = 2): TxEnvelope[] {
  const out: TxEnvelope[] = [];
  const dest = kp(2).publicKey();
  for (let i = 0; i < count; i++) {
    const src = kp(1000 + (i % 50));
    const b = new TransactionBuilder(new Account(src.publicKey(), String(i + 1)), {
      fee: '100',
      networkPassphrase: PASSPHRASE,
      timebounds: { minTime: 0, maxTime: 0 },
    });
    for (let o = 0; o < opsPerTx; o++) {
      b.addOperation(Operation.payment({ destination: dest, asset: Asset.native(), amount: String(1 + o) }));
    }
    const tx = b.setTimeout(30).build();
    tx.sign(src);
    out.push(tx.toEnvelope());
  }
  return out;
}

function ledgerHeaderEntry(ledgerSeq: number, signedValue = false, extV1 = false): StellarSdk.xdr.LedgerHeaderHistoryEntry {
  const hash = (n: number) => Buffer.alloc(32, n);
  const scpValue = new xdr.StellarValue({
    txSetHash: hash(1),
    closeTime: new xdr.Uint64(1_700_000_000 + ledgerSeq),
    upgrades: [Buffer.alloc(8, 5)],
    ext: signedValue
      ? new xdr.StellarValueExt(
          xdr.StellarValueType.stellarValueSigned(),
          new xdr.LedgerCloseValueSignature({ nodeId: xdr.PublicKey.publicKeyTypeEd25519(Buffer.alloc(32, 4)), signature: Buffer.alloc(64, 6) }),
        )
      : new xdr.StellarValueExt(xdr.StellarValueType.stellarValueBasic()),
  });
  return new xdr.LedgerHeaderHistoryEntry({
    hash: hash(2),
    header: new xdr.LedgerHeader({
      ledgerVersion: 22,
      previousLedgerHash: hash(3),
      scpValue,
      txSetResultHash: hash(4),
      bucketListHash: hash(5),
      ledgerSeq,
      totalCoins: new xdr.Int64(1_000_000_000),
      feePool: new xdr.Int64(1000),
      inflationSeq: 0,
      idPool: new xdr.Uint64(42),
      baseFee: 100,
      baseReserve: 5_000_000,
      maxTxSetSize: 1000,
      skipList: [hash(6), hash(7), hash(8), hash(9)],
      ext: extV1
        ? xdr.LedgerHeaderExt.fromXDR(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0, 0, 0, 7]), Buffer.from([0, 0, 0, 0])]))
        : new xdr.LedgerHeaderExt(0),
    }),
    ext: new xdr.LedgerHeaderHistoryEntryExt(0),
  });
}

export interface MetaOptions {
  ledgerSeq?: number;
  /** Split envelopes across this many tx-set components (v1 only). */
  components?: number;
  signedValue?: boolean;
  extV1?: boolean;
  /** Number of dummy txProcessing entries to append, to prove the scanner ignores the tail. */
  version?: 0 | 1;
}

/** Serialises a `LedgerCloseMeta` (v0 or v1) containing the given envelopes. */
export function buildLedgerCloseMeta(envelopes: TxEnvelope[], options: MetaOptions = {}): Buffer {
  const ledgerSeq = options.ledgerSeq ?? 123456;
  const header = ledgerHeaderEntry(ledgerSeq, options.signedValue, options.extV1);

  if (options.version === 0) {
    const v0 = new xdr.LedgerCloseMetaV0({
      ledgerHeader: header,
      txSet: new xdr.TransactionSet({ previousLedgerHash: Buffer.alloc(32, 3), txes: envelopes }),
      txProcessing: [],
      upgradesProcessing: [],
      scpInfo: [],
    });
    return new xdr.LedgerCloseMeta(0, v0).toXDR();
  }

  const parts = Math.max(1, options.components ?? 1);
  const comps: StellarSdk.xdr.TxSetComponent[] = [];
  for (let i = 0; i < parts; i++) {
    const slice = envelopes.filter((_, idx) => idx % parts === i);
    comps.push(
      new xdr.TxSetComponent(
        xdr.TxSetComponentType.txsetCompTxsMaybeDiscountedFee(),
        new xdr.TxSetComponentTxsMaybeDiscountedFee({ baseFee: i % 2 === 0 ? new xdr.Int64(100) : null, txes: slice }),
      ),
    );
  }
  const txSet = new xdr.GeneralizedTransactionSet(
    1,
    new xdr.TransactionSetV1({
      previousLedgerHash: Buffer.alloc(32, 3),
      phases: [new xdr.TransactionPhase(0, comps)],
    }),
  );
  const v1 = new xdr.LedgerCloseMetaV1({
    ext: new xdr.LedgerCloseMetaExt(0),
    ledgerHeader: header,
    txSet,
    txProcessing: [],
    upgradesProcessing: [],
    scpInfo: [],
    totalByteSizeOfBucketList: new xdr.Uint64(1),
    evictedTemporaryLedgerKeys: [],
    evictedPersistentLedgerEntries: [],
  });
  return new xdr.LedgerCloseMeta(1, v1).toXDR();
}
