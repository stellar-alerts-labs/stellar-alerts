//! Zero-allocation scanner for Stellar `LedgerCloseMeta` XDR.
//!
//! The scanner walks the header and the transaction set of a ledger close meta
//! and emits one fixed-size record per *selected* operation type, without ever
//! materialising operation objects. Everything after the tx set (the bulky
//! `txProcessing` results/meta, upgrades, SCP info, evictions) is never read.
//!
//! Anything this reader does not understand (an unknown union arm from a newer
//! protocol, malformed lengths, truncated input) returns a negative error code
//! instead of guessing, so the TypeScript wrapper can fall back to the JS SDK.
//!
//! Memory model: JS copies the ledger bytes into the region returned by
//! `reserve`, calls `scan`, then reads fixed-size records straight out of the
//! output region. No allocator is used; both regions come from `memory.grow`.
#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ── error codes ──────────────────────────────────────────────────────────────
const E_EOF: i32 = -1; // input ended early
const E_UNSUPPORTED: i32 = -2; // union arm this reader doesn't know
const E_FULL: i32 = -3; // output table too small (retry with a bigger one)
const E_VERSION: i32 = -4; // unknown LedgerCloseMeta version
const E_DEPTH: i32 = -5; // ScVal / predicate nesting too deep
const E_MALFORMED: i32 = -6; // impossible length / bool / discriminant
const E_NOMEM: i32 = -7; // memory.grow failed

type R<T> = Result<T, i32>;

const MAX_DEPTH: u32 = 64;
const REC_WORDS: usize = 11;

// ── operation types ──────────────────────────────────────────────────────────
const OP_CREATE_ACCOUNT: u32 = 0;
const OP_PAYMENT: u32 = 1;
const OP_PATH_PAYMENT_STRICT_RECEIVE: u32 = 2;
const OP_MANAGE_SELL_OFFER: u32 = 3;
const OP_CREATE_PASSIVE_SELL_OFFER: u32 = 4;
const OP_SET_OPTIONS: u32 = 5;
const OP_CHANGE_TRUST: u32 = 6;
const OP_ALLOW_TRUST: u32 = 7;
const OP_ACCOUNT_MERGE: u32 = 8;
const OP_INFLATION: u32 = 9;
const OP_MANAGE_DATA: u32 = 10;
const OP_BUMP_SEQUENCE: u32 = 11;
const OP_MANAGE_BUY_OFFER: u32 = 12;
const OP_PATH_PAYMENT_STRICT_SEND: u32 = 13;
const OP_CREATE_CLAIMABLE_BALANCE: u32 = 14;
const OP_CLAIM_CLAIMABLE_BALANCE: u32 = 15;
const OP_BEGIN_SPONSORING: u32 = 16;
const OP_END_SPONSORING: u32 = 17;
const OP_REVOKE_SPONSORSHIP: u32 = 18;
const OP_CLAWBACK: u32 = 19;
const OP_CLAWBACK_CLAIMABLE_BALANCE: u32 = 20;
const OP_SET_TRUST_LINE_FLAGS: u32 = 21;
const OP_LP_DEPOSIT: u32 = 22;
const OP_LP_WITHDRAW: u32 = 23;
const OP_INVOKE_HOST_FUNCTION: u32 = 24;
const OP_EXTEND_FOOTPRINT_TTL: u32 = 25;
const OP_RESTORE_FOOTPRINT: u32 = 26;

