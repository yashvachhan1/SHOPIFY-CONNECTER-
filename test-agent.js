const axios = require('axios');

(async () => {
  try {
    const res = await axios.post('http://localhost:3000/api/agent', {
      action: 'search_products',
      query: ''
    });
    console.log(JSON.stringify(res.data, null, 2));
  } catch (e) {
    console.error(e.message);
  }
})();
