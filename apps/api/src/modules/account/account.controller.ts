import { FastifyRequest, FastifyReply } from 'fastify';
import { accountService } from './account.service';

/**
 * Account lifecycle controller — handles authenticated export and deletion
 * requests for the currently-signed-in user.
 */
export class AccountController {
  /**
   * GET /account/export
   *
   * Returns a machine-readable JSON payload containing all data the platform
   * holds about the authenticated user, plus a `paymentsCsv` field with a
   * CSV-encoded payment ledger for spreadsheet import.
   *
   * Clients that want only the CSV may request `?format=csv` and receive the
   * text/csv attachment directly.
   */
  async exportAccount(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    }

    try {
      const exportData = await accountService.exportAccount(request.user.id);

      const format = (request.query as any)?.format;
      if (format === 'csv') {
        return reply
          .status(200)
          .header('Content-Type', 'text/csv')
          .header(
            'Content-Disposition',
            `attachment; filename="stellar-alerts-payments-${request.user.id}.csv"`,
          )
          .send(exportData.paymentsCsv);
      }

      return reply.status(200).send({ success: true, export: exportData });
    } catch (error: any) {
      if (error.message === 'User not found') {
        return reply.status(404).send({ error: 'Not Found', message: 'User account not found' });
      }
      throw error;
    }
  }

  /**
   * DELETE /account
   *
   * Permanently and irreversibly deletes the authenticated user's account and
   * all associated data (wallets, payments, webhooks, preferences, etc.).
   *
   * Returns a 200 with a deletion summary so callers can verify what was
   * removed.  The session token is still valid for the remainder of its TTL
   * since the user record is gone and any subsequent authenticated request will
   * 404 at the service layer.  Clients should clear local session storage after
   * receiving a 200.
   */
  async deleteAccount(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    }

    try {
      const summary = await accountService.deleteAccount(request.user.id);
      return reply.status(200).send({ success: true, deletion: summary });
    } catch (error: any) {
      if (
        error.message?.includes('Record to delete does not exist') ||
        error.code === 'P2025'
      ) {
        return reply.status(404).send({ error: 'Not Found', message: 'User account not found' });
      }
      throw error;
    }
  }
}

export const accountController = new AccountController();
