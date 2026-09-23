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

// The product cards already show every match with its photo and link, but the model
// still sometimes re-lists them all in the text (live QA saw replies over 1,200
// characters next to three cards). When the reply enumerates two or more of the
// products that were just returned, keep the intro and drop the redundant rundown.
// A reply that mentions only one product is a genuine "tell me about this one" answer
// and is left completely alone.
function trimProductEnumeration(text, products) {
  if (!text || !Array.isArray(products) || products.length < 2) return text;

  const positions = [];

  // Signal 1: the reply names the products we just returned. Titles get paraphrased
  // ("Sublingual Sleep (30 Pack)" for "Bodhi Health Sleep Sublingual, 30 Pack, ...")
  // so a leading-words match is tried as well as the full title.
  const haystack = text.toLowerCase();
  for (const product of products) {
    const title = (product.title || '').trim();
    if (title.length < 4) continue;

    const words = title.split(/\s+/);
    const candidates = words.length > 3 ? [title, words.slice(0, 3).join(' ')] : [title];
    for (const candidate of candidates) {
      const at = haystack.indexOf(candidate.toLowerCase());
      if (at > -1) {
        positions.push(at);
        break;
      }
    }
  }

  // Signal 2: the shape of a rundown - two or more lines led by a bold product name.
  // This catches paraphrased titles that signal 1 misses.
  let offset = 0;
  const boldLineStarts = [];
  for (const line of text.split('\n')) {
    if (/^\s*\*\*[^*]+\*\*/.test(line)) boldLineStarts.push(offset);
    offset += line.length + 1;
  }
  if (boldLineStarts.length >= 2) positions.push(boldLineStarts[0]);

  if (positions.length < 2 && boldLineStarts.length < 2) return text;

  const intro = text
    .slice(0, Math.min(...positions))
    .replace(/[\s*\-—:•]+$/, '')
    .trim();

  return intro.length >= 20 ? intro : 'Here are the options I found - take a look below.';
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
  // Overridable so the app can be run end-to-end locally against a stub instead of
  // burning real Groq calls; unset in production, where it stays pointed at Groq.
  baseURL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  timeout: 25000,
  maxRetries: 1
});

// Kept deliberately terse: this is re-sent on every API call (twice for a product
// question), and the plan's 8K tokens/minute is the binding constraint on how many
// customers the bot can serve. Every rule below is still load-bearing - see the QA
// history for the bug each one prevents.
const SYSTEM_PROMPT = `You are the assistant for "Bodhi Health Inc.", a premium supplements brand. Warm, polite, concise. Don't introduce yourself - the customer is already greeted.

RULES:
1. Health issue, symptom or goal mentioned? Use search_products. Asked about price/cost/cheapest/stock? Use check_live_price.
1b. Price questions in any spelling ("cheapest", "kitne ka", "sb she km price ka", "sasta", "cost") = search_products already gives you every price, so compare them and name the cheapest with its price yourself. Never ask the customer to pick a product first, never say you cannot check prices.
2. Reply in English always, whatever language the customer writes in.
3. Only mention price if asked. If they like something, offer to place an order.
4. After search_products, the app shows the customer a photo card with the title and link for every result. Never write product names, links or a per-product list yourself, never write markdown links.
5. So after a search, reply in 1-2 short sentences that ANSWER what they actually asked - say yes/no, or why these help ("Yes - these dissolve under the tongue so it absorbs straight into the bloodstream."). Never reply with a content-free line like "Here are a few options"; never list or describe the products one by one, the cards do that.
6. Exception: if they then ask about ONE product (ingredients, dosage, how it works), answer fully and in as much detail as needed. Rule 5 is only for the initial multi-product reply.
7. Plain conversational text only. Never tables, headings (#), bullet or numbered lists.`;

const tools = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Find products. Fix spelling (bloodstromm -> bloodstream) and translate Hindi/Hinglish to English keywords first. Returns each product with its live price and stock.",
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
      description: "Live price and stock from Shopify. Pass every handle you need in one call - e.g. all handles from the last search when asked which is cheapest.",
      parameters: {
        type: "object",
        properties: {
          product_handles: {
            type: "array",
            items: { type: "string" },
            description: "Handles from search_products results"
          }
        },
        required: ["product_handles"]
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

    // Prices come with the search results (fetched in parallel) rather than needing a
    // second tool call. "sabse kam price ka" used to fail because the model didn't
    // recognise misspelled Hinglish as a price question and never looked prices up -
    // now it always has the numbers in hand and can just compare them.
    const prices = await fetchLivePrices(localMatches.map((local) => local.handle));
    const priceByHandle = Object.fromEntries(prices.map((p) => [p.handle, p]));

    return localMatches.map((local) => {
      const live = priceByHandle[local.handle] || {};
      return {
        id: local.handle,
        handle: local.handle,
        title: local.title,
        description: clip(local.description, 180),
        activeIngredients: clip(local.activeIngredients, 100),
        price: live.price ?? 'Not found',
        inventory: live.inventory ?? 0,
        featured_image: local.image,
        url: productUrl(local.handle),
      };
    });
  } catch (err) {
    logger.error(`Product search failed for "${query}": ${err.message}`);
    return [];
  }
}

// Takes every handle at once: "which is cheapest" needs all three products priced, and
// one-at-a-time lookups used up the tool rounds before the model ever wrote an answer.
async function fetchLivePrices(handles) {
  const unique = [...new Set(handles.filter(Boolean))].slice(0, 5);
  if (unique.length === 0) return [];
  logger.info(`LLM requested live prices for: ${unique.join(', ')}`);
  return Promise.all(unique.map(fetchLivePrice));
}

async function fetchLivePrice(handle) {
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
      max_tokens: 600
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

      // Models often narrate ("Let me check that price for you.") in the same round as
      // a tool call. That text used to be dropped because isToolCall was already set,
      // which is how price questions ended up with nothing to show the customer.
      if (delta?.content) {
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
    let lastSpokenContent = '';
    while (result.isToolCall && round < MAX_TOOL_ROUNDS) {
      round += 1;
      // Keep whatever the model said on its way to the tool call, in case it runs out
      // of rounds without ever writing a final answer.
      if (result.fullContent.trim()) lastSpokenContent = result.fullContent;
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
          // Accept the single-handle shape too, in case the model falls back to it.
          const handles = Array.isArray(args.product_handles)
            ? args.product_handles
            : [args.product_handles || args.product_handle].filter(Boolean);
          content = JSON.stringify(await fetchLivePrices(handles));
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
    let cleanContent = result.fullContent.trim() ? result.fullContent : lastSpokenContent;
    if (cleanContent) {
      cleanContent = cleanContent.replace(/<think>[\s\S]*?<\/think>\n*/g, '').trim();
      cleanContent = normalizeLiteralHtml(cleanContent);
      cleanContent = stripMarkdownTables(cleanContent);
      cleanContent = stripHeadingsAndBullets(cleanContent);
      cleanContent = trimProductEnumeration(cleanContent, finalProducts);
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
