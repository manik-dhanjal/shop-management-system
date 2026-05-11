# Shop Management System

Manage inventory, orders, customers, and GST billing all in one place. Docker-powered setup for local development; three cloud environments for dev/stage/prod.

## Live Environments

| Environment | Frontend                                                                                                                                             | Backend                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Dev**     | [shop-management-system-git-develop-manikdhanjals-projects.vercel.app](https://shop-management-system-git-develop-manikdhanjals-projects.vercel.app) | https://sms-dev.onrender.com        |
| **Stage**   | [shop-management-system-git-stage-manikdhanjals-projects.vercel.app](https://shop-management-system-git-stage-manikdhanjals-projects.vercel.app)     | https://sms-stage-9e8p.onrender.com |
| **Prod**    | [shop-management-system-beta.vercel.app/](https://shop-management-system-beta.vercel.app)                                                            | https://sms-prod.onrender.com       |

> Render free tier sleeps after 15 min of inactivity — first request takes ~30s to wake up.

## Default Login

```
Email:    admin@sms.com
Password: Admin@123
```

## Local Development

### 1. Clone with submodules

```bash
git clone --recurse-submodules https://github.com/manik-dhanjal/shop-management-system.git
cd shop-management-system
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

### 2. Configure environment

```bash
cp .env.example .env
# fill in real values (Cloudinary, JWT secret, GST credentials)
```

### 3. Start

**Production build (serves on localhost:3000):**

```bash
docker compose up --build
```

**Hot reload (frontend on :5173, backend on :3001):**

```bash
./compose.sh
```

### Services (local)

| Service  | Production                 | Dev (hot reload)           |
| -------- | -------------------------- | -------------------------- |
| Frontend | http://localhost:3000      | http://localhost:5173      |
| API      | http://localhost:3001      | http://localhost:3001      |
| API Docs | http://localhost:3001/docs | http://localhost:3001/docs |
| MongoDB  | localhost:27017            | localhost:27017            |

## Branch → Environment

```
feature/* ──► develop ──► stage ──► master
                │            │         │
               dev         stage      prod
```

Pushing to `develop` auto-deploys to dev. Promoting to `stage` or `master` requires a pull request (see [DEPLOYMENT.md](DEPLOYMENT.md) for the full release workflow).

## Pulling Latest Submodule Changes

```bash
git submodule update --remote --merge
```

## Reset Local Data

```bash
docker compose down -v && docker compose up --build
```

## Tech Stack

- **Backend:** NestJS · MongoDB · Mongoose
- **Frontend:** React · Vite · MUI · Tailwind CSS
- **Infra:** Terraform · Render · Vercel · MongoDB Atlas
