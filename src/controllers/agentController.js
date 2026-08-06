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

      req.body = {
        customer: {
          first_name: data.customer_first_name || 'AI Customer',
          last_name: data.customer_last_name || '',
          email: data.customer_email || 'ai@example.com',
          phone: phone
        },
        shipping_address: {
          address1: data.customer_full_address || data.shipping_address1 || '123 Main St',
          city: data.shipping_city || 'City',
          province: data.shipping_province || 'State',
          country: data.shipping_country || 'Country',
          zip: data.shipping_zip || '00000'
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
