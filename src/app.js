const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');


const authMiddleware = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');

const apiRoutes = require('./routes/api');
const docsRoute = require('./routes/docs');

const path = require('path');

const app = express();

// Trust proxy for Render/Heroku load balancers (Fixes 429 Too Many Requests)
app.set('trust proxy', 1);

// Serve static files for the test UI
app.use(express.static(path.join(__dirname, '../public')));

// Security Middleware (adjusted for static assets)
app.use(helmet({
  contentSecurityPolicy: false // Disable CSP for the test UI to allow inline styles/scripts if needed
}));
app.use(cors());

// Rate Limiting (100 requests per 15 minutes)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.',
    data: null,
    error: 'TOO_MANY_REQUESTS'
  }
});
app.use('/api/', limiter);

// Body Parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Custom Request Logger
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`);
  next();
});

// Swagger Docs Route (Public)
app.use('/api/docs', docsRoute);

// API Routes (Protected)
app.use('/api', authMiddleware, apiRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
    data: null,
    error: 'NOT_FOUND'
  });
});

// Global Error Handler
app.use(errorHandler);

module.exports = app;
