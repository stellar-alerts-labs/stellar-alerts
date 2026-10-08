import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient, readPaymentLines } from './api.js';
import { StreamHttpError } from './resilient-stream.js';
import { PaymentDTO } from './types.js';

function readerFrom(chunks: string[]) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(encoder.encode(next));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { reader: stream.getReader(), wasCancelled: () => cancelled };
}

async function collect(iterable: AsyncIterable<PaymentDTO>): Promise<string[]> {
  const ids: string[] = [];
  for await (const p of iterable) ids.push(p.id);
  return ids;
}

describe('readPaymentLines', () => {
  it('reassembles records split across chunk boundaries', async () => {
    const { reader } = readerFrom(['{"id":"p1"}\n{"id":', '"p2"}\n{"i', 'd":"p3"}']);
    expect(await collect(readPaymentLines(reader))).toEqual(['p1', 'p2', 'p3']);
  });

  it('skips blank lines, invalid JSON and frames without an id', async () => {
    const { reader } = readerFrom(['\n{"id":"p1"}\nnot json\n{"type":"heartbeat"}\n\n{"id":"p2"}\n']);
    expect(await collect(readPaymentLines(reader))).toEqual(['p1', 'p2']);
  });

  it('cancels the reader when the consumer stops early', async () => {
    const { reader, wasCancelled } = readerFrom(['{"id":"p1"}\n', '{"id":"p2"}\n']);
    for await (const _ of readPaymentLines(reader)) break;
    expect(wasCancelled()).toBe(true);
  });
});

describe('ApiClient.openPaymentStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the cursor and wallet filter as query parameters', async () => {
    const fetchMock = vi.fn(async () => new Response('{"id":"p1"}\n'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new ApiClient('http://api.test', 'key');

    const ids = await collect(await client.openPaymentStream({ cursor: 'tok 1', walletId: 'w1' }));

    expect(ids).toEqual(['p1']);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/payments/stream?walletId=w1&cursor=tok+1',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer key' }) })
    );
  });

  it('omits the query string when there is no cursor (legacy request)', async () => {
    const fetchMock = vi.fn(async () => new Response(''));
    vi.stubGlobal('fetch', fetchMock);
    await collect(await new ApiClient('http://api.test', 'key').openPaymentStream());
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/payments/stream', expect.anything());
  });

  it('surfaces the HTTP status so the caller can decide whether to retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401, statusText: 'Unauthorized' })));
    const error = await new ApiClient('http://api.test', 'key').openPaymentStream().catch((e) => e);
    expect(error).toBeInstanceOf(StreamHttpError);
    expect(error.status).toBe(401);
  });
});
