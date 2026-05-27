/**
 * Vercel serverless entry — routes all traffic to the Express app.
 * Dependencies must be in the repo root package.json (Vercel only runs npm install there).
 */
let app;
try {
  app = require('../backend/server');
} catch (err) {
  console.error('Failed to load Express app:', err);
  app = (req, res) => {
    res.status(500).json({
      error: 'Server failed to start',
      message: err.message,
      hint: err.code === 'MODULE_NOT_FOUND'
        ? 'Run npm install at the project root and ensure mongodb is in package.json'
        : undefined,
    });
  };
}

module.exports = app;
