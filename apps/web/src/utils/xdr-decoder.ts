import * as StellarSdk from 'stellar-sdk';

export interface XdrTreeNode {
  key: string;
  type: string;
  value?: unknown;
  children?: XdrTreeNode[];
  isLeaf: boolean;
  discriminant?: string;
}

export interface DecodedXdr {
  type: 'TransactionEnvelope' | 'TransactionResult' | 'TransactionMeta' | 'ScVal' | 'unknown';
  tree: XdrTreeNode;
  bytes: Uint8Array;
  base64: string;
}

export function decodeXdr(base64String: string): DecodedXdr {
  const bytes = Buffer.from(base64String, 'base64');
  
  let type: DecodedXdr['type'] = 'unknown';
  let tree: XdrTreeNode = { key: 'root', type: 'unknown', isLeaf: false, children: [] };

  try {
    try {
      const envelope = StellarSdk.xdr.TransactionEnvelope.fromXDR(bytes, 'raw');
      type = 'TransactionEnvelope';
      tree = buildTreeFromEnvelope(envelope);
      return { type, tree, bytes, base64: base64String };
    } catch {}

    try {
      const result = StellarSdk.xdr.TransactionResult.fromXDR(bytes, 'raw');
      type = 'TransactionResult';
      tree = buildTreeFromTransactionResult(result);
      return { type, tree, bytes, base64: base64String };
    } catch {}

    try {
      const meta = StellarSdk.xdr.TransactionMeta.fromXDR(bytes, 'raw');
      type = 'TransactionMeta';
      tree = buildTreeFromTransactionMeta(meta);
      return { type, tree, bytes, base64: base64String };
    } catch {}

    try {
      const scval = StellarSdk.xdr.ScVal.fromXDR(bytes, 'raw');
      type = 'ScVal';
      tree = buildTreeFromScVal(scval);
      return { type, tree, bytes, base64: base64String };
    } catch {}

    throw new Error('Could not decode as any known XDR type');
  } catch (error) {
    throw new Error(`XDR decode failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildTreeFromEnvelope(envelope: any): XdrTreeNode {
  const children: XdrTreeNode[] = [];
  const discriminant = (envelope.switch() as any)?.name || 'unknown';

  children.push({
    key: 'discriminant',
    type: 'discriminant',
    value: discriminant,
    isLeaf: true,
  });

  if (envelope.v1?.()) {
    const v1 = envelope.v1();
    children.push({
      key: 'tx',
      type: 'Transaction',
      isLeaf: false,
      children: buildTransactionChildren(v1.tx()),
    });

    const signatures = v1.signatures();
    children.push({
      key: 'signatures',
      type: `DecoratedSignature[${signatures.length}]`,
      isLeaf: false,
      value: `${signatures.length} signatures`,
      children: signatures.map((sig: any, idx: number) => ({
        key: `[${idx}]`,
        type: 'DecoratedSignature',
        isLeaf: false,
        children: [
          { key: 'hint', type: 'SignatureHint', value: sig.hint().toString('hex'), isLeaf: true },
          { key: 'signature', type: 'Signature', value: sig.signature().toString('hex'), isLeaf: true },
        ],
      })),
    });
  }

  return {
    key: 'TransactionEnvelope',
    type: 'TransactionEnvelope',
    isLeaf: false,
    discriminant,
    children,
  };
}

function buildTransactionChildren(tx: any): XdrTreeNode[] {
  const children: XdrTreeNode[] = [];

  children.push({
    key: 'sourceAccount',
    type: 'MuxedAccount',
    value: formatMuxedAccount(tx.sourceAccount()),
    isLeaf: true,
  });

  children.push({
    key: 'fee',
    type: 'uint32',
    value: tx.fee(),
    isLeaf: true,
  });

  children.push({
    key: 'seqNum',
    type: 'int64',
    value: tx.seqNum().toString(),
    isLeaf: true,
  });

  const cond = tx.cond?.();
  if (cond) {
    children.push({
      key: 'preconditions',
      type: 'Preconditions',
      value: (cond.switch?.() as any)?.name || 'v0',
      isLeaf: true,
    });
  }

  const operations = tx.operations();
  children.push({
    key: 'operations',
    type: `Operation[${operations.length}]`,
    value: `${operations.length} operations`,
    isLeaf: false,
    children: operations.map((op: any, idx: number) => ({
      key: `[${idx}]`,
      type: 'Operation',
      value: formatOperationType(op),
      isLeaf: true,
    })),
  });

  children.push({
    key: 'memo',
    type: 'Memo',
    value: formatMemo(tx.memo()),
    isLeaf: true,
  });

  children.push({
    key: 'ext',
    type: 'TransactionExt',
    value: 'v=0',
    isLeaf: true,
  });

  return children;
}

function buildTreeFromTransactionResult(result: any): XdrTreeNode {
  const children: XdrTreeNode[] = [];

  children.push({
    key: 'feeCharged',
    type: 'int64',
    value: result.feeCharged().toString(),
    isLeaf: true,
  });

  children.push({
    key: 'result',
    type: 'TransactionResultResult',
    value: (result.result()?.switch?.() as any)?.name || 'unknown',
    isLeaf: true,
  });

  return {
    key: 'TransactionResult',
    type: 'TransactionResult',
    isLeaf: false,
    children,
  };
}

function buildTreeFromTransactionMeta(meta: any): XdrTreeNode {
  const children: XdrTreeNode[] = [];
  const discriminant = (meta.switch?.() as any)?.name || 'v0';

  children.push({
    key: 'discriminant',
    type: 'discriminant',
    value: discriminant,
    isLeaf: true,
  });

  if (meta.v3?.()) {
    const v3 = meta.v3();
    const operations = v3.operations();
    children.push({
      key: 'operations',
      type: `OperationMeta[${operations.length}]`,
      value: `${operations.length} operation metas`,
      isLeaf: false,
      children: operations.map((op: any, idx: number) => ({
        key: `[${idx}]`,
        type: 'OperationMeta',
        isLeaf: true,
        value: 'OperationMeta',
      })),
    });
  }

  return {
    key: 'TransactionMeta',
    type: 'TransactionMeta',
    isLeaf: false,
    discriminant,
    children,
  };
}

function buildTreeFromScVal(scval: any): XdrTreeNode {
  const children: XdrTreeNode[] = [];
  const discriminant = (scval.switch?.() as any)?.name || 'unknown';

  children.push({
    key: 'discriminant',
    type: 'discriminant',
    value: discriminant,
    isLeaf: true,
  });

  try {
    if ((scval.switch?.() as any)?.value === 0 && scval.u32?.()) {
      children.push({
        key: 'value',
        type: 'uint32',
        value: scval.u32().toString(),
        isLeaf: true,
      });
    }
  } catch {}

  return {
    key: 'ScVal',
    type: 'ScVal',
    isLeaf: false,
    discriminant,
    children,
  };
}

function formatMuxedAccount(mux: any): string {
  try {
    const baseAccount = mux.ed25519?.();
    if (baseAccount) {
      const addr = StellarSdk.StrKey.encodeEd25519PublicKey(baseAccount);
      return addr.substring(0, 12) + '...' + addr.substring(addr.length - 8);
    }
  } catch {}
  return 'unknown';
}

function formatOperationType(op: any): string {
  try {
    return (op.body?.()?.switch?.() as any)?.name || 'unknown';
  } catch {
    return 'unknown';
  }
}

function formatMemo(memo: any): string {
  try {
    return (memo.switch?.() as any)?.name || 'MEMO_NONE';
  } catch {
    return 'unknown';
  }
}

export function hexView(bytes: Uint8Array, width: number = 16): string[] {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += width) {
    const chunk = bytes.slice(i, i + width);
    const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(chunk)
      .map(b => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(width * 3 - 1, ' ')}  ${ascii}`);
  }
  return lines;
}
