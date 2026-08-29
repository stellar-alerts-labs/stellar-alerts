import { describe, it, expect, vi, beforeEach } from 'vitest';
import { paymentsController } from '../payments.controller';
import { paymentsService } from '../payments.service';

// Mock the payments service
vi.mock('../payments.service', () => ({
  paymentsService: {
    getPaymentsSummary: vi.fn(),
  },
}));

// Mock the exchange-rates module
vi.mock('../../lib/exchange-rates', () => ({
  convertUsdToFiat: vi.fn(),
  isSupportedFiatCurrency: vi.fn((currency: string) =>
    ['USD', 'EUR', 'CAD', 'JPY', 'GBP', 'AUD'].includes(currency)
  ),
  SUPPORTED_FIAT_CURRENCIES: ['USD', 'EUR', 'CAD', 'JPY', 'GBP', 'AUD'],
}));

describe('PaymentsController - Fiat Currency Conversion', () => {
  let mockRequest: any;
  let mockReply: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
  });

  it('should return summary without fiat conversion when fiat param is not provided', async () => {
    const mockSummary = { totalReceived: 1000, paymentCount: 5 };
    (paymentsService.getPaymentsSummary as any).mockResolvedValue(mockSummary);

    mockRequest = { query: { walletId: 'wallet-1' } };

    await paymentsController.getPaymentsSummary(mockRequest, mockReply);

    expect(paymentsService.getPaymentsSummary).toHaveBeenCalledWith('wallet-1', undefined);
    expect(mockReply.send).toHaveBeenCalledWith({ success: true, summary: mockSummary });
  });

  it('should return summary with fiat conversion when valid fiat param is provided', async () => {
    const mockSummary = {
      totalReceived: 1000,
      paymentCount: 5,
      fiatConversion: {
        currency: 'JPY',
        convertedTotal: 150000,
        exchangeRate: 150,
      },
    };
    (paymentsService.getPaymentsSummary as any).mockResolvedValue(mockSummary);

    mockRequest = { query: { walletId: 'wallet-1', fiat: 'JPY' } };

    await paymentsController.getPaymentsSummary(mockRequest, mockReply);

    expect(paymentsService.getPaymentsSummary).toHaveBeenCalledWith('wallet-1', 'JPY');
    expect(mockReply.send).toHaveBeenCalledWith({ success: true, summary: mockSummary });
  });

  it('should return 400 for invalid query parameters', async () => {
    mockRequest = { query: {} }; // Missing required walletId

    await paymentsController.getPaymentsSummary(mockRequest, mockReply);

    expect(mockReply.status).toHaveBeenCalledWith(400);
    expect(mockReply.send).toHaveBeenCalled();
  });

  it('should handle unsupported fiat currency gracefully', async () => {
    const mockSummary = { totalReceived: 1000, paymentCount: 5 };
    (paymentsService.getPaymentsSummary as any).mockResolvedValue(mockSummary);

    mockRequest = { query: { walletId: 'wallet-1', fiat: 'XYZ' } };

    await paymentsController.getPaymentsSummary(mockRequest, mockReply);

    // Unsupported currency should be passed as undefined to service
    expect(paymentsService.getPaymentsSummary).toHaveBeenCalledWith('wallet-1', 'XYZ');
    expect(mockReply.send).toHaveBeenCalledWith({ success: true, summary: mockSummary });
  });

  it('should support all required fiat currencies', async () => {
    const supportedCurrencies = ['CAD', 'JPY', 'GBP', 'AUD', 'USD', 'EUR'];

    for (const currency of supportedCurrencies) {
      vi.clearAllMocks();
      const mockSummary = { totalReceived: 1000, paymentCount: 5 };
      (paymentsService.getPaymentsSummary as any).mockResolvedValue(mockSummary);

      mockRequest = { query: { walletId: 'wallet-1', fiat: currency } };
      mockReply = { status: vi.fn().mockReturnThis(), send: vi.fn() };

      await paymentsController.getPaymentsSummary(mockRequest, mockReply);

      expect(paymentsService.getPaymentsSummary).toHaveBeenCalledWith('wallet-1', currency);
      expect(mockReply.send).toHaveBeenCalledWith({ success: true, summary: mockSummary });
    }
  });
});
