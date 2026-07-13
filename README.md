# Stellar Payment Tracker

## The Problem
Many freelancers and contractors receive payments in USDC on the Stellar network. However, existing wallets and interfaces often lack robust payment notifications or a dedicated history view, making it difficult to keep track of incoming funds. 

## The Solution
Stellar Payment Tracker is a specialized tool that watches a Stellar wallet for incoming payments and instantly notifies the owner via Telegram or email. It provides a comprehensive web dashboard showing full payment history, enabling freelancers to confidently track their earnings without constantly checking their wallet balance.

## Tech Stack
This project uses a modern monorepo architecture with the following core technologies:
- **Backend:** Fastify + TypeScript
- **Frontend:** Next.js (App Router) + TypeScript + Tailwind CSS
- **Database:** PostgreSQL + Prisma
- **Job Queue:** Redis + BullMQ
- **Blockchain:** `stellar-sdk` (connecting to the Horizon API)

For a complete breakdown of the system design, data models, and backend/frontend structure, please refer to the [Architecture Document](ARCHITECTURE.md).

## Current Status
**Status: Under Construction**
The project is currently in the early stages of development. We are setting up the monorepo structure and laying the groundwork for the core tracking features. See the [Roadmap](ROADMAP.md) (coming soon) for more details.