// ── reader ───────────────────────────────────────────────────────────────────
struct Rd<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Rd<'a> {
    #[inline]
    fn u32(&mut self) -> R<u32> {
        let e = self.p.checked_add(4).ok_or(E_EOF)?;
        if e > self.b.len() {
            return Err(E_EOF);
        }
        let v = u32::from_be_bytes([self.b[self.p], self.b[self.p + 1], self.b[self.p + 2], self.b[self.p + 3]]);
        self.p = e;
        Ok(v)
    }

    #[inline]
    fn skip(&mut self, n: usize) -> R<()> {
        let e = self.p.checked_add(n).ok_or(E_EOF)?;
        if e > self.b.len() {
            return Err(E_EOF);
        }
        self.p = e;
        Ok(())
    }

    fn bool(&mut self) -> R<bool> {
        match self.u32()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(E_MALFORMED),
        }
    }

    /// Variable-length opaque/string: u32 length, `max` bound, padded to 4.
    fn var_opaque(&mut self, max: u32) -> R<()> {
        let n = self.u32()?;
        if n > max {
            return Err(E_MALFORMED);
        }
        self.skip(((n as usize) + 3) & !3)
    }

    /// Array length with a plausibility check (every element is >= 4 bytes) so a
    /// corrupt count can never drive a multi-million iteration loop.
    fn count(&mut self) -> R<u32> {
        let n = self.u32()?;
        if (n as usize) > self.b.len().saturating_sub(self.p) / 4 + 1 {
            return Err(E_MALFORMED);
        }
        Ok(n)
    }

    /// Enum/union discriminant that must equal `want` (single-arm unions).
    fn expect(&mut self, want: u32) -> R<()> {
        if self.u32()? == want {
            Ok(())
        } else {
            Err(E_UNSUPPORTED)
        }
    }
}

// ── primitive composite skippers ─────────────────────────────────────────────

fn account_id(r: &mut Rd) -> R<()> {
    r.expect(0)?; // PUBLIC_KEY_TYPE_ED25519
    r.skip(32)
}

/// Returns the offset of the 32-byte ed25519 key.
fn muxed(r: &mut Rd) -> R<u32> {
    match r.u32()? {
        0 => {
            let k = r.p;
            r.skip(32)?;
            Ok(k as u32)
        }
        0x100 => {
            r.skip(8)?; // id
            let k = r.p;
            r.skip(32)?;
            Ok(k as u32)
        }
        _ => Err(E_UNSUPPORTED),
    }
}

fn asset(r: &mut Rd) -> R<()> {
    match r.u32()? {
        0 => Ok(()),
        1 => {
            r.skip(4)?;
            account_id(r)
        }
        2 => {
            r.skip(12)?;
            account_id(r)
        }
        _ => Err(E_UNSUPPORTED),
    }
}

fn change_trust_asset(r: &mut Rd) -> R<()> {
    match r.u32()? {
        0 => Ok(()),
        1 => {
            r.skip(4)?;
            account_id(r)
        }
        2 => {
            r.skip(12)?;
            account_id(r)
        }
        3 => {
            r.expect(0)?; // LIQUIDITY_POOL_CONSTANT_PRODUCT
            asset(r)?;
            asset(r)?;
            r.skip(4) // fee
        }
        _ => Err(E_UNSUPPORTED),
    }
}

fn trustline_asset(r: &mut Rd) -> R<()> {
    match r.u32()? {
        0 => Ok(()),
        1 => {
            r.skip(4)?;
            account_id(r)
        }
        2 => {
            r.skip(12)?;
            account_id(r)
        }
        3 => r.skip(32),
        _ => Err(E_UNSUPPORTED),
    }
}

fn signer_key(r: &mut Rd) -> R<()> {
    match r.u32()? {
        0 | 1 | 2 => r.skip(32),
        3 => {
            r.skip(32)?;
            r.var_opaque(64)
        }
        _ => Err(E_UNSUPPORTED),
    }
}

fn claimable_balance_id(r: &mut Rd) -> R<()> {
    r.expect(0)?;
    r.skip(32)
}

fn sc_address(r: &mut Rd) -> R<()> {
    match r.u32()? {
        0 => account_id(r),
        1 => r.skip(32),
        2 => r.skip(8 + 32),
        3 => claimable_balance_id(r),
        4 => r.skip(32),
        _ => Err(E_UNSUPPORTED),
    }
}

