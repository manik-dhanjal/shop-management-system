# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Shop Management System** — A full-stack application for managing shops, inventory, orders, customers, and GST billing. Features a NestJS backend, React frontend, and multi-environment deployment (dev/stage/prod) on free-tier cloud services.

**Live environments:**
- Dev: https://shop-management-system-git-develop-manikdhanjals-projects.vercel.app (backend: https://sms-dev.onrender.com)
- Stage: https://shop-management-system-git-stage-manikdhanjals-projects.vercel.app (backend: https://sms-stage-9e8p.onrender.com)
- Prod: https://shop-management-system-beta.vercel.app (backend: https://sms-prod.onrender.com)

Default login: `admin@sms.com` / `Admin@123`

## Monorepo Structure

```
SMS/
├── backend/               # NestJS API server
│   ├── src/api/          # Feature modules (shop, customer, orders, etc.)
│   ├── src/shared/       # Auth guards, DTOs, config, utilities
│   ├── package.json
│   └── CLAUDE.md         # Backend-specific guidance
├── frontend/             # React + Vite application
│   ├── src/pages/        # Route components
│   ├── src/components/   # Reusable UI components
│   ├── src/api/          # API client and hooks
│   └── package.json
├── infra/                # Terraform IaC for cloud resources
│   ├── main.tf           # Main configuration
│   ├── modules/          # Render, Vercel, MongoDB modules
│   └── terraform.tfvars  # Secrets (never commit)
├── docker/               # Docker configuration
│   ├── seed/             # Database seeding script
│   └── Dockerfile (backend & frontend)
├── docker-compose.yml    # Production build services
├── docker-compose.local.yml # Hot reload overrides
├── compose.sh            # Runs compose with local overrides
├── .env                  # Local environment variables
├── .env.example          # Template for .env
├── README.md             # Quick start guide
└── DEPLOYMENT.md         # Release workflow and infra setup
```

## Quick Start

### Local Development (Hot Reload)

```bash
# 1. Clone with submodules
git clone --recurse-submodules <repo-url>
cd shop-management-system

# 2. Configure environment
cp .env.example .env
# Edit .env with real values (Cloudinary, JWT secret, GST API credentials)

# 3. Start services with hot reload
./compose.sh up --build
```

Access:
- **Frontend:** http://localhost:5173
- **Backend:** http://localhost:3001
- **API Docs:** http://localhost:3001/docs
- **MongoDB:** localhost:27017

### Production Build (Docker)

```bash
docker compose up --build
# Serves frontend on http://localhost:3000, backend on :3001
```

### Reset Local Database

```bash
docker compose down -v && docker compose up --build
```

## Development Commands

### Backend

```bash
cd backend

# Start (dev mode with hot reload)
npm run start:dev

# Build and run production
npm run build && npm run start:prod

# Linting and formatting
npm run lint && npm run format

# Tests
npm run test              # Unit tests
npm run test:watch      # Watch mode
npm run test:e2e        # E2E tests
```

See `backend/CLAUDE.md` for detailed backend architecture and patterns.

### Frontend

```bash
cd frontend

# Development server (Vite)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Linting and formatting
npm run lint && npm run format
```

## Branch → Environment Workflow

```
feature/*
    ↓
develop ──► Push auto-deploys to Dev (Render + Vercel)
    ↓
stage ──► PR merge auto-deploys to Stage (requires review)
    ↓
master ──► PR merge auto-deploys to Prod (requires review + CI pass)
```

**Day-to-day:**
1. Branch from `develop` with `feature/` prefix
2. Commit and push → opens auto-deploy preview
3. Merge to `develop` → deploys to dev environment
4. Create PR to `stage` → deploys to stage after merge
5. Create PR to `master` → deploys to prod after review and CI

See `DEPLOYMENT.md` for detailed release procedures.

## Deployment & Infrastructure

### Cloud Services

