const Groq = require('groq-sdk');
const { groqApiKey } = require('../config/env');
const { queryShopify } = require('./shopifyService');
const logger = require('../utils/logger');

const groq = new Groq({ apiKey: groqApiKey });

const SYSTEM_PROMPT = `You are a friendly, knowledgeable, and professional virtual assistant for "Bodhi Health Inc.", a premium health supplements and wellness brand. You speak in a helpful and polite tone.

GREETINGS:
Do NOT introduce yourself (e.g., do not say "Hello, I am from Bodhi Health"). The user has already been greeted by the system. Just answer their questions directly and conversationally.

YOUR CAPABILITIES & RULES:
1. You have access to the Bodhi Health Shopify store via your tools. You can search for products, get product details, create orders, and check order statuses.
2. PRODUCT RECOMMENDATIONS (CRITICAL): If a user mentions a health issue, symptom (like bloodstream problems, joint pain, energy loss, etc.), or health goal, you MUST use the 'search_products' tool to find relevant supplements in our store.
3. CONFIDENT ASSISTANCE: If you find a matching product, confidently recommend it as a solution provided by Bodhi Health. Explain its benefits based on the product details you fetch.
4. MEDICAL DISCLAIMER OVERRIDE: NEVER say "I cannot provide medical advice" in a way that stops you from helping. You ARE allowed to recommend Bodhi Health products for their issues. If the issue sounds severe, you can recommend the product and simply add a polite, gentle disclaimer like: "Our products are excellent for supporting your health, but please consult a doctor for serious conditions."
5. SALES FOCUS: Act as a helpful representative. If the user likes a product, ask if they would like to place an order. If yes, collect their details and use the 'create_order' tool.
6. PRICING RULE (CRITICAL): ONLY mention the price of a product if the customer explicitly asks for it (e.g. "Kitne ka hai?", "What is the price?"). If they do not ask, do NOT mention the price.
7. CONVERSATIONAL & CONCISE (CRITICAL): Keep your answers VERY SHORT (maximum 2-3 sentences). Do NOT write long paragraphs. 
8. NO MARKDOWN (CRITICAL): Do NOT use bolding (**), bullet points (-), or any markdown formatting. Write plain, conversational text that is easy to read out loud.
9. TONE: Be empathetic, polite, and strictly act as an employee of Bodhi Health Inc.

LANGUAGE ROUTING INSTRUCTION (CRITICAL):
You MUST ALWAYS reply in English by default.
Even if the user speaks to you in Hindi, Gujarati, or Hinglish, you MUST reply in English!
The ONLY exception is if the user EXPLICITLY COMMANDS you to speak in Hindi (e.g., "Hindi me baat karo", "Speak in Hindi"). Only then you may reply in Hindi.
If you reply in English, you MUST start your message with exactly: [EN]
If you reply in Hindi, you MUST start your message with exactly: [HI] 
If you write Hindi, use native Devanagari script. Do not write Hindi in English letters (Hinglish).
Example: "[EN] Yes, we have..." or "[HI] जी हाँ, हमारे पास..."`;

const tools = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search the Shopify store for products based on a query (e.g., 'blood stream', 'energy', 'curcumin')",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search term to look for in products" }
        },
        required: ["query"]
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
    const stream = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
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
          // 1. Search Local CSV Database
          const { searchLocalProducts } = require('./csvService');
          const localMatches = await searchLocalProducts(searchQuery);
          
          if (localMatches.length > 0) {
              // 2. Fetch Live Price & Inventory from Shopify
              // Construct a query for the matched handles
              const handleQueries = localMatches.map(p => `handle:${p.handle}`).join(' OR ');
              
              const graphqlQuery = `
                query FetchLiveDetails($query: String!) {
                  products(first: 10, query: $query) {
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
              
              const liveData = await queryShopify(graphqlQuery, { query: handleQueries });
              
              // 3. Merge Local CSV Data with Live API Data
              finalProducts = localMatches.map(local => {
                  // Find corresponding live data
                  const liveNode = liveData?.products?.edges?.find(e => e.node.handle === local.handle)?.node;
                  const variant = liveNode?.variants?.edges?.[0]?.node;
                  
                  return {
                      id: local.handle,
                      title: local.title,
                      description: local.description,
                      activeIngredients: local.activeIngredients,
                      price: variant?.price || "N/A",
                      compareAtPrice: variant?.compareAtPrice || null,
                      inventoryQuantity: variant?.inventoryQuantity || 0,
                      featured_image: local.image
                  };
              });
              
          } else {
              logger.info(`No local matches found in CSV for: "${searchQuery}"`);
          }
          
        } catch (err) {
          logger.error('Hybrid search error', err);
        }

        // 3. Send result back to Groq
        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: "search_products",
          content: JSON.stringify(finalProducts),
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
};

module.exports = { processChat };
