const app = require('./app');
const { port } = require('./config/env');
const logger = require('./utils/logger');

app.listen(port, () => {
  logger.info(`Server is running on port ${port}`);
  console.log(`Server started on http://localhost:${port}`);
  console.log(`Swagger Docs available at http://localhost:${port}/api/docs`);
});
