# Shopify AI Bridge

A secure, production-ready Node.js bridge that connects an AI chatbot (via Groq) to the Shopify Admin GraphQL API — product search, order creation, order status, and customer lookup.

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
   GROQ_API_KEY=your-groq-api-key
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

## Chat widget

`public/index.html` (local) and `chatbot-widget.html` (points at the deployed Render URL) are simple
test pages for the `/api/chat` streaming endpoint — open either in a browser to try the bot directly.

## Endpoints

- `POST /api/search-products`, `/api/product`, `/api/create-order`, `/api/order-status`,
  `/api/customer`, `/api/store-info` — single-purpose REST endpoints (Bearer token required).
- `POST /api/agent` — one generic endpoint that dispatches to the above based on an `action` field
  in the body (`search_products`, `get_product_details`, `create_order`, `check_order_status`,
  `get_customer`, `get_store_info`).
- `POST /api/chat` — Groq-powered conversational endpoint (Server-Sent Events stream) used by the
  chat widget.
