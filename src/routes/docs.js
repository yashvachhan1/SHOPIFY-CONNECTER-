const express = require('express');
const swaggerUi = require('swagger-ui-express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
let swaggerDocument;
try {
  const swaggerPath = path.join(__dirname, '../../swagger.json');
  swaggerDocument = JSON.parse(fs.readFileSync(swaggerPath, 'utf8'));
  router.use('/', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
} catch (error) {
  router.use('/', (req, res) => res.send('Swagger Docs not generated yet.'));
}

module.exports = router;
