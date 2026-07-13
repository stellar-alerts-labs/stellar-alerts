# Project Roadmap

This document outlines the planned features for the Stellar Payment Tracker. Since the project is in its initial phases, all features are currently marked as planned. We will update this checklist as we make progress.

### Project Setup
- [x] Initialize Git repository, `.gitignore`, and MIT License
- [x] Create project `README.md`
- [x] Add `CONTRIBUTING.md` and `ROADMAP.md`
- [ ] Scaffold monorepo workspace (`apps/api`, `apps/web`)
- [ ] Set up Fastify backend project with TypeScript
- [ ] Add environment variable configuration

### Backend API (Fastify + Prisma)
- [ ] Minimal Fastify server with health check
- [ ] Prisma schema design and initial database migration
- [ ] Passwordless magic-link authentication (`/auth/request-link`, `/auth/verify`)
- [ ] Wallet connection endpoint to store Stellar public keys
- [ ] Stellar testnet background watcher to poll for new payments
- [ ] Telegram notifications worker via BullMQ queue
- [ ] Payments history and summary REST endpoints

### Frontend Web App (Next.js)
- [ ] Scaffold Next.js application with Tailwind CSS
- [ ] Build landing page
- [ ] Build login and authentication flow
- [ ] Build wallet onboarding page
- [ ] Build payment history dashboard
- [ ] Build notification preferences settings page

### Final Polish
- [ ] Wire up root dev scripts to run both apps simultaneously
- [ ] Update documentation to reflect completed status
