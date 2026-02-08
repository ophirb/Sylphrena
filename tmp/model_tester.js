import 'dotenv/config'; // Ensures environment variables are loaded
import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * This script tests the connection to the Gemini API using a specific model.
 */
async function testGeminiConnection() {
    console.log('🚀 Starting Gemini Connection Test...');
    console.log('Checking Environment Variables:');
    const apiKey = process.env.GEMINI_API_KEY;
    console.log('- Gemini Key:', apiKey ? '✅ Loaded' : '❌ Missing');

    if (!apiKey) {
        console.error('❌ Gemini API key is missing. Please add it to your .env file.');
        return;
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        // Use the recommended model to test the connection.
        const modelName = "gemini-2.5-flash";
        const model = genAI.getGenerativeModel({ model: modelName });

        console.log(`🤖 Sending a test prompt to "${modelName}"...`);
        const prompt = "hello";

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        console.log('✅ Gemini API Connection Successful!');
        console.log('Response:', text);

    } catch (error) {
        console.error('❌ An error occurred during the Gemini API call:');
        console.error('   This can happen if the model name is incorrect, or if there are issues with your API key or Google Cloud project setup.');
        console.error('\n   Troubleshooting Steps:');
        console.error('   1. Ensure the model name "gemini-2.5-flash" is correct and available for your key.');
        console.error('   2. Go to Google AI Studio (https://aistudio.google.com/app/apikey) and verify your API key.');
        console.error('   3. Ensure the project associated with the key has the "Generative Language API" enabled.');
        console.error('      - Go to https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com');
        console.error('      - Select your project and click "Enable".');
        console.error('   4. Ensure your project has a billing account enabled. Some models require this even for free-tier usage.');
        console.error('   Full Error:', error.message);
    }
}

testGeminiConnection();
