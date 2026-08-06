# Shopify AI Bridge

A secure, production-ready Node.js bridge to connect an ElevenLabs AI Agent to the Shopify Admin GraphQL API.

## Features
- **Security First:** Helmet, CORS, Rate Limiting, and strict Bearer Token authentication.
- **Shopify GraphQL API:** Only uses the robust GraphQL admin endpoints.
- **Robust Error Handling:** Global error handler to catch and format all errors consistently.
- **Logging:** Centralized Winston logging (saves to `/logs`).
- **Validation:** Express-Validator ensures clean input data before hitting Shopify.
- **API Documentation:** Auto-generated Swagger documentation available at `/api/docs`.

## Installation

1. Clone or download this project.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Set up your environment variables. Edit `.env`:
   ```env
   PORT=3000
   SHOPIFY_STORE=your-store-name.myshopify.com
   SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_1234567890abcdef
   API_SECRET=your-secure-secret-token
   ```

## Running Locally

To start the server in development mode (with hot-reloading):
```bash
npm run dev
```
To start the server in production mode:
```bash
npm start
```

## Testing

A Postman Collection (`shopify-ai-bridge.postman_collection.json`) is included in the project root. You can import this into Postman or Thunder Client to easily test all endpoints locally.

Don't forget to configure the `API_SECRET` in your Postman variables or headers to match your `.env`!

## Connecting with ElevenLabs Webhook Tool

When setting up your AI agent in ElevenLabs:

1. Create a Webhook Action.
2. Set the Method to **POST**.
3. Point the URL to your deployed endpoint (e.g., `https://your-domain.com/api/search-products`).
4. In the Headers, add:
   - `Authorization`: `Bearer your-secure-secret-token` (Must match `API_SECRET` in `.env`)
5. In the Body, map the required parameters to the JSON format. The AI Bridge will respond with a consistent JSON schema that ElevenLabs can parse efficiently.
