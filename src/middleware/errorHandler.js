const logger = require('../utils/logger');
const { sendResponse } = require('../utils/response');

const errorHandler = (err, req, res, next) => {
  logger.error(`${err.message} - ${req.originalUrl} - ${req.method} - ${req.ip}`, { stack: err.stack });

  const statusCode = err.status || 500;
  const message = err.message || 'Internal Server Error';

  sendResponse(res, statusCode, message, null, process.env.NODE_ENV === 'development' ? err.stack : 'SERVER_ERROR');
};

module.exports = errorHandler;
