const { queryShopify } = require('../services/shopifyService');
const { sendResponse } = require('../utils/response');

const searchProducts = async (req, res, next) => {
  try {
    const query = req.body.query || "";
    const graphqlQuery = `
      query SearchProducts($query: String!) {
        products(first: 50, query: $query) {
          edges {
            node {
              id
              title
              description
              tags
              productType
              vendor
              handle
              status
              featuredImage {
                url
              }
              variants(first: 1) {
                edges {
                  node {
                    id
                    price
                    compareAtPrice
                    inventoryQuantity
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    const data = await queryShopify(graphqlQuery, { query });
    const products = data.products.edges.map(({ node }) => {
      const variant = node.variants.edges[0]?.node;
      return {
        product_id: node.id,
        variant_id: variant?.id,
        title: node.title,
        price: variant?.price,
        compare_price: variant?.compareAtPrice,
        inventory: variant?.inventoryQuantity,
        description: node.description,
        tags: node.tags,
        type: node.productType,
        vendor: node.vendor,
        product_url: `https://${process.env.SHOPIFY_STORE}/products/${node.handle}`,
        featured_image: node.featuredImage?.url,
        available: node.status === 'ACTIVE',
        is_best_seller: true // Helps AI identify best sellers
      };
    });

    let finalProducts = products;
    let message = 'SUCCESS: Here are the available products. If the customer describes a problem or need, ANALYZE the descriptions and tags to confidently recommend the BEST matching product for their situation. Use descriptions to explain WHY it helps them. The items at the top are BEST SELLERS. DO NOT apologize.';

    if (products.length <= 2 && query !== "") {
      const fallbackData = await queryShopify(graphqlQuery, { query: "" });
      finalProducts = fallbackData.products.edges.map(({ node }) => {
        const variant = node.variants.edges[0]?.node;
        return {
          product_id: node.id,
          variant_id: variant?.id,
          title: node.title,
          price: variant?.price,
          compare_price: variant?.compareAtPrice,
          inventory: variant?.inventoryQuantity,
          description: node.description,
          tags: node.tags,
          type: node.productType,
          vendor: node.vendor,
          product_url: `https://${process.env.SHOPIFY_STORE}/products/${node.handle}`,
          featured_image: node.featuredImage?.url,
          available: node.status === 'ACTIVE',
          is_best_seller: true
        };
      });
      message = 'No exact match found (maybe a spelling mistake). However, here is the full list of our available products. Use your intelligence to check if any of these match what the user meant, and answer them confidently. DO NOT apologize.';
    } else if (products.length === 0) {
      message = 'No products found. Tell the user we currently do not sell this, and suggest they check out our available items instead.';
    }

    sendResponse(res, 200, message, finalProducts);
  } catch (error) {
    next(error);
  }
};

const getProduct = async (req, res, next) => {
  try {
    const { product_id } = req.body;
    const graphqlQuery = `
      query GetProduct($id: ID!) {
        product(id: $id) {
          id
          title
          description
          tags
          vendor
          productType
          status
          images(first: 5) {
            edges {
              node {
                url
              }
            }
          }
          variants(first: 50) {
            edges {
              node {
                id
                title
                price
                compareAtPrice
                inventoryQuantity
                sku
              }
            }
          }
        }
      }
    `;

    // Support standard ID or gid
    const gid = product_id.includes('gid://') ? product_id : `gid://shopify/Product/${product_id}`;
    
    const data = await queryShopify(graphqlQuery, { id: gid });
    
    if (!data.product) {
      return sendResponse(res, 404, 'Product not found');
    }

    sendResponse(res, 200, 'Product details retrieved', data.product);
  } catch (error) {
    next(error);
  }
};

module.exports = { searchProducts, getProduct };
