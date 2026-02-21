const express = require('express');
const { helloRouter } = require('./routes');

const app = express();

app.use(express.json());

// Public routes — no auth middleware applied
app.use('/api', helloRouter);

// 404 catch-all — must come AFTER all routes
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// General error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
