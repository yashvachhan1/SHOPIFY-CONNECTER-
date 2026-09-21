const { apiSecret, smallestApiKey } = require('../config/env');
const { sendResponse } = require('../utils/response');

const authenticate = (req, res, next) => {
  let token;
  const authHeader = req.headers.authorization;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return sendResponse(res, 401, 'Unauthorized: Missing or invalid token format', null, 'UNAUTHORIZED');
  }
  
  // Allow access if the token matches either the general API secret or the Smallest AI API key
  if (token !== apiSecret && token !== smallestApiKey) {
    return sendResponse(res, 403, 'Forbidden: Invalid token', null, 'FORBIDDEN');
  }

  next();
};

module.exports = authenticate;