fn sc_val(r: &mut Rd, depth: u32) -> R<()> {
    if depth > MAX_DEPTH {
        return Err(E_DEPTH);
    }
    match r.u32()? {
        0 => {
            r.bool()?;
            Ok(())
        }
        1 | 20 => Ok(()),
        2 => r.skip(8),
        3 | 4 => r.skip(4),
        5..=8 => r.skip(8),
        9 | 10 => r.skip(16),
        11 | 12 => r.skip(32),
        13..=15 => r.var_opaque(u32::MAX),
        16 => {
            if r.bool()? {
                let n = r.count()?;
                for _ in 0..n {
                    sc_val(r, depth + 1)?;
                }
            }
            Ok(())
        }
        17 => {
            if r.bool()? {
                sc_map_entries(r, depth)?;
            }
            Ok(())
        }
        18 => sc_address(r),
        19 => {
            contract_executable(r)?;
            if r.bool()? {
                sc_map_entries(r, depth)?;
            }
            Ok(())
        }
        21 => r.skip(8),
        _ => Err(E_UNSUPPORTED),
    }
}

fn sc_map_entries(r: &mut Rd, depth: u32) -> R<()> {
    let n = r.count()?;
    for _ in 0..n {
        sc_val(r, depth + 1)?;
        sc_val(r, depth + 1)?;
    }
    Ok(())
}

fn contract_executable(r: &mut Rd) -> R<()> {
    match r.u32()? {
        0 => r.skip(32),
        1 => Ok(()),
        _ => Err(E_UNSUPPORTED),
    }
}

fn invoke_contract_args(r: &mut Rd) -> R<()> {
    sc_address(r)?;
    r.var_opaque(32)?; // function name (SCSymbol)
    let n = r.count()?;
    for _ in 0..n {
        sc_val(r, 0)?;
    }
    Ok(())
}

fn contract_id_preimage(r: &mut Rd) -> R<()> {
    match r.u32()? {
        0 => {
            sc_address(r)?;
            r.skip(32) // salt
        }
        1 => asset(r),
        _ => Err(E_UNSUPPORTED),
    }
}

fn create_contract_args(r: &mut Rd) -> R<()> {
    contract_id_preimage(r)?;
    contract_executable(r)
}

fn create_contract_args_v2(r: &mut Rd) -> R<()> {
    create_contract_args(r)?;
    let n = r.count()?;
    for _ in 0..n {
        sc_val(r, 0)?;
    }
    Ok(())
}

fn host_function(r: &mut Rd) -> R<()> {
    match r.u32()? {
        0 => invoke_contract_args(r),
        1 => create_contract_args(r),
        2 => r.var_opaque(u32::MAX),
        3 => create_contract_args_v2(r),
        _ => Err(E_UNSUPPORTED),
    }
}

fn authorized_invocation(r: &mut Rd, depth: u32) -> R<()> {
    if depth > MAX_DEPTH {
        return Err(E_DEPTH);
    }
    match r.u32()? {
        0 => invoke_contract_args(r)?,
        1 => create_contract_args(r)?,
        2 => create_contract_args_v2(r)?,
        _ => return Err(E_UNSUPPORTED),
    }
    let n = r.count()?;
    for _ in 0..n {
        authorized_invocation(r, depth + 1)?;
    }
    Ok(())
}

fn auth_entry(r: &mut Rd) -> R<()> {
    match r.u32()? {
        0 => {}
        1 => {
            sc_address(r)?;
            r.skip(8 + 4)?; // nonce + signatureExpirationLedger
            sc_val(r, 0)?;
        }
        _ => return Err(E_UNSUPPORTED),
    }
    authorized_invocation(r, 0)
}

fn ledger_key(r: &mut Rd) -> R<()> {
    match r.u32()? {
        0 => account_id(r),
        1 => {
            account_id(r)?;
            trustline_asset(r)
        }
        2 => {
            account_id(r)?;
            r.skip(8)
        }
        3 => {
            account_id(r)?;
            r.var_opaque(64)
        }
        4 => claimable_balance_id(r),
        5 => r.skip(32),
        6 => {
            sc_address(r)?;
            sc_val(r, 0)?;
            r.skip(4) // durability
        }
        7 => r.skip(32),
        8 => r.skip(4),
        9 => r.skip(32),
        _ => Err(E_UNSUPPORTED),
    }
}

fn claim_predicate(r: &mut Rd, depth: u32) -> R<()> {
    if depth > MAX_DEPTH {
        return Err(E_DEPTH);
    }
    match r.u32()? {
        0 => Ok(()),
        1 | 2 => {
            let n = r.count()?;
            for _ in 0..n {
                claim_predicate(r, depth + 1)?;
            }
            Ok(())
        }
        3 => {
            if r.bool()? {
                claim_predicate(r, depth + 1)?;
            }
            Ok(())
        }
        4 | 5 => r.skip(8),
        _ => Err(E_UNSUPPORTED),
    }
}

