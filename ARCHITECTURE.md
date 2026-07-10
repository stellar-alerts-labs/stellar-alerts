# Stellar Payment Tracker — Architecture

## 1. Overview

A tool that watches a person's Stellar wallet for incoming payments and notifies them
in real time, with a full history available in a web dashboard.

Data flows in one direction, start to finish:

```
Stellar network → Background workers → Postgres → Fastify API → Next.js web app
                        │
                        └──> Telegram / Email (notifications, fired directly)
```

The Next.js app never talks to Stellar directly. It only ever calls the Fastify API,
which reads from Postgres. All blockchain logic lives in one place: the backend.

---

## 2. Tech stack

| Layer            | Choice                                   |
|-------------------|-------------------------------------------|
| Backend framework | Fastify + TypeScript                      |
| Frontend framework| Next.js + TypeScript (App Router)         |
| ORM / Database    | Prisma + PostgreSQL                       |
| Job queue         | BullMQ + Redis                            |
| Blockchain access | `stellar-sdk` (Horizon REST + SSE streams)|
| Notifications     | Telegram Bot API, Email (Resend), WhatsApp (phase 2) |
| Auth              | Passwordless magic-link email + JWT session cookie |

**Why BullMQ/Redis:** this is the same job-queue pattern already planned for the church
contributions app — no new stack to learn, just a second use for a pattern already
being worked out.

---

## 3. Backend structure (Fastify + TypeScript)

```
apps/api/
├── src/
│   ├── app.ts                    # Fastify instance, plugin registration
│   ├── server.ts                 # Entry point, starts the HTTP server
│   ├── config/
│   │   └── env.ts                # Environment variable validation (zod)
│   ├── plugins/
│   │   ├── prisma.ts             # Registers Prisma client as a Fastify decorator
│   │   ├── auth.ts               # JWT/session verification (preHandler hook)
│   │   └── cors.ts
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.routes.ts     # POST /auth/request-link, GET /auth/verify
│   │   │   ├── auth.service.ts    # magic-link token generation/verification
│   │   │   └── auth.schema.ts     # request/response schemas (zod or typebox)
│   │   ├── wallets/
│   │   │   ├── wallets.routes.ts  # POST /wallets, DELETE /wallets/:id
│   │   │   ├── wallets.service.ts # validates + stores a Stellar public key
│   │   │   └── wallets.schema.ts
│   │   ├── payments/
│   │   │   ├── payments.routes.ts # GET /payments, GET /payments/summary
│   │   │   └── payments.service.ts
│   │   └── notifications/
│   │       ├── notifications.routes.ts  # GET/PUT /notifications/preferences
│   │       └── notifications.service.ts
│   ├── workers/
│   │   ├── watcher.worker.ts     # polls/streams Horizon per wallet
│   │   └── notify.worker.ts      # BullMQ consumer, fans out alerts
│   ├── queues/
│   │   └── notification.queue.ts # BullMQ queue definition
│   └── lib/
│       ├── stellar.ts            # thin wrapper around stellar-sdk
│       ├── telegram.ts
│       └── email.ts
├── prisma/
│   └── schema.prisma
└── package.json
```

---

## 4. Frontend structure (Next.js + TypeScript)

```
apps/web/
├── app/
│   ├── page.tsx                       # Landing page — problem, solution, CTA
│   ├── (auth)/
│   │   ├── login/page.tsx             # Email entry
│   │   └── verify/page.tsx            # Magic-link landing, exchanges token for session
│   ├── (dashboard)/
│   │   ├── layout.tsx                 # Authenticated shell (nav, notification bell)
│   │   ├── onboarding/page.tsx        # Connect Stellar address
│   │   ├── settings/
│   │   │   └── notifications/page.tsx # Toggle Telegram / email / WhatsApp
│   │   └── dashboard/page.tsx         # History table + live feed
├── components/
│   ├── WalletConnectForm.tsx
│   ├── NotificationToggleList.tsx
│   ├── PaymentHistoryTable.tsx
│   └── NotificationBell.tsx
└── lib/
    └── apiClient.ts                   # Typed fetch wrapper to the Fastify API
```

---

## 5. Data model (Prisma schema)

```prisma
model User {
  id          String                   @id @default(cuid())
  email       String                   @unique
  createdAt   DateTime                 @default(now())
  wallets     Wallet[]
  notifyPrefs NotificationPreference?
}

model Wallet {
  id         String     @id @default(cuid())
  userId     String
  user       User       @relation(fields: [userId], references: [id])
  publicKey  String     @unique
  label      String?
  createdAt  DateTime   @default(now())
  payments   Payment[]
}

model Payment {
  id          String   @id @default(cuid())
  walletId    String
  wallet      Wallet   @relation(fields: [walletId], references: [id])
  txHash      String   @unique
  fromAddress String
  amount      Decimal
  asset       String
  memo        String?
  receivedAt  DateTime
  createdAt   DateTime @default(now())
}

model NotificationPreference {
  id              String  @id @default(cuid())
  userId          String  @unique
  user            User    @relation(fields: [userId], references: [id])
  telegramChatId  String?
  telegramEnabled Boolean @default(false)
  emailEnabled    Boolean @default(true)
  whatsappNumber  String?
  whatsappEnabled Boolean @default(false)
}
```

---

## 6. How the pieces talk to each other

1. `watcher.worker.ts` runs on a schedule (or streams via Horizon's SSE endpoint) for
   every wallet stored in the database, checking for new incoming payment operations.
2. A new payment is found → written to the `Payment` table via Prisma → a job is
   pushed onto `notification.queue` (BullMQ/Redis).
3. `notify.worker.ts` consumes that queue, checks the user's `NotificationPreference`,
   and fans out to whichever channels are enabled — Telegram and email at launch,
   WhatsApp once Meta's business approval is in place.
4. The Next.js app only ever calls the Fastify API (`/payments`, `/wallets`,
   `/notifications/preferences`). It never touches Stellar or Postgres directly.

---

## 7. Auth approach

Passwordless magic-link email: a user enters their email, the backend generates a
short-lived signed token, emails a login link, and verifying that link issues a
session (JWT in an httpOnly cookie). No password hashing or storage to manage — one
less security surface for a project maintained solo.

---

## 8. Deployment sketch

| Piece      | Suggested host                         |
|------------|------------------------------------------|
| API        | Render or Railway                        |
| Web        | Vercel (native Next.js hosting)          |
| Postgres   | Neon                                     |
| Redis      | Upstash (serverless-friendly)            |

---

## 9. Security notes

- Only ever store **public** Stellar addresses — private keys are never requested,
  transmitted, or stored, anywhere in the system.
- Validate the Stellar public key format before accepting it (starts with `G`, 56
  characters, valid checksum) to reject typos and garbage input early.
- Rate-limit the wallet-add and magic-link endpoints to prevent abuse.
- Test everything against Stellar's public testnet before pointing the watcher at any
  real wallet.
