const Groq = require('groq-sdk');
require('dotenv').config({ path: '.env' });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function testQwen() {
    try {
        const stream = await groq.chat.completions.create({
            model: "openai/gpt-oss-safeguard-20b",
            messages: [{ role: 'user', content: 'What is 2+2? Keep it short.' }],
            stream: true
        });
        for await (const chunk of stream) {
            console.log("CHUNK:", JSON.stringify(chunk.choices[0].delta));
        }
    } catch (err) {
        console.error("ERROR:", err.message);
    }
}
testQwen();
