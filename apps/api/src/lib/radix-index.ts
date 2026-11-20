/**
 * RadixAddressIndex — memory-efficient Patricia trie for monitored Stellar /
 * Soroban StrKeys (base32: A-Z, 2-7).
 *
 * Why not a Set<string>: 500k 56-char strings cost ~110 B each in V8 (string
 * header + hash-table slot), live on the GC heap, and every lookup hashes the
 * whole key and chases a pointer to compare. Here the whole index is a handful
 * of typed arrays (invisible to the GC's object graph, so no scavenge/mark
 * pressure) and lookups never allocate.
 *
 * Layout (structure-of-arrays, "data-parallel" friendly):
 *  - Edge labels are 5-bit packed symbols in one shared byte pool, referenced
 *    by (offset, length). Splitting an edge never copies — it just re-slices.
 *  - Internal nodes carry a 32-bit child bitmap (exactly one bit per base32
 *    symbol), so selecting a child is `popcount(bitmap & (bit - 1))` —
 *    branch-free, no per-child comparisons, no sibling lists.
 *  - Leaves (the bulk of nodes for random keys) are stored without bitmap or
 *    child storage: a child pointer < 0 encodes a leaf index.
 *  - Child pointer blocks are power-of-two sized with per-class free lists, so
 *    insert/remove churn does not leak.
 *
 * Removal merges single-child nodes back into their parent edge (keeping the
 * trie canonical) and `compact()` reclaims label-pool space orphaned by
 * splits/merges; it runs automatically when waste exceeds half the pool.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const INVALID = 255;
const MAX_KEY_LENGTH = 255;
/** Pool offsets are in symbols; keep `symbols * 5` inside int32 for bit math. */
const MAX_POOL_SYMBOLS = 1 << 28;
const TERMINAL = 1;
const FREE = 2;

/** char code -> 5-bit symbol (255 = not base32). 64 KiB so no bounds branch on lookup. */
const SYM = new Uint8Array(65536).fill(INVALID);
for (let i = 0; i < ALPHABET.length; i++) {
  SYM[ALPHABET.charCodeAt(i)] = i;
  // Tolerate lowercase input the same way RFC 4648 decoders do.
  const lower = ALPHABET[i].toLowerCase();
  if (lower !== ALPHABET[i]) SYM[lower.charCodeAt(0)] = i;
}

