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
const { handleSmallestWebhook, streamTTS } = require('../controllers/smallestController');
const { handleChat } = require('../controllers/chatController');
const authenticate = require('../middleware/auth');

router.post('/search-products', authenticate, validateSearch, searchProducts);
router.post('/product', authenticate, validateProduct, getProduct);
router.post('/create-order', authenticate, validateCreateOrder, createOrder);
router.post('/order-status', authenticate, validateOrderStatus, getOrderStatus);
router.post('/customer', authenticate, validateCustomerSearch, getCustomer);
router.post('/store-info', authenticate, getStoreInfo);
router.post('/agent', authenticate, handleAction);
router.post('/smallest', handleSmallestWebhook);
router.post('/chat', authenticate, handleChat);
router.get('/tts', streamTTS);

module.exports = router;