// ── operations ───────────────────────────────────────────────────────────────

/// Skips an operation body. Returns the offset of a 32-byte ed25519 destination
/// key for the types that have one (payment-likes, create account, merge), else 0.
fn skip_body(r: &mut Rd, ty: u32) -> R<u32> {
    let mut dest = 0u32;
    match ty {
        OP_CREATE_ACCOUNT => {
            r.expect(0)?;
            dest = r.p as u32;
            r.skip(32 + 8)?;
        }
        OP_PAYMENT => {
            dest = muxed(r)?;
            asset(r)?;
            r.skip(8)?;
        }
        OP_PATH_PAYMENT_STRICT_RECEIVE | OP_PATH_PAYMENT_STRICT_SEND => {
            asset(r)?;
            r.skip(8)?;
            dest = muxed(r)?;
            asset(r)?;
            r.skip(8)?;
            let n = r.count()?;
            for _ in 0..n {
                asset(r)?;
            }
        }
        OP_MANAGE_SELL_OFFER | OP_MANAGE_BUY_OFFER => {
            asset(r)?;
            asset(r)?;
            r.skip(8 + 8 + 8)?; // amount, price, offerID
        }
        OP_CREATE_PASSIVE_SELL_OFFER => {
            asset(r)?;
            asset(r)?;
            r.skip(8 + 8)?;
        }
        OP_SET_OPTIONS => {
            if r.bool()? {
                account_id(r)?; // inflationDest
            }
            for _ in 0..6 {
                // clearFlags, setFlags, masterWeight, low, med, high
                if r.bool()? {
                    r.skip(4)?;
                }
            }
            if r.bool()? {
                r.var_opaque(32)?; // homeDomain
            }
            if r.bool()? {
                signer_key(r)?;
                r.skip(4)?; // weight
            }
        }
        OP_CHANGE_TRUST => {
            change_trust_asset(r)?;
            r.skip(8)?;
        }
        OP_ALLOW_TRUST => {
            account_id(r)?;
            match r.u32()? {
                1 => r.skip(4)?,
                2 => r.skip(12)?,
                _ => return Err(E_UNSUPPORTED),
            }
            r.skip(4)?;
        }
        OP_ACCOUNT_MERGE => {
            dest = muxed(r)?;
        }
        OP_INFLATION | OP_END_SPONSORING => {}
        OP_MANAGE_DATA => {
            r.var_opaque(64)?;
            if r.bool()? {
                r.var_opaque(64)?;
            }
        }
        OP_BUMP_SEQUENCE => r.skip(8)?,
        OP_CREATE_CLAIMABLE_BALANCE => {
            asset(r)?;
            r.skip(8)?;
            let n = r.count()?;
            for _ in 0..n {
                r.expect(0)?; // CLAIMANT_TYPE_V0
                account_id(r)?;
                claim_predicate(r, 0)?;
            }
        }
        OP_CLAIM_CLAIMABLE_BALANCE | OP_CLAWBACK_CLAIMABLE_BALANCE => claimable_balance_id(r)?,
        OP_BEGIN_SPONSORING => account_id(r)?,
        OP_REVOKE_SPONSORSHIP => match r.u32()? {
            0 => ledger_key(r)?,
            1 => {
                account_id(r)?;
                signer_key(r)?;
            }
            _ => return Err(E_UNSUPPORTED),
        },
        OP_CLAWBACK => {
            asset(r)?;
            muxed(r)?;
            r.skip(8)?;
        }
        OP_SET_TRUST_LINE_FLAGS => {
            account_id(r)?;
            asset(r)?;
            r.skip(8)?;
        }
        OP_LP_DEPOSIT => r.skip(32 + 8 + 8 + 8 + 8)?,
        OP_LP_WITHDRAW => r.skip(32 + 8 + 8 + 8)?,
        OP_INVOKE_HOST_FUNCTION => {
            host_function(r)?;
            let n = r.count()?;
            for _ in 0..n {
                auth_entry(r)?;
            }
        }
        OP_EXTEND_FOOTPRINT_TTL => {
            r.expect(0)?;
            r.skip(4)?;
        }
        OP_RESTORE_FOOTPRINT => r.expect(0)?,
        _ => return Err(E_UNSUPPORTED),
    }
    Ok(dest)
}

