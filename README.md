# Data Board

A TypeScript/Node.js backend service for data board management. Built with [Hono](https://hono.dev/), backed by **PostgreSQL**, and integrates with cloud storage providers (OneDrive, Google Drive, Dropbox), Kafka, Redis, and AWS S3.

## Features

- Board and board-item CRUD with flexible field schemas
- CRM board support
- Cloud storage sync: OneDrive, Google Drive, Dropbox
- Full-text search (PostgreSQL backed)
- File/folder management with S3 attachment storage
- Scheduler engine (cron-based job recovery)
- RDF/SPARQL ontology support via Oxigraph
- Kafka event streaming
- AI proxy integration

## Requirements

| Tool | Version |
|------|---------|
| Node.js | ≥ 20 |
| pnpm | ≥ 10 |
| PostgreSQL | ≥ 14 |
| Redis | ≥ 6 |

## Quick Start

### 1. Clone and install

```bash
git clone <repo-url>
cd data_board
pnpm install
```

### 2. Configure environment

```bash
cp .env.example src/.env
# Edit src/.env with your values
```

The minimum required variables for a local PostgreSQL setup:

```env
DB_TYPE=postgres
POSTGRES_URL=postgres://postgres:postgres@localhost:5432/data_board
REDIS_HOST=localhost
REDIS_PORT=6379
KAFKA_ENABLED=false
```

### 3. Run database migrations

```bash
pnpm db:migrate
```

### 4. Start the development server

```bash
pnpm dev
```

The API is available at `http://localhost:8081`.

## Database

PostgreSQL is the database backend (Drizzle ORM). Set `POSTGRES_URL` and the
service applies migrations from `src/db/drizzle/migrations/` on startup.

## Scripts

```bash
pnpm dev              # Development server with hot reload
pnpm build            # Compile TypeScript → dist/
pnpm start            # Run compiled build
pnpm test             # Run test suite (Vitest)
pnpm test:coverage    # Coverage report

# Database (PostgreSQL / Drizzle)
pnpm db:generate      # Generate a new migration from schema changes
pnpm db:migrate       # Apply pending migrations
pnpm db:push          # Push schema directly (dev only)
pnpm db:studio        # Open Drizzle Studio GUI
```

## Project Structure

```
src/
├── config/           # Environment config (single source of truth)
├── db/
│   └── drizzle/      # PostgreSQL schema + migrations
├── domain/
│   ├── repositories/ # Repository interfaces
│   └── shared/       # Shared types and error definitions
├── infrastructure/
│   ├── database/     # PostgreSQL adapter (Drizzle)
│   ├── redis/        # Redis client
│   ├── storage/      # AWS S3
│   ├── messaging/    # Kafka
│   ├── mail/         # SMTP mailer
│   └── logging/      # Winston logger
├── core/
│   ├── services/     # Business logic (boards, files, cloud sync, scheduler, AI…)
│   ├── interfaces/   # Service-level interfaces
│   └── utils/        # Shared utilities
└── presentation/
    ├── routers/      # Hono route definitions
    ├── controllers/  # Request handlers
    ├── middleware/   # Logging, error handling, DB context
    └── schemas/      # Zod validation schemas
```

## API Overview

Base path: `/api`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `*` | `/api/boards/*` | Board CRUD |
| `*` | `/api/v1/crmboards/*` | CRM board CRUD |
| `*` | `/api/files/*` | File management |
| `*` | `/api/folders/*` | Folder management |
| `*` | `/api/onedrive/*` | OneDrive auth & sync |
| `*` | `/api/google-drive/*` | Google Drive auth & sync |
| `*` | `/api/dropbox/*` | Dropbox auth & sync |
| `*` | `/api/search/*` | Full-text search |
| `*` | `/api/ontology/*` | RDF/SPARQL ontology |
| `*` | `/api/ai-proxy/*` | AI proxy |
| `GET` | `/v1/board/:id` | Legacy board endpoint |

A Postman collection is included at `data-board-apis.postman_collection.json`.

## Docker

```bash
# Build image
docker build -t data-board .

# Run with environment variables
docker run -p 8081:8081 --env-file src/.env data-board
```

The container exposes port **8081**.

## Environment Variables

See [`.env.example`](.env.example) for the full list with descriptions.

Key groups:

| Group | Variables |
|-------|-----------|
| App | `PORT`, `NODE_ENV`, `WEBAPP_URL` |
| Database | `POSTGRES_URL` |
| Redis | `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` |
| Kafka | `KAFKA_ENABLED`, `KAFKA_BROKERS`, … |
| AWS | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET` |
| OneDrive | `ONEDRIVE_CLIENT_ID`, `ONEDRIVE_CLIENT_SECRET`, `ONEDRIVE_TENANT_ID` |
| Google Drive | `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET` |
| Dropbox | `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` |
| SMTP | `SMTP_ADDRESS`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD` |

## Tech Stack

- **Runtime**: Node.js 20
- **Framework**: [Hono](https://hono.dev/)
- **Language**: TypeScript (SWC compiler)
- **PostgreSQL ORM**: [Drizzle](https://orm.drizzle.team/)
- **Validation**: [Zod](https://zod.dev/)
- **Cache**: Redis (ioredis)
- **Messaging**: Kafka (kafkajs)
- **Storage**: AWS S3
- **RDF/SPARQL**: [Oxigraph](https://github.com/oxigraph/oxigraph)
- **Testing**: [Vitest](https://vitest.dev/)
- **Package manager**: pnpm

## License

This project is dual-licensed:

- Files **without** `.ee.` in their path are covered by the Imbrace Sustainable Use License — see [LICENSE.md](LICENSE.md).
- Files **with** `.ee.` in their path are covered by the Imbrace Enterprise License — see [LICENSE_EE.md](LICENSE_EE.md).
