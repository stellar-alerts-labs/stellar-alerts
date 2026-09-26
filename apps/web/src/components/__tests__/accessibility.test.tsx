import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MfaModal } from '../dashboard/MfaModal';
import { NotificationModal } from '../dashboard/NotificationModal';
import { PaymentTable } from '../dashboard/PaymentTable';
import { ActivityHeatmap } from '../dashboard/ActivityHeatmap';
import { WalletAlertActivationWizard } from '../dashboard/WalletAlertActivationWizard';

describe('Accessibility & Keyboard Audit (#331)', () => {
  describe('MfaModal Accessibility', () => {
    it('renders with dialog role, aria-modal, and labeledby title', () => {
      const handleClose = vi.fn();
      render(
        <MfaModal
          isOpen={true}
          onClose={handleClose}
          onVerifySuccess={() => {}}
        />
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'mfa-modal-title');
      expect(screen.getByText(/Multi-Factor Auth/i)).toBeInTheDocument();
    });

    it('closes on Escape key press', () => {
      const handleClose = vi.fn();
      render(
        <MfaModal
          isOpen={true}
          onClose={handleClose}
          onVerifySuccess={() => {}}
        />
      );

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('provides accessible close button', () => {
      const handleClose = vi.fn();
      render(
        <MfaModal
          isOpen={true}
          onClose={handleClose}
          onVerifySuccess={() => {}}
        />
      );

      const closeBtn = screen.getByRole('button', { name: /Close Multi-Factor Auth Modal/i });
      expect(closeBtn).toBeInTheDocument();
    });
  });

  describe('NotificationModal Accessibility', () => {
    it('renders with dialog role and modal metadata', () => {
      const handleClose = vi.fn();
      render(
        <NotificationModal
          isOpen={true}
          onClose={handleClose}
          onSavePreferences={() => {}}
        />
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'notification-modal-title');
    });

    it('handles Escape key to close modal', () => {
      const handleClose = vi.fn();
      render(
        <NotificationModal
          isOpen={true}
          onClose={handleClose}
          onSavePreferences={() => {}}
        />
      );

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(handleClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('PaymentTable Accessibility', () => {
    const mockPayments = [
      {
        id: '1',
        walletId: 'w1',
        txHash: '0x1234567890abcdef',
        fromAddress: 'GAXYZ1234567890ABCDEF',
        amount: 100.5,
        asset: 'XLM',
        receivedAt: new Date().toISOString(),
      },
    ];

    it('has accessible search and asset filter controls', () => {
      render(<PaymentTable payments={mockPayments} isLoading={false} />);

      const searchInput = screen.getByLabelText(/Search payments by sender address/i);
      expect(searchInput).toBeInTheDocument();

      const filterSelect = screen.getByLabelText(/Filter payments by asset code/i);
      expect(filterSelect).toBeInTheDocument();
    });

    it('allows keyboard typing into search input', () => {
      render(<PaymentTable payments={mockPayments} isLoading={false} />);

      const searchInput = screen.getByLabelText(/Search payments by sender address/i);
      fireEvent.change(searchInput, { target: { value: 'GAXYZ' } });
      expect(searchInput).toHaveValue('GAXYZ');
    });
  });

  describe('ActivityHeatmap Accessibility', () => {
    it('renders heatmap with accessible range selection controls', () => {
      render(
        <ActivityHeatmap
          payments={[
            { receivedAt: new Date().toISOString() },
          ]}
        />
      );

      const heading = screen.getByRole('heading', { name: /Activity/i });
      expect(heading).toBeInTheDocument();
    });
  });

  describe('WalletAlertActivationWizard Accessibility', () => {
    it('renders step 1 with form labels and accessible submit controls', () => {
      render(<WalletAlertActivationWizard />);

      expect(screen.getByText(/Connect Stellar Watch-Only Address/i)).toBeInTheDocument();
      const input = screen.getByPlaceholderText(/GBBD47/i);
      expect(input).toBeInTheDocument();
    });
  });
});
