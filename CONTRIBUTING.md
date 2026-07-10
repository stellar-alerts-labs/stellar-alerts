# Contributing to Stellar Payment Tracker

Thank you for your interest in contributing! We appreciate your help in making this project better for freelancers using the Stellar network.

## Getting Started

1. **Fork and Clone:** Fork the repository on GitHub and clone it to your local machine.
2. **Install Dependencies:** We use npm workspaces. Run `npm install` from the root directory to install all dependencies for both the frontend and backend.
3. **Environment Setup:** Copy `.env.example` to `.env` in the respective application folders and fill in your local development values (e.g., PostgreSQL database URL, Redis URL).
4. **Database Setup:** Run `npx prisma migrate dev` in the `apps/api` directory to initialize the database schema.

## Development Workflow

- We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification for all commit messages. Please format your commits as `type(scope): description`.
- Ensure you test your changes locally. We exclusively use the Stellar testnet for all development and testing—never use real funds!
- Create a new branch for your feature or bug fix: `git checkout -b feature/your-feature-name`.

## Submitting a Pull Request

1. Push your branch to your fork.
2. Open a Pull Request against the `main` branch of this repository.
3. Provide a clear description of the problem you solved or the feature you added.
4. Wait for maintainers to review your PR.