fn memo(r: &mut Rd) -> R<()> {
    match r.u32()? {
        0 => Ok(()),
        1 => r.var_opaque(28),
        2 => r.skip(8),
        3 | 4 => r.skip(32),
        _ => Err(E_UNSUPPORTED),
    }
}

fn preconditions(r: &mut Rd) -> R<()> {
    match r.u32()? {
        0 => Ok(()),
        1 => r.skip(16),
        2 => {
            if r.bool()? {
                r.skip(16)?; // timeBounds
            }
            if r.bool()? {
                r.skip(8)?; // ledgerBounds
            }
            if r.bool()? {
                r.skip(8)?; // minSeqNum
            }
            r.skip(8 + 4)?; // minSeqAge, minSeqLedgerGap
            let n = r.count()?;
            for _ in 0..n {
                signer_key(r)?;
            }
            Ok(())
        }
        _ => Err(E_UNSUPPORTED),
    }
}

fn soroban_data(r: &mut Rd) -> R<()> {
    r.expect(0)?; // ExtensionPoint (pre-protocol-23 shape; newer shapes are reported unsupported)
    for _ in 0..2 {
        // footprint readOnly, readWrite
        let n = r.count()?;
        for _ in 0..n {
            ledger_key(r)?;
        }
    }
    r.skip(4 + 4 + 4 + 8) // instructions, readBytes, writeBytes, resourceFee
}

fn signatures(r: &mut Rd) -> R<()> {
    let n = r.count()?;
    for _ in 0..n {
        r.skip(4)?; // hint
        r.var_opaque(64)?;
    }
    Ok(())
}

// ── scanner state ────────────────────────────────────────────────────────────
struct Out {
    ptr: *mut u32,
    cap: u32,
    len: u32,
}

struct Scan {
    mask: u32,
    tx_index: u32,
    op_total: u32,
    out: Out,
}

impl Scan {
    /// Walks `Operation operations<>` of one transaction, recording selected ops.
    fn operations(&mut self, r: &mut Rd, tx_off: u32, flags: u32, tx_src: u32) -> R<()> {
        let n = r.count()?;
        for op_index in 0..n {
            let has_src = r.bool()?;
            let mut src = 0u32;
            if has_src {
                src = muxed(r)?;
            }
            // The union discriminant is part of the body bytes JS will decode.
            let start = r.p;
            let ty = r.u32()?;
            let dest = skip_body(r, ty)?;
            self.op_total += 1;

            if ty < 32 && (self.mask >> ty) & 1 == 1 {
                if self.out.len >= self.out.cap {
                    return Err(E_FULL);
                }
                let base = (self.out.len as usize) * REC_WORDS;
                // SAFETY: `out.len < out.cap` and the region holds `cap * REC_WORDS` u32s (see `reserve_out`).
                unsafe {
                    let w = self.out.ptr.add(base);
                    *w.add(0) = self.tx_index;
                    *w.add(1) = op_index;
                    *w.add(2) = ty;
                    *w.add(3) = flags | if has_src { 1 } else { 0 };
                    *w.add(4) = tx_off;
                    *w.add(5) = 0; // tx_len patched once the envelope end is known
                    *w.add(6) = start as u32;
                    *w.add(7) = (r.p - start) as u32;
                    *w.add(8) = src;
                    *w.add(9) = tx_src;
                    *w.add(10) = dest;
                }
                self.out.len += 1;
            }
        }
        Ok(())
    }

    fn v1_tx_envelope(&mut self, r: &mut Rd, tx_off: u32, flags: u32) -> R<()> {
        let tx_src = muxed(r)?;
        r.skip(4 + 8)?; // fee, seqNum
        preconditions(r)?;
        memo(r)?;
        self.operations(r, tx_off, flags, tx_src)?;
        match r.u32()? {
            0 => {}
            1 => soroban_data(r)?,
            _ => return Err(E_UNSUPPORTED),
        }
        signatures(r)
    }

