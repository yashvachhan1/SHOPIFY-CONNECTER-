const axios = require('axios');
const { shopifyStore, shopifyAdminToken } = require('../config/env');
const logger = require('../utils/logger');

const shopifyApi = axios.create({
  baseURL: `https://${shopifyStore}/admin/api/2024-01/graphql.json`,
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': shopifyAdminToken
  }
});

const queryShopify = async (query, variables = {}) => {
  try {
    const response = await shopifyApi.post('', { query, variables });
    if (response.data.errors) {
      logger.error('Shopify GraphQL Errors:', response.data.errors);
      throw new Error('Shopify API Error: ' + response.data.errors.map(e => e.message).join(', '));
    }
    return response.data.data;
  } catch (error) {
    logger.error('Shopify Request Failed', { error: error.message, stack: error.stack });
    throw error;
  }
};

module.exports = { queryShopify };