function popcount(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function nextPow2Class(n: number): number {
  // class c holds 2^c child slots; n >= 1
  return n <= 1 ? 0 : 32 - Math.clz32(n - 1);
}

export interface RadixIndexStats {
  size: number;
  internalNodes: number;
  leaves: number;
  /** Bytes held by the index's typed arrays (their full allocated capacity). */
  allocatedBytes: number;
  /** Bytes actually in use (live prefix of each array). */
  usedBytes: number;
  wastedLabelSymbols: number;
}

export class RadixAddressIndex {
  // ── label pool (5-bit packed symbols) ────────────────────────────────────
  private pool: Uint8Array;
  private poolSyms = 0;
  private wastedSyms = 0;

  // ── internal nodes (index 0 is the root) ─────────────────────────────────
  private nOff: Uint32Array;
  private nLen: Uint8Array;
  private nFlags: Uint8Array;
  private nBitmap: Int32Array;
  private nChildBase: Uint32Array;
  private nodeCount = 0; // high-water mark
  private freeNodes: number[] = [];

  // ── leaves ───────────────────────────────────────────────────────────────
  private lOff: Uint32Array;
  private lLen: Uint8Array;
  private leafCount = 0; // high-water mark
  private freeLeaves: number[] = [];

  // ── child pointer blocks (ptr >= 0: internal node, ptr < 0: ~leafIndex) ──
  private childPtrs: Int32Array;
  private childTop = 0;
  private freeBlocks: number[][] = Array.from({ length: 6 }, () => []);

  private _size = 0;
  private readonly scratch = new Uint8Array(MAX_KEY_LENGTH);

  /**
   * @param expectedKeys capacity hint; preallocating avoids the transient 2x
   * memory spike of growing typed arrays while bulk loading.
   */
  constructor(expectedKeys = 1024, expectedKeyLength = 56) {
    const keys = Math.max(16, expectedKeys);
    this.pool = new Uint8Array(Math.ceil((keys * Math.max(expectedKeyLength - 3, 8) * 5) / 8) + 8);
    const nodes = Math.max(16, Math.ceil(keys / 4));
    this.nOff = new Uint32Array(nodes);
    this.nLen = new Uint8Array(nodes);
    this.nFlags = new Uint8Array(nodes);
    this.nBitmap = new Int32Array(nodes);
    this.nChildBase = new Uint32Array(nodes);
    this.lOff = new Uint32Array(keys);
    this.lLen = new Uint8Array(keys);
    this.childPtrs = new Int32Array(Math.max(64, Math.ceil(keys * 1.5)));
    this.newNode(0, 0, 0); // root
  }

  get size(): number {
    return this._size;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Public API
  // ═════════════════════════════════════════════════════════════════════════

  /** Exact-match membership test. Allocation-free. */
  has(key: string): boolean {
    const len = key.length;
    if (len === 0 || len > MAX_KEY_LENGTH) return false;

    const { nBitmap, nChildBase, nFlags, nOff, nLen, lOff, lLen, childPtrs, pool } = this;
    let node = 0;
    let pos = 0;
    for (;;) {
      if (pos === len) return (nFlags[node] & TERMINAL) !== 0;
      const sym = SYM[key.charCodeAt(pos)];
      if (sym === INVALID) return false;
      const bm = nBitmap[node];
      const bit = 1 << sym;
      if ((bm & bit) === 0) return false;
      const ptr = childPtrs[nChildBase[node] + popcount(bm & (bit - 1))];

      let off: number;
      let l: number;
      if (ptr < 0) {
        const leaf = ~ptr;
        off = lOff[leaf];
        l = lLen[leaf];
        if (len - pos !== l) return false;
      } else {
        off = nOff[ptr];
        l = nLen[ptr];
        if (pos + l > len) return false;
      }

      // Compare the edge label (5-bit packed) against the key's symbols.
      let bitPos = off * 5;
      for (let i = 0; i < l; i++, bitPos += 5) {
        const b = bitPos >>> 3;
        const s = ((pool[b] | (pool[b + 1] << 8)) >>> (bitPos & 7)) & 31;
        if (SYM[key.charCodeAt(pos + i)] !== s) return false;
      }

      if (ptr < 0) return true;
      node = ptr;
      pos += l;
    }
  }

  /** Adds a key. Returns true if it was newly inserted. Throws on non-base32 input. */
  add(key: string): boolean {
    const len = this.loadKey(key);
    const keySyms = this.scratch;
    let node = 0;
    let pos = 0;

    for (;;) {
      if (pos === len) {
        if (this.nFlags[node] & TERMINAL) return false;
        this.nFlags[node] |= TERMINAL;
        this._size++;
        return true;
      }

      const sym = keySyms[pos];
      const bm = this.nBitmap[node];
      const bit = 1 << sym;
      if ((bm & bit) === 0) {
        this.addChild(node, sym, ~this.newLeaf(keySyms, pos, len - pos));
        this._size++;
        return true;
      }

      const slot = this.nChildBase[node] + popcount(bm & (bit - 1));
      const ptr = this.childPtrs[slot];

      if (ptr < 0) {
        const leaf = ~ptr;
        const off = this.lOff[leaf];
        const l = this.lLen[leaf];
        const c = this.commonPrefix(off, l, keySyms, pos, len - pos);
        if (c === l && pos + c === len) return false;

        const split = this.newNode(off, c, 0);
        if (c < l) {
          // Existing leaf keeps its tail as a shorter leaf under the new node.
          this.lOff[leaf] = off + c;
          this.lLen[leaf] = l - c;
          this.addChild(split, this.readSym(off + c), ~leaf);
        } else {
          // The existing key ends exactly at the split: it becomes terminal.
          this.nFlags[split] |= TERMINAL;
          this.freeLeaf(leaf);
        }
        this.attachNewKey(split, keySyms, pos + c, len);
        this.childPtrs[slot] = split;
        this._size++;
        return true;
      }

      const off = this.nOff[ptr];
      const l = this.nLen[ptr];
      const c = this.commonPrefix(off, l, keySyms, pos, len - pos);
      if (c === l) {
        node = ptr;
        pos += l;
        continue;
      }

      // Split the internal edge: new node takes the shared prefix.
      const split = this.newNode(off, c, 0);
      this.nOff[ptr] = off + c;
      this.nLen[ptr] = l - c;
      this.addChild(split, this.readSym(off + c), ptr);
      this.attachNewKey(split, keySyms, pos + c, len);
      this.childPtrs[slot] = split;
      this._size++;
      return true;
    }
  }

  /** Removes a key. Returns true if it was present. */
  delete(key: string): boolean {
    const len = key.length;
    if (len === 0 || len > MAX_KEY_LENGTH) return false;

    // Path stack: nodes visited and the slot that linked to each.
    const nodes: number[] = [0];
    const slots: number[] = [-1];
    let node = 0;
    let pos = 0;
    let leafSlot = -1;
    let leaf = -1;

    for (;;) {
      if (pos === len) break;
      const sym = SYM[key.charCodeAt(pos)];
      if (sym === INVALID) return false;
      const bm = this.nBitmap[node];
      const bit = 1 << sym;
      if ((bm & bit) === 0) return false;
      const slot = this.nChildBase[node] + popcount(bm & (bit - 1));
      const ptr = this.childPtrs[slot];

      if (ptr < 0) {
        const lf = ~ptr;
        const l = this.lLen[lf];
        if (len - pos !== l || !this.labelMatches(this.lOff[lf], l, key, pos)) return false;
        leaf = lf;
        leafSlot = slot;
        break;
      }
      const l = this.nLen[ptr];
      if (pos + l > len || !this.labelMatches(this.nOff[ptr], l, key, pos)) return false;
      node = ptr;
      pos += l;
      nodes.push(node);
      slots.push(slot);
    }

    if (leaf >= 0) {
      const parent = node;
      this.removeChild(parent, SYM[key.charCodeAt(pos)], leafSlot);
      this.wastedSyms += this.lLen[leaf];
      this.freeLeaf(leaf);
      this._size--;
      this.collapse(nodes, slots);
    } else {
      if ((this.nFlags[node] & TERMINAL) === 0) return false;
      this.nFlags[node] &= ~TERMINAL;
      this._size--;
      this.collapse(nodes, slots);
    }

    if (this.wastedSyms > 4096 && this.wastedSyms * 2 > this.poolSyms) this.compact();
    return true;
  }

  /** True if any stored key starts with `prefix` (case-insensitive base32). */
  hasPrefix(prefix: string): boolean {
    return this.locatePrefix(prefix) !== null;
  }

  /** Stored keys beginning with `prefix`, up to `limit`. */
  keysWithPrefix(prefix: string, limit = 100): string[] {
    const found = this.locatePrefix(prefix);
    if (!found) return [];
    const out: string[] = [];
    // Normalise to canonical upper-case form.
    let head = '';
    for (let i = 0; i < prefix.length; i++) head += ALPHABET[SYM[prefix.charCodeAt(i)]];
    this.walk(found.ptr, head.slice(0, head.length - found.consumedInEdge), out, limit);
    return out;
  }

  /** All keys, in lexicographic (symbol) order. */
  *keys(): IterableIterator<string> {
    const out: string[] = [];
    this.walk(0, '', out, Infinity);
    yield* out;
  }

  clear(): void {
    this.poolSyms = 0;
    this.wastedSyms = 0;
    this.nodeCount = 0;
    this.leafCount = 0;
    this.freeNodes = [];
    this.freeLeaves = [];
    this.freeBlocks = Array.from({ length: 6 }, () => []);
    this.childTop = 0;
    this._size = 0;
    this.pool.fill(0);
    this.newNode(0, 0, 0);
  }

  /** Rebuilds the label pool dropping orphaned symbols; also trims typed arrays to fit. */
  compact(): void {
    const live = this.poolSyms - this.wastedSyms;
    const fresh = new Uint8Array(Math.ceil((live * 5) / 8) + 8);
    let cursor = 0;
    const copy = (off: number, len: number): number => {
      const start = cursor;
      for (let i = 0; i < len; i++) writeSym(fresh, cursor++, this.readSym(off + i));
      return start;
    };
    for (let n = 0; n < this.nodeCount; n++) {
      if (this.nFlags[n] & FREE) continue;
      this.nOff[n] = copy(this.nOff[n], this.nLen[n]);
    }
    for (let l = 0; l < this.leafCount; l++) {
      if (this.leafIsFree(l)) continue;
      this.lOff[l] = copy(this.lOff[l], this.lLen[l]);
    }
    this.pool = fresh;
    this.poolSyms = cursor;
    this.wastedSyms = 0;
  }

  /** Shrinks every typed array to its live size (call after bulk loading / large deletes). */
  trim(): void {
    this.compact();
    this.pool = this.pool.slice(0, Math.ceil((this.poolSyms * 5) / 8) + 8);
    const nodes = Math.max(16, this.nodeCount);
    this.nOff = this.nOff.slice(0, nodes);
    this.nLen = this.nLen.slice(0, nodes);
    this.nFlags = this.nFlags.slice(0, nodes);
    this.nBitmap = this.nBitmap.slice(0, nodes);
    this.nChildBase = this.nChildBase.slice(0, nodes);
    const leaves = Math.max(16, this.leafCount);
    this.lOff = this.lOff.slice(0, leaves);
    this.lLen = this.lLen.slice(0, leaves);
    this.childPtrs = this.childPtrs.slice(0, Math.max(64, this.childTop));
  }

  stats(): RadixIndexStats {
    const allocatedBytes =
      this.pool.byteLength +
      this.nOff.byteLength +
      this.nLen.byteLength +
      this.nFlags.byteLength +
      this.nBitmap.byteLength +
      this.nChildBase.byteLength +
      this.lOff.byteLength +
      this.lLen.byteLength +
      this.childPtrs.byteLength;
    const usedBytes =
      Math.ceil((this.poolSyms * 5) / 8) +
      this.nodeCount * (4 + 1 + 1 + 4 + 4) +
      this.leafCount * (4 + 1) +
      this.childTop * 4;
    return {
      size: this._size,
      internalNodes: this.nodeCount - this.freeNodes.length,
      leaves: this.leafCount - this.freeLeaves.length,
      allocatedBytes,
      usedBytes,
      wastedLabelSymbols: this.wastedSyms,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Internals
  // ═════════════════════════════════════════════════════════════════════════

  private loadKey(key: string): number {
    const len = key.length;
    if (len === 0 || len > MAX_KEY_LENGTH) {
      throw new RangeError(`RadixAddressIndex keys must be 1-${MAX_KEY_LENGTH} chars, got ${len}`);
    }
    for (let i = 0; i < len; i++) {
      const s = SYM[key.charCodeAt(i)];
      if (s === INVALID) throw new TypeError(`Invalid base32 character at position ${i} of key "${key}"`);
      this.scratch[i] = s;
    }
    return len;
  }

  private readSym(i: number): number {
    const bit = i * 5;
    const b = bit >>> 3;
    return ((this.pool[b] | (this.pool[b + 1] << 8)) >>> (bit & 7)) & 31;
  }

  private commonPrefix(off: number, labelLen: number, keySyms: Uint8Array, pos: number, remaining: number): number {
    const max = labelLen < remaining ? labelLen : remaining;
    let i = 0;
    while (i < max && this.readSym(off + i) === keySyms[pos + i]) i++;
    return i;
  }

  private labelMatches(off: number, len: number, key: string, pos: number): boolean {
    for (let i = 0; i < len; i++) {
      if (SYM[key.charCodeAt(pos + i)] !== this.readSym(off + i)) return false;
    }
    return true;
  }

  private appendSymbols(src: Uint8Array, from: number, count: number): number {
    const start = this.poolSyms;
    this.reservePool(count);
    for (let i = 0; i < count; i++) writeSym(this.pool, start + i, src[from + i]);
    this.poolSyms += count;
    return start;
  }

  private reservePool(extraSyms: number): void {
    const needSyms = this.poolSyms + extraSyms;
    if (needSyms > MAX_POOL_SYMBOLS) throw new RangeError('RadixAddressIndex label pool exhausted');
    const needBytes = Math.ceil((needSyms * 5) / 8) + 8;
    if (needBytes <= this.pool.length) return;
    const grown = new Uint8Array(Math.max(needBytes, Math.ceil(this.pool.length * 1.5)));
    grown.set(this.pool);
    this.pool = grown;
  }

  private newLeaf(keySyms: Uint8Array, from: number, count: number): number {
    const off = this.appendSymbols(keySyms, from, count);
    let leaf: number;
    if (this.freeLeaves.length > 0) {
      leaf = this.freeLeaves.pop()!;
    } else {
      if (this.leafCount === this.lOff.length) this.growLeaves();
      leaf = this.leafCount++;
    }
    this.lOff[leaf] = off;
    this.lLen[leaf] = count;
    return leaf;
  }

  /** Free leaves are tracked by a sentinel length of 0 (live leaves always have len >= 1). */
  private freeLeaf(leaf: number): void {
    this.lLen[leaf] = 0;
    this.freeLeaves.push(leaf);
  }

  private leafIsFree(leaf: number): boolean {
    return this.lLen[leaf] === 0;
  }

  private newNode(off: number, len: number, flags: number): number {
    let node: number;
    if (this.freeNodes.length > 0) {
      node = this.freeNodes.pop()!;
    } else {
      if (this.nodeCount === this.nOff.length) this.growNodes();
      node = this.nodeCount++;
    }
    this.nOff[node] = off;
    this.nLen[node] = len;
    this.nFlags[node] = flags;
    this.nBitmap[node] = 0;
    this.nChildBase[node] = 0;
    return node;
  }

  /** After a split at `node`, attaches the remainder of the new key (or marks it terminal). */
  private attachNewKey(node: number, keySyms: Uint8Array, pos: number, len: number): void {
    if (pos === len) {
      this.nFlags[node] |= TERMINAL;
    } else {
      this.addChild(node, keySyms[pos], ~this.newLeaf(keySyms, pos, len - pos));
    }
  }

  private growNodes(): void {
    const cap = Math.ceil(this.nOff.length * 1.5);
    this.nOff = grow(this.nOff, cap);
    this.nLen = grow(this.nLen, cap);
    this.nFlags = grow(this.nFlags, cap);
    this.nBitmap = grow(this.nBitmap, cap);
    this.nChildBase = grow(this.nChildBase, cap);
  }

  private growLeaves(): void {
    const cap = Math.ceil(this.lOff.length * 1.5);
    this.lOff = grow(this.lOff, cap);
    this.lLen = grow(this.lLen, cap);
  }

  private allocBlock(cls: number): number {
    const free = this.freeBlocks[cls];
    if (free.length > 0) return free.pop()!;
    const size = 1 << cls;
    if (this.childTop + size > this.childPtrs.length) {
      this.childPtrs = grow(this.childPtrs, Math.max(this.childTop + size, Math.ceil(this.childPtrs.length * 1.5)));
    }
    const base = this.childTop;
    this.childTop += size;
    return base;
  }

  private addChild(node: number, sym: number, ptr: number): void {
    const bm = this.nBitmap[node];
    const count = popcount(bm);
    const idx = popcount(bm & ((1 << sym) - 1));
    const oldCls = count === 0 ? -1 : nextPow2Class(count);
    const newCls = nextPow2Class(count + 1);

    let base: number;
    if (count === 0) {
      base = this.allocBlock(0);
    } else if (newCls !== oldCls) {
      base = this.allocBlock(newCls);
      const oldBase = this.nChildBase[node];
      this.childPtrs.copyWithin(base, oldBase, oldBase + count);
      this.freeBlocks[oldCls].push(oldBase);
    } else {
      base = this.nChildBase[node];
    }

    // Shift the tail right to open slot `idx`.
    this.childPtrs.copyWithin(base + idx + 1, base + idx, base + count);
    this.childPtrs[base + idx] = ptr;
    this.nChildBase[node] = base;
    this.nBitmap[node] = bm | (1 << sym);
  }

  private removeChild(node: number, sym: number, slot: number): void {
    const bm = this.nBitmap[node];
    const count = popcount(bm);
    const base = this.nChildBase[node];
    this.childPtrs.copyWithin(slot, slot + 1, base + count);
    const newBm = bm & ~(1 << sym);
    this.nBitmap[node] = newBm;

    const oldCls = nextPow2Class(count);
    if (count === 1) {
      this.freeBlocks[oldCls].push(base);
      this.nChildBase[node] = 0;
    } else if (nextPow2Class(count - 1) !== oldCls) {
      const newCls = nextPow2Class(count - 1);
      const smaller = this.allocBlock(newCls);
      this.childPtrs.copyWithin(smaller, base, base + count - 1);
      this.freeBlocks[oldCls].push(base);
      this.nChildBase[node] = smaller;
    }
  }

  /**
   * After a removal, walks back up the path merging any non-terminal,
   * single-child, non-root node into its only child (re-establishing the
   * Patricia invariant that internal nodes branch or terminate).
   */
  private collapse(nodes: number[], slots: number[]): void {
    for (let i = nodes.length - 1; i >= 1; i--) {
      const node = nodes[i];
      const bm = this.nBitmap[node];
      const count = popcount(bm);
      if (count === 0 && !(this.nFlags[node] & TERMINAL)) {
        // Dangling empty node: unlink from its parent.
        const parent = nodes[i - 1];
        const slot = slots[i];
        const parentBm = this.nBitmap[parent];
        const sym = this.symbolAtSlot(parent, slot, parentBm);
        this.removeChild(parent, sym, slot);
        this.freeNode(node);
        continue;
      }
      if (count !== 1 || this.nFlags[node] & TERMINAL) break;

      const onlyPtr = this.childPtrs[this.nChildBase[node]];
      const parentLabelOff = this.nOff[node];
      const parentLabelLen = this.nLen[node];
      const merged = this.mergeLabels(parentLabelOff, parentLabelLen, onlyPtr);
      if (onlyPtr < 0) {
        this.lOff[~onlyPtr] = merged.off;
        this.lLen[~onlyPtr] = merged.len;
      } else {
        this.nOff[onlyPtr] = merged.off;
        this.nLen[onlyPtr] = merged.len;
      }
      this.childPtrs[slots[i]] = onlyPtr;
      this.wastedSyms += parentLabelLen;
      this.freeNode(node);
    }
  }

  private mergeLabels(headOff: number, headLen: number, childPtr: number): { off: number; len: number } {
    const childOff = childPtr < 0 ? this.lOff[~childPtr] : this.nOff[childPtr];
    const childLen = childPtr < 0 ? this.lLen[~childPtr] : this.nLen[childPtr];
    const total = headLen + childLen;
    const tmp = new Uint8Array(total);
    for (let i = 0; i < headLen; i++) tmp[i] = this.readSym(headOff + i);
    for (let i = 0; i < childLen; i++) tmp[headLen + i] = this.readSym(childOff + i);
    this.wastedSyms += childLen; // the child's old label copy is orphaned
    return { off: this.appendSymbols(tmp, 0, total), len: total };
  }

  private symbolAtSlot(node: number, slot: number, bitmap: number): number {
    const idx = slot - this.nChildBase[node];
    let seen = -1;
    for (let s = 0; s < 32; s++) {
      if (bitmap & (1 << s) && ++seen === idx) return s;
    }
    throw new Error('RadixAddressIndex invariant violated: slot not found in bitmap');
  }

  private freeNode(node: number): void {
    const bm = this.nBitmap[node];
    const count = popcount(bm);
    if (count > 0) this.freeBlocks[nextPow2Class(count)].push(this.nChildBase[node]);
    this.nBitmap[node] = 0;
    this.nFlags[node] = FREE;
    this.freeNodes.push(node);
  }

  private locatePrefix(prefix: string): { ptr: number; consumedInEdge: number } | null {
    const len = prefix.length;
    if (len === 0) return this._size > 0 ? { ptr: 0, consumedInEdge: 0 } : null;
    let node = 0;
    let pos = 0;
    for (;;) {
      const sym = SYM[prefix.charCodeAt(pos)];
      if (sym === INVALID) return null;
      const bm = this.nBitmap[node];
      const bit = 1 << sym;
      if ((bm & bit) === 0) return null;
      const ptr = this.childPtrs[this.nChildBase[node] + popcount(bm & (bit - 1))];
      const off = ptr < 0 ? this.lOff[~ptr] : this.nOff[ptr];
      const l = ptr < 0 ? this.lLen[~ptr] : this.nLen[ptr];
      const compare = Math.min(l, len - pos);
      for (let i = 0; i < compare; i++) {
        if (SYM[prefix.charCodeAt(pos + i)] !== this.readSym(off + i)) return null;
      }
      pos += compare;
      if (pos === len) return { ptr, consumedInEdge: compare };
      if (ptr < 0) return null; // prefix longer than the stored key
      node = ptr;
    }
  }

  private edgeString(off: number, len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) s += ALPHABET[this.readSym(off + i)];
    return s;
  }

  /** DFS from `ptr`; `head` is the key text *before* ptr's own edge label. */
  private walk(ptr: number, head: string, out: string[], limit: number): void {
    if (out.length >= limit) return;
    if (ptr < 0) {
      out.push(head + this.edgeString(this.lOff[~ptr], this.lLen[~ptr]));
      return;
    }
    const text = head + this.edgeString(this.nOff[ptr], this.nLen[ptr]);
    if (this.nFlags[ptr] & TERMINAL) out.push(text);
    const bm = this.nBitmap[ptr];
    const base = this.nChildBase[ptr];
    let idx = 0;
    for (let s = 0; s < 32; s++) {
      if (bm & (1 << s)) {
        this.walk(this.childPtrs[base + idx++], text, out, limit);
        if (out.length >= limit) return;
      }
    }
  }
}

function writeSym(pool: Uint8Array, index: number, sym: number): void {
  const bit = index * 5;
  const b = bit >>> 3;
  const shifted = sym << (bit & 7);
  pool[b] |= shifted & 255;
  pool[b + 1] |= shifted >>> 8;
}

function grow<T extends Uint8Array | Uint32Array | Int32Array>(arr: T, capacity: number): T {
  const next = new (arr.constructor as new (n: number) => T)(capacity);
  next.set(arr);
  return next;
}

/**
 * Hot-swappable registry of monitored addresses for the watcher hot path.
 * `replaceAll` builds a fresh trie off to the side and swaps the reference in
 * one assignment, so concurrent `has()` calls never observe a half-built index.
 * Addresses that aren't valid base32 are skipped (and counted) rather than
 * failing the whole refresh.
 */
export class MonitoredAddressRegistry {
  private index = new RadixAddressIndex(16);

  get size(): number {
    return this.index.size;
  }

  has(address: string): boolean {
    return this.index.has(address);
  }

  replaceAll(addresses: Iterable<string>, expectedCount = 1024): { loaded: number; skipped: number } {
    const fresh = new RadixAddressIndex(expectedCount);
    let skipped = 0;
    for (const address of addresses) {
      try {
        fresh.add(address);
      } catch {
        skipped++;
      }
    }
    this.index = fresh;
    return { loaded: fresh.size, skipped };
  }
}
