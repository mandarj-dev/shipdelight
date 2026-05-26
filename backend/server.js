/**
 * ShipDelight LR Number Server
 * Central store for LR numbers — shared across all users
 * LR numbers are consumed (deleted) once printed
 */

const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const csv        = require('csv-parser');
const multer     = require('multer');
const cors       = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── PATHS ────────────────────────────────────────────────────
// Vercel: only /tmp is writable. Local: use repo data/ folder.
const SOURCE_DATA = path.join(__dirname, '..', 'data');
const DATA_DIR    = process.env.VERCEL
  ? path.join('/tmp', 'shipdelight-data')
  : SOURCE_DATA;
const LR_FILE     = path.join(DATA_DIR, 'lr_numbers.json');
const USED_FILE   = path.join(DATA_DIR, 'used_lr_numbers.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!process.env.VERCEL) return;
  for (const name of ['lr_numbers.json', 'used_lr_numbers.json']) {
    const dest = path.join(DATA_DIR, name);
    const src  = path.join(SOURCE_DATA, name);
    if (!fs.existsSync(dest) && fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }
}
ensureDataDir();

// ── HELPERS ──────────────────────────────────────────────────
function readLR() {
  try {
    if (fs.existsSync(LR_FILE)) {
      const data = JSON.parse(fs.readFileSync(LR_FILE, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch(e) { console.error('readLR error:', e.message); }
  return [];
}

function writeLR(arr) {
  fs.writeFileSync(LR_FILE, JSON.stringify(arr, null, 2));
}

function readUsed() {
  try {
    if (fs.existsSync(USED_FILE)) {
      const data = JSON.parse(fs.readFileSync(USED_FILE, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch(e) {}
  return [];
}

function appendUsed(nums) {
  const existing = readUsed();
  const merged   = [...new Set([...existing, ...nums])];
  fs.writeFileSync(USED_FILE, JSON.stringify(merged, null, 2));
}

// ── MULTER (CSV upload) ──────────────────────────────────────
const UPLOAD_TMP = path.join(process.env.VERCEL ? '/tmp' : DATA_DIR, 'uploads_tmp');
if (!fs.existsSync(UPLOAD_TMP)) fs.mkdirSync(UPLOAD_TMP, { recursive: true });

const upload = multer({
  dest: UPLOAD_TMP,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) cb(null, true);
    else cb(new Error('Only .csv files allowed'));
  }
});

// ── MIDDLEWARE ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Local dev: serve frontend. On Vercel, static files live in public/ (see vercel.json).
if (!process.env.VERCEL) {
  app.use(express.static(path.join(__dirname, '..', 'frontend')));
}

// ── ROUTES ───────────────────────────────────────────────────

/**
 * GET /api/status
 * Returns count of available and used LR numbers
 */
app.get('/api/status', (req, res) => {
  const available = readLR();
  const used      = readUsed();
  res.json({
    available: available.length,
    used:      used.length,
    total:     available.length + used.length,
    next:      available.slice(0, 5)   // preview of next 5
  });
});

/**
 * POST /api/checkout
 * Body: { count: number }
 * Atomically reserves `count` LR numbers, marks them used, returns them
 */
app.post('/api/checkout', (req, res) => {
  const count = parseInt(req.body.count);
  if (!count || count < 1 || count > 50) {
    return res.status(400).json({ error: 'count must be 1–50' });
  }

  const available = readLR();
  if (available.length === 0) {
    return res.status(409).json({ error: 'No LR numbers available. Please upload a new series.' });
  }
  if (count > available.length) {
    return res.status(409).json({
      error: `Only ${available.length} LR number(s) remaining.`,
      available: available.length
    });
  }

  // Take from front
  const batch    = available.splice(0, count);
  const remaining = available;

  // Write updated pool first (atomic-ish — write remaining back)
  writeLR(remaining);
  // Then record as used
  appendUsed(batch);

  console.log(`[${new Date().toISOString()}] Checked out ${batch.length} LR(s): ${batch.join(', ')} | Remaining: ${remaining.length}`);

  res.json({
    lr_numbers: batch,
    remaining:  remaining.length
  });
});

/**
 * POST /api/upload-csv
 * Admin: Upload a new CSV of LR numbers
 * New LRs are APPENDED to the existing pool (duplicates & used ones excluded)
 */
app.post('/api/upload-csv', upload.single('csvfile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const results  = [];
  const tmpPath  = req.file.path;
  const usedNums = new Set(readUsed());

  fs.createReadStream(tmpPath)
    .pipe(csv())
    .on('data', (row) => {
      // Support column named lr_number or first column
      const val = row['lr_number'] || row[Object.keys(row)[0]];
      if (val && val.trim()) results.push(val.trim());
    })
    .on('end', () => {
      fs.unlinkSync(tmpPath); // clean up tmp

      // Filter out already-used LRs
      const fresh   = results.filter(lr => !usedNums.has(lr));
      const skipped = results.length - fresh.length;

      // APPEND to existing pool (deduplicate to avoid double entries)
      const existing  = readLR();
      const existSet  = new Set(existing);
      const newOnly   = fresh.filter(lr => !existSet.has(lr));
      const duplicate = fresh.length - newOnly.length;
      const merged    = [...existing, ...newOnly];

      writeLR(merged);

      console.log(`[${new Date().toISOString()}] CSV uploaded: ${results.length} total, ${newOnly.length} appended, ${skipped} already-used skipped, ${duplicate} duplicates ignored | Pool now: ${merged.length}`);

      res.json({
        message:  `Appended ${newOnly.length} new LR number(s). Pool total: ${merged.length}.${skipped > 0 ? ` ${skipped} already-used excluded.` : ''}${duplicate > 0 ? ` ${duplicate} duplicates ignored.` : ''}`,
        appended:  newOnly.length,
        pool_total: merged.length,
        skipped,
        duplicate,
        total:    results.length
      });
    })
    .on('error', (err) => {
      res.status(500).json({ error: 'CSV parse error: ' + err.message });
    });
});

/**
 * GET /api/used
 * Admin: List all used LR numbers
 */
app.get('/api/used', (req, res) => {
  res.json({ used: readUsed() });
});

/**
 * DELETE /api/reset
 * Admin: Clear available pool (used history preserved)
 */
app.delete('/api/reset', (req, res) => {
  writeLR([]);
  res.json({ message: 'Available pool cleared. Used history preserved.' });
});

app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ── EXPORT (Vercel) / START (local only) ─────────────────────
module.exports = app;

if (!process.env.VERCEL && require.main === module) {
  app.listen(PORT, () => {
    console.log(`ShipDelight LR Server running on http://localhost:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
    console.log(`LR pool file:   ${LR_FILE}`);
    console.log(`Used log file:  ${USED_FILE}`);
  });
}
