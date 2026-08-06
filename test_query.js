require('dotenv').config();
const { queryShopify } = require('./src/services/shopifyService.js');
queryShopify('query { products(first: 50, query: "All-in-One Multivitamin and Mineral") { edges { node { id title } } } }').then(data => console.log(JSON.stringify(data, null, 2)));
