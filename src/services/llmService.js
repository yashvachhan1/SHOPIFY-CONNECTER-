const { OpenAI } = require('openai');
const { queryShopify } = require('./shopifyService');
const { shopifyStore } = require('../config/env');
const logger = require('../utils/logger');

const productUrl = (handle) => `https://${shopifyStore}/products/${handle}`;

// Safety net: the model sometimes ignores the "no markdown tables" instruction
// (comparison-style questions have a strong table prior). This detects any
// "| a | b |" + "|---|---|" markdown table and rewrites it as short bold-title
// lines, since the chat widget has no table renderer and would otherwise show
// the raw pipe/dash syntax as broken text.
function isTableRow(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.split('|').length > 2;
}

function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparatorRow(line) {
  if (!isTableRow(line)) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function stripMarkdownTables(text) {
  if (!text || !text.includes('|')) return text;

  const lines = text.split('\n');
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const nextLine = lines[i + 1];

    if (isTableRow(line) && typeof nextLine === 'string' && isTableSeparatorRow(nextLine)) {
      i += 2; // skip header + separator rows entirely, they add no value here
      while (i < lines.length && isTableRow(lines[i])) {
        const cells = splitTableRow(lines[i]).filter(Boolean);
        if (cells.length > 0) {
          // Strip any bold markers the model already put on the cell so we don't double them up
          // into "****title****" when we re-wrap it below.
          const [rawTitle, ...rest] = cells;
          const title = rawTitle.replace(/\*\*/g, '').trim();
          output.push(rest.length ? `**${title}** — ${rest.join(' — ')}` : `**${title}**`);
          output.push('');
        }
        i += 1;
      }
      continue;
    }

    output.push(line);
    i += 1;
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripHeadingsAndBullets(text) {
  return text
    .split('\n')
    .map((line) => line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*•]\s+/, '')
      .replace(/^\d+\.\s+/, ''))
    .join('\n');
}

// The model sometimes writes literal "<br>" tags instead of a real newline (seen after
// the "no bullet lists" rule pushed it toward "• item <br>• item" instead). The widget
// escapes all text before rendering, so a literal tag would otherwise show up on screen
// as the visible text "<br>" rather than an actual line break.
function normalizeLiteralHtml(text) {
  return text.replace(/<br\s*\/?>/gi, '\n');
}

// Extra defense-in-depth: the model still sometimes ignores the length instruction,
// especially when it insists on describing every product itself instead of trusting
// the product cards. Trims to the nearest sentence boundary instead of hard-cutting
// mid-word/mid-sentence.
function capLength(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  const window = text.slice(0, maxChars);
  const lastBoundary = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  );
  if (lastBoundary > maxChars * 0.3) {
    return window.slice(0, lastBoundary + 1).trim();
  }
  return `${window.trim()}…`;
}

// Reveals the already-generated, already-cleaned reply to the client a word at a
// time over the existing SSE "content" event, so the UI still feels like live
// typing even though generation and sanitization both happen before this runs.
async function emitContent(res, text) {
  const tokens = text.split(/(\s+)/).filter((t) => t !== '');
  for (const token of tokens) {
    res.write(`data: ${JSON.stringify({ type: 'content', text: token })}\n\n`);
    if (token.trim()) await new Promise((resolve) => setTimeout(resolve, 12));
  }
}

// Initialize OpenAI client pointing to Groq. The timeout/retry are explicit so a
// rate-limited or stalled call fails in a few seconds with a friendly message instead
// of leaving the customer watching the typing dots for half a minute.
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
  timeout: 25000,
  maxRetries: 1
});

const SYSTEM_PROMPT = `You are a friendly, knowledgeable, and professional virtual assistant for "Bodhi Health Inc.", a premium health supplements and wellness brand. You speak in a helpful and polite tone.

GREETINGS:
Do NOT introduce yourself (e.g., do not say "Hello, I am from Bodhi Health"). The user has already been greeted by the system. Just answer their questions directly and conversationally.

YOUR CAPABILITIES & RULES:
1. You have access to the Bodhi Health Shopify store via your tools. You can search for products, get product details, create orders, and check order statuses.
2. PRODUCT RECOMMENDATIONS: If a user mentions a health issue, symptom, or health goal, you MUST use the 'search_products' tool to find relevant supplements in our store.
3. SALES FOCUS: Act as a helpful representative. If the user likes a product, ask if they would like to place an order.
4. PRICING RULE: ONLY mention the price of a product if the customer explicitly asks for it.
5. LANGUAGE & TONE: Be empathetic and polite. ALWAYS reply in English, no matter what language the customer writes in (Hindi, Hinglish, or anything else) - just understand their message and answer in English.
6. PRODUCT CARDS, NOT LINKS IN TEXT (CRITICAL): When 'search_products' returns results, the app automatically shows the customer a photo card with the title and a link for EVERY product in that result - you do not need to, and must NOT, write out product names, links, or a per-product description list yourself. Never write markdown links [text](url), never invent a URL.
7. LENGTH: When you show product cards after a search, keep that specific reply to 1-2 short sentences - just a brief, friendly intro (e.g. "Here are a few options that get absorbed straight into your bloodstream - take a look below!"). Do NOT describe every product, do NOT compare them, do NOT ask "which one" with a list of options - the cards already do that. However, if the customer then asks for more detail about ONE specific product (ingredients, dosage, how it works, science, etc.), answer that fully and in as much detail as needed - the short-reply rule only applies to the initial multi-product recommendation, never to a direct follow-up question.
8. FORMATTING (CRITICAL): Plain conversational text only. NEVER use markdown tables, NEVER use headings (#, ##), NEVER use bullet or numbered lists.`;

