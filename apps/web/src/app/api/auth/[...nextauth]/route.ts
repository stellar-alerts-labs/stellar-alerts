import NextAuth from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials"

const handler = NextAuth({
  providers: [
    CredentialsProvider({
      name: 'Magic Link',
      credentials: {
        token: { label: "Token", type: "text", placeholder: "Magic Link Token" }
      },
      async authorize(credentials) {
        if (!credentials?.token) return null;
        
        try {
          const res = await fetch(`http://localhost:3001/auth/verify?token=${encodeURIComponent(credentials.token)}`);
          if (!res.ok) return null;
          const data = await res.json();
          
          if (data.success && data.token) {
            // we'll just mock user info for now since backend doesn't return user details
            return { id: "1", name: "Test User", email: "test@example.com", accessToken: data.token };
          }
        } catch (e) {
          console.error('API Verification error', e);
        }
        return null;
      }
    })
  ],
  pages: {
    signIn: '/auth/signin',
  },
  session: {
    strategy: "jwt",
  },
  secret: process.env.NEXTAUTH_SECRET || "fallback_secret_for_development",
})

export { handler as GET, handler as POST }
