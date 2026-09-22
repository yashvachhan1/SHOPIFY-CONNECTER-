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

// Initialize OpenAI client pointing to Groq
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
});

const SYSTEM_PROMPT = `You are a friendly, knowledgeable, and professional virtual assistant for "Bodhi Health Inc.", a premium health supplements and wellness brand. You speak in a helpful and polite tone.

GREETINGS:
Do NOT introduce yourself (e.g., do not say "Hello, I am from Bodhi Health"). The user has already been greeted by the system. Just answer their questions directly and conversationally.

YOUR CAPABILITIES & RULES:
1. You have access to the Bodhi Health Shopify store via your tools. You can search for products, get product details, create orders, and check order statuses.
2. PRODUCT RECOMMENDATIONS: If a user mentions a health issue, symptom, or health goal, you MUST use the 'search_products' tool to find relevant supplements in our store.
3. CONFIDENT ASSISTANCE: If you find a matching product, confidently recommend it as a solution provided by Bodhi Health. Explain its benefits briefly.
4. SALES FOCUS: Act as a helpful representative. If the user likes a product, ask if they would like to place an order.
5. PRICING RULE: ONLY mention the price of a product if the customer explicitly asks for it.
6. CONCISE RESPONSES (CRITICAL): Keep your answers VERY SHORT (maximum 2-3 sentences per product). Do NOT write long paragraphs.
7. LANGUAGE & TONE: Be empathetic and polite. ALWAYS reply in English, no matter what language the customer writes in (Hindi, Hinglish, or anything else) - just understand their message and answer in English.
8. PRODUCT LINKS: Whenever you recommend or mention a specific product that has a "url" field in the tool results, include it as a markdown link in this exact format: [Product Title](url). Never invent a URL - only use the "url" value given to you by the tool.
9. FORMATTING (CRITICAL): This is a narrow chat widget, not a document. NEVER use markdown tables (no "|" pipe characters, no "---" separator rows) - they render as broken text here. NEVER use headings (#), and never use numbered/bulleted lists with more than 3 items. When listing multiple products, pick at most the top 2-3 matches and write each as one short line: **[Product Title](url)** — one-sentence benefit. Nothing else.`;

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
      description: "ONLY use this if the user explicitly asks for the price or quantity/stock of a product. Fetches live data from Shopify.",
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

const processChat = async (messages, res) => {
  // Ensure system prompt is always at the beginning
  if (!messages || messages.length === 0 || messages[0].role !== 'system') {
    messages.unshift({ role: 'system', content: SYSTEM_PROMPT });
  }

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

    // 2. Handle Tool Calls if any
    if (result.isToolCall) {
      const compactToolCalls = result.toolCalls.filter(Boolean); // Remove nulls
      
      // Add assistant's tool call request to history
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: compactToolCalls
      });

      for (const toolCall of compactToolCalls) {
        if (toolCall.function.name === "search_products") {
          let args = {};
          try { args = JSON.parse(toolCall.function.arguments); } catch(e){}
          const searchQuery = args.query || "";

          logger.info(`LLM requested product search for: "${searchQuery}"`);
          
          finalProducts = [];
          
          try {
            // 1. Search Local CSV Database Only (for max speed)
            const { searchLocalProducts } = require('./csvService');
            const localMatches = await searchLocalProducts(searchQuery);
            
            if (localMatches.length > 0) {
                finalProducts = localMatches.map(local => ({
                    id: local.handle,
                    title: local.title,
                    description: local.description,
                    activeIngredients: local.activeIngredients,
                    price: "N/A", // Use N/A to keep responses purely conversational without fetching live prices
                    featured_image: local.image,
                    url: productUrl(local.handle)
                }));
            } else {
                logger.info(`No local matches found in CSV for: "${searchQuery}"`);
            }
            
          } catch (err) {
            logger.error('Search error', err);
          }

          // 3. Send result back to Groq
          messages.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: "search_products",
            content: JSON.stringify(finalProducts),
          });
        } else if (toolCall.function.name === "check_live_price") {
          let args = {};
          try { args = JSON.parse(toolCall.function.arguments); } catch(e){}
          const productHandle = args.product_handle || "";

          logger.info(`LLM requested live price check for: "${productHandle}"`);
          let liveResult = { handle: productHandle, price: "Not found", inventory: 0, url: productUrl(productHandle) };
          
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
            
            const liveData = await queryShopify(graphqlQuery, { query: `handle:${productHandle}` });
            const liveNode = liveData?.products?.edges?.[0]?.node;
            const variant = liveNode?.variants?.edges?.[0]?.node;
            
            if (variant) {
                liveResult = {
                    handle: productHandle,
                    price: variant.price,
                    compareAtPrice: variant.compareAtPrice,
                    inventory: variant.inventoryQuantity,
                    url: productUrl(productHandle)
                };
            }
          } catch (err) {
            logger.error('Live price check error', err);
          }

          messages.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: "check_live_price",
            content: JSON.stringify(liveResult),
          });
        }
      }

      // 4. Run second completion to get actual response based on tool results
      result = await runCompletion(messages);
    }

    // Clean up content
    let cleanContent = result.fullContent;
    if (cleanContent) {
      cleanContent = cleanContent.replace(/<think>[\s\S]*?<\/think>\n*/g, '').trim();
      cleanContent = stripMarkdownTables(cleanContent);
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
    logger.error('Error during chat processing', error);
    res.write(`data: ${JSON.stringify({ type: "error", error: "Failed to process chat" })}\n\n`);
  }
};

module.exports = { processChat };
