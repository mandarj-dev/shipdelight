/**
 * ShipDelight LR Number Server
 * MongoDB-backed central store for LR numbers
 * Shared across all users — each LR is consumed (deleted) once printed
 *
 * Local:  node server.js  (listens on PORT)
 * Vercel: exported via api/index.js — lazy DB connect, no app.listen()
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
const IS_VERCEL = Boolean(process.env.VERCEL);

// ── MONGODB CONFIG ────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb://micky:E9VTPG3QqDM1@st-db.shipdelight.com:27017/';
const DB_NAME   = process.env.DB_NAME   || 'smart_tracking';

let lrPool;
let lrUsed;

// Reuse one client across warm serverless invocations (see MongoDB serverless guidance)
let mongoClient;
let connectPromise;
let indexesEnsured = false;

async function connectDB() {
  if (lrPool && lrUsed) return;

  if (!connectPromise) {
    connectPromise = (async () => {
      mongoClient = new MongoClient(MONGO_URI, {
        maxPoolSize: 5,
        minPoolSize: 0,
        maxIdleTimeMS: 20_000,
        connectTimeoutMS: 15_000,
        serverSelectionTimeoutMS: 15_000,
      });
      await mongoClient.connect();
      const db = mongoClient.db(DB_NAME);
      lrPool = db.collection('lr_pool');
      lrUsed = db.collection('lr_used');

      if (!indexesEnsured) {
        await lrPool.createIndex({ lr_number: 1 }, { unique: true });
        await lrUsed.createIndex({ lr_number: 1 }, { unique: true });
        await lrPool.createIndex({ seq: 1 });
        indexesEnsured = true;
      }

      console.log(`MongoDB connected: ${DB_NAME}`);
    })().catch(err => {
      connectPromise = null;
      throw err;
    });
  }

  await connectPromise;
}

// Ensure DB is ready before API handlers (required on Vercel cold starts)
async function dbMiddleware(req, res, next) {
  try {
    await connectDB();
    next();
  } catch (e) {
    console.error('MongoDB connection failed:', e.message);
    res.status(503).json({
      error: 'Database unavailable. Check MONGO_URI on Vercel and that MongoDB allows external connections.',
      detail: IS_VERCEL ? e.message : undefined,
    });
  }
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

// Vercel serves static files from public/ (see vercel.json installCommand)
if (!IS_VERCEL) {
  app.use(express.static(path.join(__dirname, '..', 'frontend')));
}

app.use('/api', dbMiddleware);

// ── ROUTES ────────────────────────────────────────────────────

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

    const docs  = await lrPool.find().sort({ seq: 1 }).limit(count).toArray();
    const batch = docs.map(d => d.lr_number);
    const ids   = docs.map(d => d._id);

    await lrPool.deleteMany({ _id: { $in: ids } });

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

app.post('/api/upload-csv', upload.single('csvfile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const results = await parseCSVBuffer(req.file.buffer);

    if (!results.length)
      return res.status(400).json({ error: 'No LR numbers found in CSV.' });

    const usedDocs = await lrUsed.find({}, { projection: { lr_number: 1 } }).toArray();
    const usedSet  = new Set(usedDocs.map(d => d.lr_number));

    const poolDocs = await lrPool.find({}, { projection: { lr_number: 1 } }).toArray();
    const poolSet  = new Set(poolDocs.map(d => d.lr_number));

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

app.get('/api/used', async (req, res) => {
  try {
    const docs = await lrUsed.find().sort({ used_at: -1 }).toArray();
    res.json({ used: docs.map(d => ({ lr_number: d.lr_number, used_at: d.used_at })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/reset', async (req, res) => {
  try {
    const result = await lrPool.deleteMany({});
    res.json({ message: `Pool cleared. ${result.deletedCount} LR(s) removed. Used history preserved.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Vercel serverless entry (api/index.js requires this export)
module.exports = app;

if (!IS_VERCEL && require.main === module) {
  connectDB()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`ShipDelight LR Server → http://localhost:${PORT}`);
        console.log(`   DB: ${DB_NAME}`);
      });
    })
    .catch(err => {
      console.error('Failed to connect to MongoDB:', err.message);
      process.exit(1);
    });
}
