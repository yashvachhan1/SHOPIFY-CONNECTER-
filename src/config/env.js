require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  shopifyStore: process.env.SHOPIFY_STORE,
  shopifyAdminToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
  apiSecret: process.env.API_SECRET,
  groqApiKey: process.env.GROQ_API_KEY,
  nodeEnv: process.env.NODE_ENV || 'development'
};
