/**
 * ShipDelight LR Number Server
 * MongoDB-backed central store for LR numbers
 * Shared across all users — each LR is consumed (deleted) once printed
 */

const express  = require('express');
const path     = require('path');
const csv      = require('csv-parser');
const multer   = require('multer');
const cors     = require('cors');
const { MongoClient } = require('mongodb');
const { Readable } = require('stream');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MONGODB CONFIG ────────────────────────────────────────────
// Set MONGO_URI in your environment, or edit the default below.
// Examples:
//   Local:   mongodb://localhost:27017
//   Atlas:   mongodb+srv://user:pass@cluster.mongodb.net
const MONGO_URI = process.env.MONGO_URI || 'mongodb://micky:E9VTPG3QqDM1@st-db.shipdelight.com:27017/';
const DB_NAME   = process.env.DB_NAME   || 'smart_tracking';

let db;
let lrPool;   // collection: lr_pool   — available LR numbers
let lrUsed;   // collection: lr_used   — permanently used LR numbers

// ── CONNECT TO MONGODB ────────────────────────────────────────
async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db     = client.db(DB_NAME);
  lrPool = db.collection('lr_pool');
  lrUsed = db.collection('lr_used');

  // Unique index on lr_number for both collections
  await lrPool.createIndex({ lr_number: 1 }, { unique: true });
  await lrUsed.createIndex({ lr_number: 1 }, { unique: true });
  // Index for insertion order (sequential checkout)
  await lrPool.createIndex({ seq: 1 });

  console.log(`✅ MongoDB connected: ${MONGO_URI} / ${DB_NAME}`);
}

// ── MULTER (CSV upload — memory storage, no temp files) ───────
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv'))
      cb(null, true);
    else
      cb(new Error('Only .csv files are allowed'));
  }
});

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── ROUTES ────────────────────────────────────────────────────

/**
 * GET /api/status
 * Live count of available / used LR numbers + next 5 preview
 */
app.get('/api/status', async (req, res) => {
  try {
    const available = await lrPool.countDocuments();
    const used      = await lrUsed.countDocuments();
    const nextDocs  = await lrPool.find().sort({ seq: 1 }).limit(5).toArray();
    const next      = nextDocs.map(d => d.lr_number);

    res.json({ available, used, total: available + used, next });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error: ' + e.message });
  }
});

/**
 * POST /api/checkout
 * Body: { count: number }
 * Atomically reserves N LR numbers, moves them to lr_used, returns them
 */
app.post('/api/checkout', async (req, res) => {
  const count = parseInt(req.body.count);
  if (!count || count < 1 || count > 50)
    return res.status(400).json({ error: 'count must be between 1 and 50' });

  try {
    const available = await lrPool.countDocuments();
    if (available === 0)
      return res.status(409).json({ error: 'No LR numbers available. Please upload a new series.' });
    if (count > available)
      return res.status(409).json({
        error: `Only ${available} LR number(s) remaining.`,
        available
      });

    // Fetch the next N by insertion order
    const docs  = await lrPool.find().sort({ seq: 1 }).limit(count).toArray();
    const batch = docs.map(d => d.lr_number);
    const ids   = docs.map(d => d._id);

    // Remove from pool
    await lrPool.deleteMany({ _id: { $in: ids } });

    // Record as used (ignore duplicates — $set upsert)
    const usedOps = batch.map(lr => ({
      updateOne: {
        filter: { lr_number: lr },
        update: { $set: { lr_number: lr, used_at: new Date() } },
        upsert: true
      }
    }));
    await lrUsed.bulkWrite(usedOps);

    const remaining = await lrPool.countDocuments();
    console.log(`[${new Date().toISOString()}] Checked out ${batch.length} LR(s): ${batch.join(', ')} | Remaining: ${remaining}`);

    res.json({ lr_numbers: batch, remaining });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error: ' + e.message });
  }
});

/**
 * POST /api/upload-csv
 * Admin: Upload a CSV of LR numbers
 * New LRs APPENDED — already-used & duplicates automatically excluded
 */
app.post('/api/upload-csv', upload.single('csvfile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    // Parse CSV from memory buffer
    const results = await parseCSVBuffer(req.file.buffer);

    if (!results.length)
      return res.status(400).json({ error: 'No LR numbers found in CSV.' });

    // Fetch all already-used LR numbers
    const usedDocs = await lrUsed.find({}, { projection: { lr_number: 1 } }).toArray();
    const usedSet  = new Set(usedDocs.map(d => d.lr_number));

    // Fetch all already-in-pool LR numbers
    const poolDocs = await lrPool.find({}, { projection: { lr_number: 1 } }).toArray();
    const poolSet  = new Set(poolDocs.map(d => d.lr_number));

    // Determine the next sequence number
    const maxSeqDoc = await lrPool.find().sort({ seq: -1 }).limit(1).toArray();
    let   seq       = maxSeqDoc.length ? maxSeqDoc[0].seq + 1 : 1;

    const skipped   = results.filter(lr => usedSet.has(lr)).length;
    const duplicate = results.filter(lr => !usedSet.has(lr) && poolSet.has(lr)).length;
    const newOnly   = results.filter(lr => !usedSet.has(lr) && !poolSet.has(lr));

    if (newOnly.length > 0) {
      const docs = newOnly.map(lr => ({ lr_number: lr, seq: seq++, added_at: new Date() }));
      await lrPool.insertMany(docs, { ordered: false });
    }

    const poolTotal = await lrPool.countDocuments();
    console.log(`[${new Date().toISOString()}] CSV uploaded: ${results.length} total, ${newOnly.length} appended, ${skipped} already-used skipped, ${duplicate} duplicates ignored | Pool now: ${poolTotal}`);

    res.json({
      message:    `Appended ${newOnly.length} new LR number(s). Pool total: ${poolTotal}.`
                + (skipped   > 0 ? ` ${skipped} already-used excluded.`  : '')
                + (duplicate > 0 ? ` ${duplicate} duplicates ignored.`   : ''),
      appended:   newOnly.length,
      pool_total: poolTotal,
      skipped,
      duplicate,
      total:      results.length
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

/**
 * GET /api/used
 * Admin: List all used LR numbers with timestamps
 */
app.get('/api/used', async (req, res) => {
  try {
    const docs = await lrUsed.find().sort({ used_at: -1 }).toArray();
    res.json({ used: docs.map(d => ({ lr_number: d.lr_number, used_at: d.used_at })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/reset
 * Admin: Clear available pool only (used history preserved)
 */
app.delete('/api/reset', async (req, res) => {
  try {
    const result = await lrPool.deleteMany({});
    res.json({ message: `Pool cleared. ${result.deletedCount} LR(s) removed. Used history preserved.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CSV PARSER (from buffer) ──────────────────────────────────
function parseCSVBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const results = [];
    const stream  = Readable.from(buffer.toString('utf8'));
    stream
      .pipe(csv())
      .on('data', (row) => {
        const val = row['lr_number'] || row[Object.keys(row)[0]];
        if (val && val.trim()) results.push(val.trim());
      })
      .on('end',   () => resolve(results))
      .on('error', reject);
  });
}

// ── START ─────────────────────────────────────────────────────
connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚚 ShipDelight LR Server → http://localhost:${PORT}`);
      console.log(`   MongoDB: ${MONGO_URI} / DB: ${DB_NAME}`);
      console.log(`   Collections: lr_pool (available) | lr_used (permanent log)`);
    });
  })
  .catch(err => {
    console.error('❌ Failed to connect to MongoDB:', err.message);
    console.error('   Set MONGO_URI environment variable and retry.');
    process.exit(1);
  });
