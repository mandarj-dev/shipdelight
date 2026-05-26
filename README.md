# ShipDelight LR Print Manager

Central server-based LR number management.
Multiple users share the same LR pool — each number is used once and deleted permanently.

---

## Project Structure

```
shipdelight/
├── backend/
│   ├── server.js          ← Node.js Express API server
│   └── package.json
├── frontend/
│   └── index.html         ← User-facing print UI (served by the backend)
├── data/
│   ├── lr_numbers.json    ← Available LR pool (auto-created)
│   └── used_lr_numbers.json ← Permanent log of used LRs (auto-created)
└── README.md
```

---

## Setup & Deploy

### 1. Install Node.js
Download from https://nodejs.org (v18 or newer)

### 2. Install dependencies
```bash
cd shipdelight/backend
npm install
```

### 3. Start the server
```bash
node server.js
```
Server runs on **http://localhost:3000**

To run on a custom port:
```bash
PORT=8080 node server.js
```

### 4. Open in browser
All users open: **http://your-server-ip:3000**

---

## Loading LR Numbers (Admin)

You only need to do this once per series (or when the pool runs out).

### Option A — via the Web UI
1. Open the app in browser
2. Click **"Admin — Upload New LR Series"**
3. Upload your `lr_number_series.csv`
4. Already-used LRs are automatically excluded

### Option B — via API (curl)
```bash
curl -X POST http://localhost:3000/api/upload-csv \
  -F "csvfile=@/path/to/lr_number_series.csv"
```

### CSV Format
```
lr_number
SD10001
SD10002
SD10003
...
```

---

## How It Works

| Action | What happens |
|--------|-------------|
| User opens app | Fetches live count from server |
| User clicks Print | Server atomically reserves N LR numbers, removes them from pool, records them as used |
| App restarts / server restarts | LR pool reads from `data/lr_numbers.json` — nothing lost |
| Same CSV uploaded again | Already-used LRs are auto-filtered out |
| Multiple users print simultaneously | Each gets unique LR numbers (server handles concurrency) |

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Pool size, used count, next 5 preview |
| POST | `/api/checkout` | Body: `{"count": N}` — Reserve & delete N LRs |
| POST | `/api/upload-csv` | Multipart: Upload new CSV series |
| GET | `/api/used` | List all used LR numbers |
| DELETE | `/api/reset` | Clear available pool (used log preserved) |

---

## Production Deployment (PM2)

Keep the server running permanently with PM2:

```bash
npm install -g pm2
cd shipdelight/backend
pm2 start server.js --name shipdelight-lr
pm2 save
pm2 startup     # auto-start on reboot
```

---

## Data Files

- `data/lr_numbers.json` — Current available pool. Safe to back up.
- `data/used_lr_numbers.json` — Permanent log. **Never delete this.**

Both files are created automatically on first run.