    fn envelope(&mut self, r: &mut Rd) -> R<()> {
        let tx_off = r.p as u32;
        let first_rec = self.out.len;
        match r.u32()? {
            0 => {
                // ENVELOPE_TYPE_TX_V0
                let tx_src = r.p as u32;
                r.skip(32 + 4 + 8)?; // sourceAccountEd25519, fee, seqNum
                if r.bool()? {
                    r.skip(16)?; // timeBounds
                }
                memo(r)?;
                self.operations(r, tx_off, 4, tx_src)?; // flags bit2: v0 raw tx source key
                r.expect(0)?;
                signatures(r)?;
            }
            2 => self.v1_tx_envelope(r, tx_off, 0)?,
            5 => {
                // ENVELOPE_TYPE_TX_FEE_BUMP: feeSource, fee, inner v1 envelope, ext, signatures
                muxed(r)?;
                r.skip(8)?;
                r.expect(2)?;
                self.v1_tx_envelope(r, tx_off, 2)?; // flags bit1: fee bump
                r.expect(0)?;
                signatures(r)?;
            }
            _ => return Err(E_UNSUPPORTED),
        }
        let tx_len = (r.p as u32) - tx_off;
        for i in first_rec..self.out.len {
            // SAFETY: i < out.len <= out.cap
            unsafe { *self.out.ptr.add((i as usize) * REC_WORDS + 5) = tx_len };
        }
        self.tx_index += 1;
        Ok(())
    }
}

// ── ledger-level structure ───────────────────────────────────────────────────

struct Header {
    ledger_seq: u32,
    ledger_version: u32,
    close_time: u64,
}

fn ledger_header_history_entry(r: &mut Rd) -> R<Header> {
    r.skip(32)?; // hash
    let ledger_version = r.u32()?;
    r.skip(32)?; // previousLedgerHash
    r.skip(32)?; // scpValue.txSetHash
    let hi = r.u32()? as u64;
    let lo = r.u32()? as u64;
    let close_time = (hi << 32) | lo;
    let upgrades = r.count()?;
    for _ in 0..upgrades {
        r.var_opaque(128)?;
    }
    match r.u32()? {
        0 => {}
        1 => {
            r.expect(0)?; // nodeID PUBLIC_KEY_TYPE_ED25519
            r.skip(32)?;
            r.var_opaque(64)?;
        }
        _ => return Err(E_UNSUPPORTED),
    }
    r.skip(32 + 32)?; // txSetResultHash, bucketListHash
    let ledger_seq = r.u32()?;
    r.skip(8 + 8 + 4 + 8 + 4 + 4 + 4)?; // totalCoins feePool inflationSeq idPool baseFee baseReserve maxTxSetSize
    r.skip(4 * 32)?; // skipList
    match r.u32()? {
        0 => {}
        1 => {
            r.skip(4)?; // flags
            r.expect(0)?;
        }
        _ => return Err(E_UNSUPPORTED),
    }
    r.expect(0)?; // LedgerHeaderHistoryEntry.ext
    Ok(Header { ledger_seq, ledger_version, close_time })
}

fn run(input: &[u8], mask: u32, out: Out) -> R<(Scan, Header, u32)> {
    let mut r = Rd { b: input, p: 0 };
    let mut s = Scan { mask, tx_index: 0, op_total: 0, out };
    let version = r.u32()?;
    let header;
    match version {
        0 => {
            header = ledger_header_history_entry(&mut r)?;
            r.skip(32)?; // TransactionSet.previousLedgerHash
            let n = r.count()?;
            for _ in 0..n {
                s.envelope(&mut r)?;
            }
        }
        1 | 2 => {
            match r.u32()? {
                0 => {}
                1 => {
                    r.expect(0)?;
                    r.skip(8)?; // sorobanFeeWrite1KB
                }
                _ => return Err(E_UNSUPPORTED),
            }
            header = ledger_header_history_entry(&mut r)?;
            r.expect(1)?; // GeneralizedTransactionSet v1
            r.skip(32)?; // previousLedgerHash
            let phases = r.count()?;
            for _ in 0..phases {
                r.expect(0)?; // TransactionPhase v0 (parallel v1 phases are reported unsupported)
                let comps = r.count()?;
                for _ in 0..comps {
                    r.expect(0)?; // TXSET_COMP_TXS_MAYBE_DISCOUNTED_FEE
                    if r.bool()? {
                        r.skip(8)?; // baseFee
                    }
                    let n = r.count()?;
                    for _ in 0..n {
                        s.envelope(&mut r)?;
                    }
                }
            }
        }
        _ => return Err(E_VERSION),
    }
    Ok((s, header, version))
}

