require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const { exec } = require('child_process');

console.log('🚀 Starting Sylphrena Listener...');

// --- Configuration ---
const authorizedGroups = (process.env.AUTHORIZED_GROUPS || '').split(',').filter(Boolean);
const PROCESSOR_URL = process.env.PROCESSOR_URL; // URL for the Cloud Run processor
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10); // Default to 1 minute
const PUPPETEER_SESSION_DIR = process.env.PUPPETEER_SESSION_DIR || '/usr/src/app/puppeteer_session';

if (!authorizedGroups.length) {
  console.warn('⚠️ Warning: No authorized groups configured. Check AUTHORIZED_GROUPS.');
}
if (!PROCESSOR_URL) {
    console.error('❌ Error: PROCESSOR_URL environment variable is not set. The listener cannot trigger the processor.');
    process.exit(1);
}

// --- Message Aggregation ---
const messageQueues = {}; // { [groupId]: { messages: [], chatName: 'name' } }

// --- WhatsApp Client Setup ---
const whatsapp = new Client({
    authStrategy: new LocalAuth({
        dataPath: PUPPETEER_SESSION_DIR
    }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    }
});

whatsapp.on('qr', qr => {
    qrcode.generate(qr, {small: true});
});

whatsapp.on('ready', () => {
    console.log('🛡️ Sylphrena Listener is ready.');
});

whatsapp.on('message_create', async (msg) => {
    if (msg.body.startsWith('!')) return;

    const chat = await msg.getChat();
    const trueGroupId = chat.id._serialized;

    if (!authorizedGroups.includes(trueGroupId)) return;

    const content = msg.body || msg.caption || "";
    if (content.length < 2) return;

    if (!messageQueues[trueGroupId]) {
        messageQueues[trueGroupId] = {
            messages: [],
            chatName: chat.name || "קבוצה ללא שם"
        };
    }

    messageQueues[trueGroupId].messages.push(content);
    console.log(`📥 [${messageQueues[trueGroupId].chatName}] Message captured. Total chats in queue: ${Object.keys(messageQueues).length}`);
});

// --- Task Processor Trigger ---

// Function to get an authentication token for the Cloud Run service
async function getAuthToken() {
    // This function queries the GCE metadata server to get an identity token
    // for the target Cloud Run service. It only works when run on GCE.
    const metadataUrl = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${PROCESSOR_URL}`;
    try {
        const response = await axios.get(metadataUrl, {
            headers: { 'Metadata-Flavor': 'Google' }
        });
        return response.data;
    } catch (error) {
        console.error('Error getting auth token from metadata server:', error.message);
        // Add more context for debugging common issues
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        console.error(
            'This error usually means the VM is not running on GCP, ' +
            'or it does not have access to the metadata server.'
        );
        throw error;
    }
}

async function triggerProcessor() {
    const batchToProcess = {};
    let hasTasks = false;

    for (const groupId in messageQueues) {
        if (messageQueues[groupId].messages.length > 0) {
            const { messages, chatName } = messageQueues[groupId];
            batchToProcess[chatName] = messages.join('\n');
            hasTasks = true;
            messageQueues[groupId].messages = []; // Clear the queue
        }
    }

    if (!hasTasks) {
        console.log('🕒 Periodic check: No new messages to process.');
        return;
    }

    console.log(`📡 Triggering processor for ${Object.keys(batchToProcess).length} chat(s)...`);
    try {
        const token = await getAuthToken();
        await axios.post(PROCESSOR_URL, batchToProcess, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        console.log('✅ Successfully triggered processor.');
    } catch (error) {
        console.error('❌ Failed to trigger processor:', error.message);
    }
}

// --- Initialization ---
whatsapp.initialize();
console.log(`🕒 Job processor will be triggered every ${CHECK_INTERVAL / 1000 / 60} minutes.`);
setInterval(triggerProcessor, CHECK_INTERVAL);