| Component | Service | Free Tier Notes |
|-----------|---------|-----------------|
| Backend ×3 | Render | 750 hrs/month; sleeps after 15 min idle (~30s cold start) |
| Frontend | Vercel | Unlimited hobby deployments |
| Database | MongoDB Atlas | M0 cluster, 512 MB storage, shared across 3 envs |

### CI/CD

Automated via GitHub → Render/Vercel. Branch protection on `stage` and `master`:
- `stage`: PR required, no force push
- `master`: PR required, 1 approving review, CI must pass, no force push

### Seeding Databases

```bash
cd docker/seed && npm install
MONGO_URL="mongodb+srv://<user>:<password>@sms-cluster.wff27ni.mongodb.net/<db>" node seed.js
```

Seeding is idempotent (creates demo shop, admin user, 5 products, 5 customers).

### Infrastructure Setup (First-Time Only)

See `DEPLOYMENT.md` section "First-time infrastructure setup" for Terraform provisioning steps. Requires Vercel, MongoDB Atlas, Render, and GitHub API keys.

## Environment Variables

Copy `.env.example` to `.env` and fill in:

**Required:**
- `CLOUDINARY_*` — Media storage API credentials
- `USER_JWT_SECRET` — Secret for JWT token signing
- `GST_PROVIDER_*` — GST (tax) API credentials

**Optional:**
- `MONGO_LOGGER_LEVEL` — MongoDB driver log level (default: `info`)
- `GST_BASE_URL` — GST API base URL (default: `https://api.whitebooks.in`)

Frontend build-time vars (via Vite):
- `VITE_API_URL` — Backend API URL (auto-set by Docker)

## Key Architecture Decisions

### Backend

- **Modular structure** — Each domain (shop, customer, order) is an independent NestJS module
- **Repository pattern** — Services delegate to repositories for data access
- **Global guards** — AuthGuard and RolesGuard applied app-wide; `@SkipAuth()` for public endpoints
- **DTOs + class-validator** — All request/response payloads validated
- **URI versioning** — Endpoints versioned with `/api/v{N}` prefix

### Frontend

- **Vite + React** — Fast bundler and HMR for development
- **MUI + Tailwind CSS** — Component library with utility CSS
- **React Router** — Client-side routing with protected routes
- **TanStack Query** — Async state management for API calls

### Deployment

- **Three isolated environments** — dev/stage/prod with separate databases and services
- **Terraform IaC** — All cloud infrastructure versioned and reproducible
- **Free-tier services** — Render (backend), Vercel (frontend), MongoDB Atlas (database)

## Testing

- **Backend:** Jest unit tests in `backend/src/**/*.spec.ts`
- **Frontend:** Tests in `frontend/src/` (testing library)
- **E2E:** Backend e2e tests in `backend/test/jest-e2e.json`

Run with `npm run test` in respective directories.

## Updating Submodules

If the frontend or another submodule is a git submodule:

```bash
# Update all submodules to latest remote
git submodule update --remote --merge

# Pull and update submodules simultaneously
git pull --recurse-submodules
```

## Common Tasks

| Task | Command |
|------|---------|
| Start local dev | `./compose.sh up --build` |
| Start prod build | `docker compose up --build` |
| Seed databases | `cd docker/seed && MONGO_URL="..." node seed.js` |
| Deploy to dev | Push to `develop` branch |
| Deploy to stage | Merge PR to `stage` |
| Deploy to prod | Merge PR to `master` |
| Reset local data | `docker compose down -v && docker compose up --build` |
| View logs | `docker compose logs -f <service>` |

## Notes

- Render free tier sleeps after 15 min of inactivity; first request after sleep takes ~30s
- MongoDB Atlas free tier (M0) has 512 MB storage limit across all environments
- `terraform.tfstate` contains sensitive credentials — never commit
- Frontend environment variables are baked into the build; rebuild when `VITE_API_URL` changes
- Database seeding is idempotent and safe to run multiple times
