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
const DATA_DIR  = path.join(__dirname, '..', 'data');
const LR_FILE   = path.join(DATA_DIR, 'lr_numbers.json');
const USED_FILE = path.join(DATA_DIR, 'used_lr_numbers.json');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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
const upload = multer({
  dest: path.join(DATA_DIR, 'uploads_tmp'),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) cb(null, true);
    else cb(new Error('Only .csv files allowed'));
  }
});

// ── MIDDLEWARE ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve frontend from /frontend folder
app.use(express.static(path.join(__dirname, '..', 'frontend')));

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
 * Existing available pool is REPLACED (used history kept)
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

      const fresh    = results.filter(lr => !usedNums.has(lr));
      const skipped  = results.length - fresh.length;

      writeLR(fresh);

      console.log(`[${new Date().toISOString()}] CSV uploaded: ${results.length} total, ${fresh.length} fresh, ${skipped} already-used skipped`);

      res.json({
        message:  `Loaded ${fresh.length} LR number(s).${skipped > 0 ? ` ${skipped} already-used skipped.` : ''}`,
        loaded:   fresh.length,
        skipped,
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

// ── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ShipDelight LR Server running on http://localhost:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`LR pool file:   ${LR_FILE}`);
  console.log(`Used log file:  ${USED_FILE}`);
});
