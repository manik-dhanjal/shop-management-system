# Shop Management System

Manage inventory, orders, customers, and GST billing all in one place. Docker-powered setup gets you running in seconds.

## Quick Start

**Production:**

```bash
docker compose up --build
```

**Local development (hot reload):**

```bash
./compose.sh
```

That's it. The system initializes with a demo database and seed data.

## Services

| Service            | Production                 | Dev (hot reload)           |
| ------------------ | -------------------------- | -------------------------- |
| Frontend           | http://localhost:3000      | http://localhost:5173      |
| API                | http://localhost:3001      | http://localhost:3001      |
| API Docs (Swagger) | http://localhost:3001/docs | http://localhost:3001/docs |
| MongoDB            | localhost:27017            | localhost:27017            |

## Default Login

```
Email: admin@sms.com
Password: Admin@123
```

## Reset to Fresh Start

```bash
docker compose down -v && docker compose up --build
```

## Tech Stack

- **Backend:** NestJS · MongoDB · Mongoose
- **Frontend:** React · Vite · MUI · Tailwind CSS
