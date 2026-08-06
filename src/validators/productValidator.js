const { body, validationResult } = require('express-validator');
const { sendResponse } = require('../utils/response');

const validateSearch = [
  body('query').isString().trim().notEmpty().withMessage('Query is required and must be a string.'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendResponse(res, 400, 'Validation Error', null, errors.array());
    next();
  }
];

const validateProduct = [
  body('product_id').isString().trim().notEmpty().withMessage('Product ID is required.'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendResponse(res, 400, 'Validation Error', null, errors.array());
    next();
  }
];

module.exports = { validateSearch, validateProduct };
