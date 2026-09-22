const { searchProducts, getProduct } = require('./productController');
const { queryShopify } = require('../services/shopifyService');
const { createOrder, getOrderStatus } = require('./orderController');
const { getCustomer } = require('./customerController');
const { getStoreInfo } = require('./storeController');
const { sendResponse } = require('../utils/response');

const handleAction = async (req, res, next) => {
  try {
    const data = req.body;
    const { action } = data;
    
    if (!action) {
      return sendResponse(res, 400, 'Validation Error: action is required');
    }

    // Reconstruct nested structures if the action is create_order
    if (action === 'create_order') {
      let finalVariantId = data.variant_id;
      
      // If variant_id is not provided but a query/product name is, fetch the variant ID
      if (!finalVariantId && data.query) {
        const graphqlQuery = `
          query SearchProducts($query: String!) {
            products(first: 1, query: $query) {
              edges { node { variants(first: 1) { edges { node { id } } } } }
            }
          }
        `;
        const searchData = await queryShopify(graphqlQuery, { query: data.query });
        const firstProduct = searchData?.products?.edges[0]?.node;
        if (firstProduct) {
          finalVariantId = firstProduct.variants.edges[0]?.node?.id;
        }
      }

      let phone = data.customer_phone || '';
      if (phone && !phone.startsWith('+')) {
        const digits = phone.replace(/\D/g, '');
        if (digits.length === 10) {
          phone = '+91' + digits;
        } else if (digits.length > 10) {
          phone = '+' + digits;
        }
      }

      // Never fall back to placeholder contact/address data ('ai@example.com', '123 Main St', etc.) -
      // a fake email merges unrelated customers into one record, and a fake address silently ships
      // the order nowhere useful. If anything required is missing, ask the agent to collect it
      // instead of creating a broken order.
      const missing = [];
      if (!data.customer_first_name) missing.push('customer_first_name');
      if (!data.customer_email) missing.push('customer_email');
      if (!(data.customer_full_address || data.shipping_address1)) missing.push('customer_full_address');
      if (!data.shipping_city) missing.push('shipping_city');
      if (!data.shipping_province) missing.push('shipping_province');
      if (!data.shipping_country) missing.push('shipping_country');
      if (!data.shipping_zip) missing.push('shipping_zip');
      if (!finalVariantId) missing.push('query (product name) or variant_id');

      if (missing.length > 0) {
        return sendResponse(
          res,
          200,
          `ERROR: Missing required info to place the order: ${missing.join(', ')}. DO NOT tell the user there is a technical error. Politely ask the customer for this information, then call this tool again with action="create_order" including it.`,
        );
      }

      req.body = {
        customer: {
          first_name: data.customer_first_name,
          last_name: data.customer_last_name || '',
          email: data.customer_email,
          phone: phone
        },
        shipping_address: {
          address1: data.customer_full_address || data.shipping_address1,
          city: data.shipping_city,
          province: data.shipping_province,
          country: data.shipping_country,
          zip: data.shipping_zip
        },
        items: [
          {
            variant_id: finalVariantId,
            quantity: data.quantity ? Number(data.quantity) : 1
          }
        ],
        payment_method: data.payment_method || 'COD'
      };
    } else {
      req.body = data;
    }

    switch (action) {
      case 'search_products':
        return await searchProducts(req, res, next);
      case 'get_product_details':
        return await getProduct(req, res, next);
      case 'create_order':
        return await createOrder(req, res, next);
      case 'check_order_status':
        return await getOrderStatus(req, res, next);
      case 'get_customer':
        return await getCustomer(req, res, next);
      case 'get_store_info':
        return await getStoreInfo(req, res, next);
      default:
        return sendResponse(res, 400, `Unknown action: ${action}`);
    }
  } catch (error) {
    next(error);
  }
};

module.exports = { handleAction };
