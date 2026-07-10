export class AuthService {
  async requestMagicLink(email: string): Promise<void> {
    // TODO: Generate a token, store in DB, and send via email service
    console.log(`[AuthService] Magic link requested for: ${email}`);
  }

  async verifyMagicLink(token: string): Promise<string> {
    // TODO: Verify token against DB, return a JWT or session identifier
    console.log(`[AuthService] Magic link verified with token: ${token}`);
    return 'fake-jwt-token';
  }
}

export const authService = new AuthService();
