import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Stellar Alerts — Real-Time Stellar Payment Tracker & Alert System",
  description:
    "Monitor your Stellar public wallets in real time. Receive instant payment alerts via Telegram, Email, and Webhooks with full transaction ledger history.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-[radial-gradient(1200px_800px_at_10%_10%,rgba(124,58,237,0.06),transparent_8%),radial-gradient(1000px_600px_at_90%_90%,rgba(99,102,241,0.04),transparent_10%),#050508] text-gray-100 font-sans selection:bg-purple-500/30">
        <Providers>
          <div className="min-h-full w-full flex items-start justify-center py-8 px-4">
            <main className="w-full max-w-7xl glass backdrop-blur-xl glass-inner">
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
