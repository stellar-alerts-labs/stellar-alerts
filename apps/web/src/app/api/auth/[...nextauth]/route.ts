import NextAuth from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials"

const handler = NextAuth({
  providers: [
    CredentialsProvider({
      name: 'Magic Link',
      credentials: {
        token: { label: "Token", type: "text", placeholder: "Magic Link Token" }
      },
      async authorize(credentials, req) {
        // In a real implementation, this would call the API's magic link verification endpoint
        // e.g., const res = await fetch("http://localhost:3001/auth/verify", { ... })
        if (credentials?.token === 'test-token') {
          return { id: "1", name: "Test User", email: "test@example.com" }
        }
        return null
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
