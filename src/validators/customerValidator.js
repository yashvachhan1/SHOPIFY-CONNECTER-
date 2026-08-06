const { body, validationResult, oneOf } = require('express-validator');
const { sendResponse } = require('../utils/response');

const validateCustomerSearch = [
  oneOf([
    body('email').isEmail().normalizeEmail(),
    body('phone').isString().trim().notEmpty()
  ], { message: 'Either email or phone is required to search for a customer.' }),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendResponse(res, 400, 'Validation Error', null, errors.array());
    next();
  }
];

module.exports = { validateCustomerSearch };