// ── memory + exports ─────────────────────────────────────────────────────────

const PAGE: usize = 65536;

static mut IN_PTR: usize = 0;
static mut IN_CAP: usize = 0;
static mut OUT_PTR: usize = 0;
static mut OUT_CAP: usize = 0; // in records
static mut HEADER: [u32; 8] = [0; 8];

/// Grows linear memory by enough pages for `bytes`; returns the start address.
fn grow_bytes(bytes: usize) -> Option<usize> {
    let pages = bytes.div_ceil(PAGE).max(1);
    let prev = core::arch::wasm32::memory_grow(0, pages);
    if prev == usize::MAX {
        None
    } else {
        Some(prev * PAGE)
    }
}

/// Returns a pointer to an input region of at least `len` bytes (stable until the next call
/// that needs a larger region). Returns 0 on allocation failure.
#[no_mangle]
pub extern "C" fn reserve(len: u32) -> u32 {
    let need = (len as usize).max(1);
    unsafe {
        if IN_CAP >= need {
            return IN_PTR as u32;
        }
        // Geometric growth keeps total abandoned memory bounded by ~2x the largest ledger.
        let cap = need.max(IN_CAP * 2).max(64 * 1024);
        match grow_bytes(cap) {
            Some(p) => {
                IN_PTR = p;
                IN_CAP = cap.div_ceil(PAGE) * PAGE;
                p as u32
            }
            None => 0,
        }
    }
}

/// Returns a pointer to an output table of `records` records (`REC_WORDS` u32 each), or 0.
#[no_mangle]
pub extern "C" fn reserve_out(records: u32) -> u32 {
    let need = (records as usize).max(1);
    unsafe {
        if OUT_CAP >= need {
            return OUT_PTR as u32;
        }
        let cap = need.max(OUT_CAP * 2).max(1024);
        match grow_bytes(cap * REC_WORDS * 4) {
            Some(p) => {
                OUT_PTR = p;
                OUT_CAP = (cap * REC_WORDS * 4).div_ceil(PAGE) * PAGE / (REC_WORDS * 4);
                p as u32
            }
            None => 0,
        }
    }
}

#[no_mangle]
pub extern "C" fn header_ptr() -> u32 {
    core::ptr::addr_of!(HEADER) as u32
}

#[no_mangle]
pub extern "C" fn record_words() -> u32 {
    REC_WORDS as u32
}

#[no_mangle]
pub extern "C" fn out_capacity() -> u32 {
    unsafe { OUT_CAP as u32 }
}

/// Scans `len` bytes previously written to the `reserve` region.
/// Returns the number of selected operations written to the output table, or a negative error.
/// Header words: [ledger_seq, ledger_version, close_time_lo, close_time_hi, tx_count, op_total, meta_version, 0].
#[no_mangle]
pub extern "C" fn scan(len: u32, mask: u32) -> i32 {
    unsafe {
        if IN_PTR == 0 || OUT_PTR == 0 {
            return E_NOMEM;
        }
        let input = core::slice::from_raw_parts(IN_PTR as *const u8, len as usize);
        let out = Out { ptr: OUT_PTR as *mut u32, cap: OUT_CAP as u32, len: 0 };
        match run(input, mask, out) {
            Ok((s, h, version)) => {
                HEADER = [
                    h.ledger_seq,
                    h.ledger_version,
                    h.close_time as u32,
                    (h.close_time >> 32) as u32,
                    s.tx_index,
                    s.op_total,
                    version,
                    0,
                ];
                s.out.len as i32
            }
            Err(e) => e,
        }
    }
}
