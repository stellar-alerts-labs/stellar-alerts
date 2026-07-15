import NextAuth from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials"

if (!process.env.NEXTAUTH_SECRET) {
  throw new Error("NEXTAUTH_SECRET must be set");
}

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
          
          if (data.success && data.token && data.user) {
            return { id: data.user.id, name: data.user.email, email: data.user.email, accessToken: data.token };
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
  secret: process.env.NEXTAUTH_SECRET,
})

export { handler as GET, handler as POST }
