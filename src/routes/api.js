const express = require('express');
const router = express.Router();

const { validateSearch, validateProduct } = require('../validators/productValidator');
const { validateCreateOrder, validateOrderStatus } = require('../validators/orderValidator');
const { validateCustomerSearch } = require('../validators/customerValidator');

const { searchProducts, getProduct } = require('../controllers/productController');
const { createOrder, getOrderStatus } = require('../controllers/orderController');
const { getCustomer } = require('../controllers/customerController');
const { getStoreInfo } = require('../controllers/storeController');
const { handleAction } = require('../controllers/agentController');

router.post('/search-products', validateSearch, searchProducts);
router.post('/product', validateProduct, getProduct);
router.post('/create-order', validateCreateOrder, createOrder);
router.post('/order-status', validateOrderStatus, getOrderStatus);
router.post('/customer', validateCustomerSearch, getCustomer);
router.post('/store-info', getStoreInfo);
router.post('/agent', handleAction);

module.exports = router;
