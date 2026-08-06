const { queryShopify } = require('../services/shopifyService');
const { sendResponse } = require('../utils/response');

const getStoreInfo = async (req, res, next) => {
  try {
    const graphqlQuery = `
      query {
        shop {
          name
          currencyCode
          primaryDomain {
            url
          }
          contactEmail
          billingAddress {
            city
            country
          }
        }
      }
    `;

    const data = await queryShopify(graphqlQuery);
    sendResponse(res, 200, 'Store info retrieved', data.shop);
  } catch (error) {
    next(error);
  }
};

module.exports = { getStoreInfo };
