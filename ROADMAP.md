# Project Roadmap

This document outlines the planned features for the Stellar Payment Tracker. Since the project is in its initial phases, all features are currently marked as planned. We will update this checklist as we make progress.

### Project Setup
- [x] Initialize Git repository, `.gitignore`, and MIT License
- [x] Create project `README.md`
- [x] Add `CONTRIBUTING.md` and `ROADMAP.md`
- [x] Scaffold monorepo workspace (`apps/api`, `apps/web`)
- [x] Set up Fastify backend project with TypeScript
- [x] Add environment variable configuration

### Backend API (Fastify + Prisma)
- [x] Minimal Fastify server with health check
- [x] Prisma schema design and initial database migration
- [x] Passwordless magic-link authentication (`/auth/request-link`, `/auth/verify`)
- [x] Wallet connection endpoint to store Stellar public keys
- [x] Stellar testnet background watcher to poll for new payments
- [ ] Telegram notifications worker via BullMQ queue
- [x] Payments history and summary REST endpoints

### Frontend Web App (Next.js)
- [x] Scaffold Next.js application with Tailwind CSS
- [x] Build landing page
- [x] Build login and authentication flow
- [x] Build wallet onboarding page
- [x] Build payment history dashboard
- [ ] Build notification preferences settings page

### Final Polish
- [ ] Wire up root dev scripts to run both apps simultaneously
- [x] Update documentation to reflect completed status
