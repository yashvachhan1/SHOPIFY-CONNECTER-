const { queryShopify } = require('../services/shopifyService');
const { sendResponse } = require('../utils/response');

const getCustomer = async (req, res, next) => {
  try {
    const { email, phone } = req.body;
    
    let queryStr = '';
    if (email) queryStr += `email:${email} `;
    if (phone) queryStr += `phone:${phone}`;
    
    const graphqlQuery = `
      query SearchCustomers($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
              firstName
              lastName
              email
              phone
              addresses {
                address1
                city
                province
                country
                zip
              }
            }
          }
        }
      }
    `;

    const data = await queryShopify(graphqlQuery, { query: queryStr.trim() });
    
    const customer = data.customers.edges[0]?.node;
    if (!customer) {
      return sendResponse(res, 404, 'Customer not found');
    }

    sendResponse(res, 200, 'Customer profile retrieved', customer);
  } catch (error) {
    next(error);
  }
};

module.exports = { getCustomer };
