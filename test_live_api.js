const axios = require('axios');
axios.post('https://shopify-connecter.onrender.com/api/agent', {
  action: 'search_products',
  query: ''
}, {
  headers: {
    'Authorization': 'Bearer super_secret_elevenlabs_token_123',
    'Content-Type': 'application/json'
  }
}).then(res => console.log(res.data)).catch(err => console.error(err.response ? err.response.data : err.message));
