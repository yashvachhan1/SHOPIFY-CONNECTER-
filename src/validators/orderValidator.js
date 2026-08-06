const { body, validationResult } = require('express-validator');
const { sendResponse } = require('../utils/response');

const validateCreateOrder = [
  body('customer.first_name').isString().trim().notEmpty(),
  body('customer.last_name').isString().trim().notEmpty(),
  body('customer.email').isEmail().normalizeEmail(),
  body('customer.phone').optional().isString().trim(),
  body('shipping_address.address1').isString().trim().notEmpty(),
  body('shipping_address.city').isString().trim().notEmpty(),
  body('shipping_address.province').isString().trim().notEmpty(),
  body('shipping_address.country').isString().trim().notEmpty(),
  body('shipping_address.zip').isString().trim().notEmpty(),
  body('items').isArray({ min: 1 }).withMessage('Items must be an array with at least one item.'),
  body('items.*.variant_id').isString().trim().notEmpty(),
  body('items.*.quantity').isInt({ min: 1 }),
  body('payment_method').optional().isString().trim(),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendResponse(res, 400, 'Validation Error', null, errors.array());
    next();
  }
];

const validateOrderStatus = [
  body('order_number').isString().trim().notEmpty().withMessage('Order number is required.'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendResponse(res, 400, 'Validation Error', null, errors.array());
    next();
  }
];

module.exports = { validateCreateOrder, validateOrderStatus };
