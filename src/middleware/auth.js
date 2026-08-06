const { apiSecret } = require('../config/env');
const { sendResponse } = require('../utils/response');

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return sendResponse(res, 401, 'Unauthorized: Missing or invalid token format', null, 'UNAUTHORIZED');
  }

  const token = authHeader.split(' ')[1];
  if (token !== apiSecret) {
    return sendResponse(res, 403, 'Forbidden: Invalid token', null, 'FORBIDDEN');
  }

  next();
};

module.exports = authenticate;
