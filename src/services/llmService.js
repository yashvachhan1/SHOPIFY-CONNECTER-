const { OpenAI } = require('openai');
const { queryShopify } = require('./shopifyService');
const logger = require('../utils/logger');

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
6. CONCISE RESPONSES (CRITICAL): Keep your answers VERY SHORT (maximum 2-3 sentences). Do NOT write long paragraphs or long bulleted lists.
7. LANGUAGE & TONE: Be empathetic and polite. Reply in the same language the user speaks to you (e.g., if they speak Hinglish, reply in Hinglish. If they speak English, reply in English).`;

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
  
  async function runCompletionAndStream(currentMessages) {
    const stream = await openai.chat.completions.create({
      model: "qwen/qwen3.8-27b",
      messages: currentMessages,
      tools: tools,
      tool_choice: "auto",
      stream: true,
      max_tokens: 1024
    });

    let fullContent = "";
    let detectedLanguage = "en";
    let isParsingTag = true;
    let tagBuffer = "";
    
    let isToolCall = false;
    let toolCalls = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      
      // Handle Tool Calls Streaming
      if (delta?.tool_calls) {
        isToolCall = true;
        for (const tc of delta.tool_calls) {
          if (!toolCalls[tc.index]) {
            toolCalls[tc.index] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
          }
          if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
        }
        continue; // Don't stream tool call tokens to client
      }

      // Handle Standard Content Streaming
      if (!isToolCall && delta?.content) {
        let text = delta.content;
        
        // Intercept language tag without sending it to user
        if (isParsingTag) {
          tagBuffer += text;
          if (tagBuffer.includes("[EN]")) {
              detectedLanguage = "en";
              isParsingTag = false;
              text = tagBuffer.replace("[EN]", "").trimStart();
              res.write(`data: ${JSON.stringify({ type: "language", language: "en" })}\n\n`);
          } else if (tagBuffer.includes("[HI]")) {
              detectedLanguage = "hi";
              isParsingTag = false;
              text = tagBuffer.replace("[HI]", "").trimStart();
              res.write(`data: ${JSON.stringify({ type: "language", language: "hi" })}\n\n`);
          } else if (tagBuffer.length > 10) {
              // Assume no tag, just English
              isParsingTag = false;
              text = tagBuffer;
              res.write(`data: ${JSON.stringify({ type: "language", language: "en" })}\n\n`);
          } else {
              // Keep buffering, do not emit yet
              continue;
          }
        }

        if (text) {
          fullContent += text;
          res.write(`data: ${JSON.stringify({ type: "content", text: text })}\n\n`);
        }
      }
    }
    
    return { isToolCall, toolCalls, fullContent, detectedLanguage };
  }

  try {
    // 1. Initial API call
    let result = await runCompletionAndStream(messages);

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
                    featured_image: local.image
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
          let liveResult = { handle: productHandle, price: "Not found", inventory: 0 };
          
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
                    inventory: variant.inventoryQuantity
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
      result = await runCompletionAndStream(messages);
    }
    
    // Clean up content
    let cleanContent = result.fullContent;
    if (cleanContent) {
      cleanContent = cleanContent.replace(/<think>[\s\S]*?<\/think>\n*/g, '').trim();
    }

    messages.push({ role: 'assistant', content: cleanContent });
    
    // Filter out tool calls to save tokens on subsequent turns
    const filteredMessages = messages.filter(m => m.role !== 'tool' && !m.tool_calls);

    // Send final metadata event
    res.write(`data: ${JSON.stringify({
      type: "metadata",
      language: result.detectedLanguage,
      products: finalProducts,
      messages: filteredMessages
    })}\n\n`);

  } catch (error) {
    logger.error('Error during chat processing', error);
    res.write(`data: ${JSON.stringify({ type: "error", error: "Failed to process chat" })}\n\n`);
  }
};

module.exports = { processChat };