const tools = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search the local database for products based on a query. ALWAYS correct spelling mistakes (e.g. bloodstromm -> bloodstream) and translate Hindi/Hinglish terms to English keywords before searching. Very fast. Does NOT return price or stock.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search term to look for in products" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_live_price",
      description: "Use this when the customer asks about price, cost, which option is cheapest, or stock. Pass the 'handle' value from a search_products result. Call it once per product you need a price for. Fetches live data from Shopify.",
      parameters: {
        type: "object",
        properties: {
          product_handle: { type: "string", description: "The handle/ID of the product to check" }
        },
        required: ["product_handle"]
      }
    }
  }
];

const MAX_TOOL_ROUNDS = 3;

// CSV descriptions are whole product-page bodies (~5k characters each). Sending three
// of those made a single search cost ~4k tokens, and every later turn re-sent them -
// which tripped Groq's rate limits and turned some questions into 30s failures. The
// model only needs a gist; the cards carry the full detail for the customer.
function clip(text, max) {
  const value = (text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}...`;
}

async function runProductSearch(query) {
  logger.info(`LLM requested product search for: "${query}"`);
  try {
    const { searchLocalProducts } = require('./csvService');
    const localMatches = await searchLocalProducts(query);

    if (localMatches.length === 0) {
      logger.info(`No local matches found in CSV for: "${query}"`);
      return [];
    }

    return localMatches.map((local) => ({
      id: local.handle,
      handle: local.handle, // named so the model knows what to pass to check_live_price
      title: local.title,
      description: clip(local.description, 300),
      activeIngredients: clip(local.activeIngredients, 150),
      price: 'N/A', // prices come from check_live_price so the CSV can't go stale on us
      featured_image: local.image,
      url: productUrl(local.handle),
    }));
  } catch (err) {
    logger.error(`Product search failed for "${query}": ${err.message}`);
    return [];
  }
}

async function fetchLivePrice(handle) {
  logger.info(`LLM requested live price check for: "${handle}"`);
  const fallback = { handle, price: 'Not found', inventory: 0, url: productUrl(handle) };

  try {
    const graphqlQuery = `
      query FetchLiveDetails($query: String!) {
        products(first: 1, query: $query) {
          edges {
            node {
              handle
              variants(first: 1) {
                edges { node { price compareAtPrice inventoryQuantity } }
              }
            }
          }
        }
      }
    `;

    const liveData = await queryShopify(graphqlQuery, { query: `handle:${handle}` });
    const variant = liveData?.products?.edges?.[0]?.node?.variants?.edges?.[0]?.node;
    if (!variant) return fallback;

    return {
      handle,
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
      inventory: variant.inventoryQuantity,
      url: productUrl(handle),
    };
  } catch (err) {
    logger.error(`Live price check failed for "${handle}": ${err.message}`);
    return fallback;
  }
}

const processChat = async (messages, res) => {
  // The client sends its own conversation history, which used to include a system
  // message of its own - that silently suppressed every rule below (formatting,
  // length, English-only, product cards), because this only added SYSTEM_PROMPT when
  // no system message was present. Any caller-supplied system message is dropped so
  // the store's real instructions always apply and can't be overridden from outside.
  const history = (Array.isArray(messages) ? messages : []).filter((m) => m && m.role !== 'system');
  messages.length = 0;
  messages.push({ role: 'system', content: SYSTEM_PROMPT }, ...history);

  let finalProducts = [];
  
  async function runCompletion(currentMessages) {
    const stream = await openai.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: currentMessages,
      tools: tools,
      tool_choice: "auto",
      stream: true,
      max_tokens: 1024
    });

    // Deltas are only accumulated here, not written straight to the client - the
    // full reply needs to pass through stripMarkdownTables() before anyone sees it.
    let fullContent = "";
    let isToolCall = false;
    let toolCalls = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.tool_calls) {
        isToolCall = true;
        for (const tc of delta.tool_calls) {
          if (!toolCalls[tc.index]) {
            toolCalls[tc.index] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
          }
          if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
        }
        continue;
      }

      if (!isToolCall && delta?.content) {
        fullContent += delta.content;
      }
    }

    return { isToolCall, toolCalls, fullContent };
  }

  try {
    // 1. Initial API call
    let result = await runCompletion(messages);

    // 2. Keep resolving tool calls until the model actually answers. A single round
    // wasn't enough: asking e.g. "which is cheapest" makes it call search_products and
    // THEN check_live_price, and the second round's reply was being sent to the customer
    // as an empty message bubble.
    let round = 0;
    while (result.isToolCall && round < MAX_TOOL_ROUNDS) {
      round += 1;
      const compactToolCalls = result.toolCalls.filter(Boolean); // Remove nulls

      // Add assistant's tool call request to history
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: compactToolCalls
      });

      // Every tool_call_id MUST get a matching tool message back, including ones we
      // don't implement - otherwise the next request is rejected as malformed and the
      // whole turn fails with "Failed to process chat". Run them in parallel so a reply
      // needing several price lookups doesn't take one Shopify round-trip at a time.
      const toolResults = await Promise.all(compactToolCalls.map(async (toolCall) => {
        const name = toolCall.function?.name;
        let args = {};
        try { args = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) { /* model sent invalid JSON */ }

        let content;
        if (name === 'search_products') {
          content = JSON.stringify(await runProductSearch(args.query || ''));
        } else if (name === 'check_live_price') {
          content = JSON.stringify(await fetchLivePrice(args.product_handle || ''));
        } else {
          logger.warn(`LLM requested unknown tool: "${name}"`);
          content = JSON.stringify({ error: `Unknown tool "${name}". Use search_products or check_live_price.` });
        }

        return { tool_call_id: toolCall.id, role: 'tool', name: name || 'unknown', content };
      }));

      // search_products results drive the product cards the customer sees.
      const searchResult = toolResults.find((r) => r.name === 'search_products');
      if (searchResult) {
        try { finalProducts = JSON.parse(searchResult.content); } catch (e) { finalProducts = []; }
      }

      messages.push(...toolResults);

      // Ask again now that the tool results are in history - this either produces the
      // final answer or another tool call, which the loop handles.
      result = await runCompletion(messages);
    }

    // Clean up content
    let cleanContent = result.fullContent;
    if (cleanContent) {
      cleanContent = cleanContent.replace(/<think>[\s\S]*?<\/think>\n*/g, '').trim();
      cleanContent = normalizeLiteralHtml(cleanContent);
      cleanContent = stripMarkdownTables(cleanContent);
      cleanContent = stripHeadingsAndBullets(cleanContent);
      // Brevity for the multi-product recommendation reply is handled by the prompt
      // (rule 7) so a genuine "tell me more about this one" follow-up never gets cut
      // off. This is just a generous runaway-output safety net, not a normal limit.
      cleanContent = capLength(cleanContent, 1500);
    }

    // Never send an empty bubble - if the model ran out of tool rounds or returned
    // nothing usable, say something rather than showing the customer a blank message.
    if (!cleanContent || !cleanContent.trim()) {
      cleanContent = finalProducts.length > 0
        ? 'Here are the options I found - take a look below.'
        : "Sorry, I couldn't put that together just now. Could you rephrase your question?";
    }

    await emitContent(res, cleanContent);

    messages.push({ role: 'assistant', content: cleanContent });

    // Filter out tool calls to save tokens on subsequent turns
    const filteredMessages = messages.filter(m => m.role !== 'tool' && !m.tool_calls);

    // Send final metadata event
    res.write(`data: ${JSON.stringify({
      type: "metadata",
      language: "en",
      products: finalProducts,
      messages: filteredMessages
    })}\n\n`);

  } catch (error) {
    // Log the message/stack explicitly - passing the Error object as winston metadata
    // swallowed it, which made these failures impossible to diagnose from Render logs.
    logger.error(`Chat processing failed: ${error.message}`, { stack: error.stack });
    // Send it as normal content, not an error event - the customer should read a plain
    // apology, not "Error: Failed to process chat" in the middle of the conversation.
    await emitContent(res, "Sorry, I'm having trouble reaching our system right now. Please try again in a moment.");
  }
};

module.exports = { processChat };
