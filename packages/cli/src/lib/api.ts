import { WalletDTO, PaymentDTO, isValidStellarPublicKey } from './types.js';
import { getCliConfig } from './config.js';
import { StreamHttpError } from './resilient-stream.js';

export class ApiClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = baseUrl || getCliConfig().STELLAR_ALERTS_API_URL;
    this.apiKey = apiKey || getCliConfig().STELLAR_ALERTS_API_KEY;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async getWallets(): Promise<WalletDTO[]> {
    const response = await fetch(`${this.baseUrl}/wallets`, {
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch wallets: ${response.statusText}`);
    }
    return response.json();
  }

  async addWallet(publicKey: string, label?: string): Promise<WalletDTO> {
    if (!isValidStellarPublicKey(publicKey)) {
      throw new Error('Invalid Stellar public key. Must start with G and be 56 characters.');
    }

    const response = await fetch(`${this.baseUrl}/wallets`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ publicKey, label }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.message || 'Failed to add wallet');
    }

    return response.json();
  }

  async deleteWallet(id: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/wallets/${id}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to delete wallet: ${response.statusText}`);
    }
  }

  async getPayments(walletId?: string, limit?: number): Promise<PaymentDTO[]> {
    const params = new URLSearchParams();
    if (walletId) params.append('walletId', walletId);
    if (limit) params.append('limit', limit.toString());

    const response = await fetch(`${this.baseUrl}/payments?${params}`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch payments: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Opens one connection to the NDJSON payment stream. `cursor` asks the server
   * to resume after that payment; servers that ignore it still work because the
   * CLI suppresses replayed ids client-side.
   */
  async openPaymentStream(
    options: { cursor?: string; walletId?: string; signal?: AbortSignal } = {}
  ): Promise<AsyncIterable<PaymentDTO>> {
    const params = new URLSearchParams();
    if (options.walletId) params.append('walletId', options.walletId);
    if (options.cursor) params.append('cursor', options.cursor);
    const query = params.toString();

    const response = await fetch(`${this.baseUrl}/payments/stream${query ? `?${query}` : ''}`, {
      headers: this.getHeaders(),
      signal: options.signal,
    });

    if (!response.ok) {
      throw new StreamHttpError(
        `Failed to connect to payment stream: ${response.statusText || response.status}`,
        response.status
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    return readPaymentLines(reader);
  }

  async streamPayments(
    onPayment: (payment: PaymentDTO) => void,
    signal?: AbortSignal
  ): Promise<void> {
    for await (const payment of await this.openPaymentStream({ signal })) {
      onPayment(payment);
    }
  }
}

function parsePaymentLine(line: string): PaymentDTO | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    // Heartbeats and other non-payment frames carry no id.
    return parsed && typeof parsed.id === 'string' ? (parsed as PaymentDTO) : null;
  } catch {
    return null;
  }
}

/**
 * Yields one payment per newline-delimited JSON record, buffering partial lines
 * across chunk boundaries. The reader is always cancelled on exit so the
 * underlying socket is released on abort, break, or error.
 */
export async function* readPaymentLines(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<PaymentDTO> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const payment = parsePaymentLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (payment) yield payment;
      }
    }

    const tail = parsePaymentLine(buffer);
    if (tail) yield tail;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export const apiClient = new ApiClient();
