require('dotenv').config();
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const { exec } = require('child_process');
const { pollMashov, startMashovHeartbeat, saveMashovSession } = require('./mashov');
const { setClient: setNotifyClient, sendDailySummary } = require('./notify');
const { createNotionTask } = require('./shared');

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }
function logErr(...args) { console.error(`[${new Date().toISOString()}]`, ...args); }

log('🚀 Starting Sylphrena Listener...');

// --- Configuration ---
const authorizedGroups = (process.env.AUTHORIZED_GROUPS || '').split(',').filter(Boolean);
const PROCESSOR_URL = process.env.PROCESSOR_URL; // URL for the Cloud Run processor
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MS || '600000', 10); // Default to 10 minutes
const PUPPETEER_SESSION_DIR = process.env.PUPPETEER_SESSION_DIR || '/usr/src/app/puppeteer_session';

log(`📋 Config: ${authorizedGroups.length} authorized group(s), check interval ${CHECK_INTERVAL / 1000}s`);
log(`📋 Processor URL: ${PROCESSOR_URL}`);
for (const g of authorizedGroups) {
    log(`   ✅ ${g}`);
}

if (!authorizedGroups.length) {
  log('⚠️ Warning: No authorized groups configured. Check AUTHORIZED_GROUPS.');
}
if (!PROCESSOR_URL) {
    logErr('❌ Error: PROCESSOR_URL environment variable is not set. The listener cannot trigger the processor.');
    process.exit(1);
}

// --- Message Aggregation ---
const messageQueues = {}; // { [groupId]: { messages: [], chatName: 'name' } }

// --- Health State Tracking ---
const startedAt = new Date().toISOString();
let whatsappState = 'initializing';
let lastProcessorTrigger = null;
let lastMashovPoll = null;
let lastDailySummary = null;

// --- WhatsApp Client Setup ---
const whatsapp = new Client({
    authStrategy: new LocalAuth({
        dataPath: PUPPETEER_SESSION_DIR
    }),
    puppeteer: {
        headless: true,
        protocolTimeout: 300_000,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
            '--disable-background-networking', '--disable-default-apps', '--disable-extensions',
            '--disable-sync', '--disable-translate', '--metrics-recording-only',
            '--no-first-run', '--safebrowsing-disable-auto-update',
            '--js-flags=--max-old-space-size=256',
        ],
    }
});

whatsapp.on('qr', qr => {
    console.log('\n\n\n\n\n\n\n\n');
    log('Scan this QR code with WhatsApp:\n');
    qrcode.generate(qr, {small: true});
});

whatsapp.on('ready', () => {
    whatsappState = 'connected';
    log('🛡️ Sylphrena Listener is ready.');
    log(`🕒 Job processor will be triggered every ${CHECK_INTERVAL / 1000 / 60} minutes.`);
    setInterval(triggerProcessor, CHECK_INTERVAL);

    // Notifications
    setNotifyClient(whatsapp);
    async function checkDailySummary() {
        const sent = await sendDailySummary();
        if (sent) lastDailySummary = new Date().toISOString();
    }
    checkDailySummary(); // check immediately on startup
    setInterval(checkDailySummary, 15 * 60 * 1000); // then every 15 min
    log('📲 Daily summary scheduled (checks every 15 min, sends at 18:00 Israel time)');

    // Mashov polling (opt-in: only if MASHOV_USERNAME is set)
    const MASHOV_INTERVAL = parseInt(process.env.MASHOV_CHECK_INTERVAL_MS || '1800000', 10);
    const mashovComplete = () => { lastMashovPoll = new Date().toISOString(); };
    if (process.env.MASHOV_USERNAME) {
        log(`🏫 Mashov polling enabled, interval: ${MASHOV_INTERVAL / 1000 / 60} minutes`);
        pollMashov(mashovComplete);
        setInterval(() => pollMashov(mashovComplete), MASHOV_INTERVAL);
        startMashovHeartbeat();
    } else {
        log('🏫 Mashov polling disabled (no MASHOV_USERNAME configured)');
    }
});

whatsapp.on('disconnected', (reason) => {
    whatsappState = 'disconnected';
    log(`⚠️ WhatsApp disconnected: ${reason}`);
});

whatsapp.on('message_create', async (msg) => {
    try {
        const chat = await msg.getChat();
        const trueGroupId = chat.id._serialized;
        const chatName = chat.name || trueGroupId;
        const sender = msg.author || msg.from || 'unknown';

        // Skip commands
        if (msg.body.startsWith('!')) {
            log(`⏭️ [${chatName}] Skipped command from ${sender}: "${msg.body.slice(0, 50)}"`);
            return;
        }

        // Skip unmonitored groups
        if (!authorizedGroups.includes(trueGroupId)) {
            return;
        }

        // Create a Notion alert when a file/image is shared in the chat
        if (msg.hasMedia) {
            try {
                await createNotionTask(
                    'ברבוריקה - יש קובץ בצ׳ט שאני לא יכולה לקרוא. כדאי שתבדקי אם זה במקרה שיעורים שהמורה נתנה',
                    chatName, null, 'WhatsApp'
                );
                log(`📎 [${chatName}] Media detected from ${sender} — Notion alert created`);
            } catch (err) {
                logErr(`📎 [${chatName}] Failed to create media alert: ${err.message}`);
            }
        }

        const content = msg.body || msg.caption || "";

        // Skip short messages
        if (content.length < 2) {
            log(`⏭️ [${chatName}] Skipped short message (${content.length} chars) from ${sender}`);
            return;
        }

        if (!messageQueues[trueGroupId]) {
            messageQueues[trueGroupId] = {
                messages: [],
                chatName: chatName
            };
        }

        messageQueues[trueGroupId].messages.push(content);
        const preview = content.slice(0, 80).replace(/\n/g, ' ');
        const queueLen = messageQueues[trueGroupId].messages.length;
        log(`📥 [${chatName}] Message #${queueLen} from ${sender}: "${preview}${content.length > 80 ? '...' : ''}"`);
    } catch (err) {
        logErr(`⚠️ Error handling message: ${err.message}`);
    }
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
        logErr('Error getting auth token from metadata server:', error.message);
        // Add more context for debugging common issues
        if (error.response) {
            logErr('Response status:', error.response.status);
            logErr('Response data:', error.response.data);
        }
        logErr(
            'This error usually means the VM is not running on GCP, ' +
            'or it does not have access to the metadata server.'
        );
        throw error;
    }
}

async function triggerProcessor() {
    // Snapshot queued messages and clear queues
    const snapshot = {}; // { groupId: { messages: [...], chatName } }
    const batchToProcess = {};
    let hasTasks = false;

    for (const groupId in messageQueues) {
        if (messageQueues[groupId].messages.length > 0) {
            const { messages, chatName } = messageQueues[groupId];
            snapshot[groupId] = { messages: [...messages], chatName };
            batchToProcess[chatName] = messages.join('\n');
            hasTasks = true;
            messageQueues[groupId].messages = []; // Clear the queue
        }
    }

    if (!hasTasks) {
        log('🕒 Periodic check: No new messages to process.');
        return;
    }

    const chatNames = Object.keys(batchToProcess);
    log(`📡 Triggering processor for ${chatNames.length} chat(s): ${chatNames.join(', ')}`);
    for (const name of chatNames) {
        const text = batchToProcess[name];
        log(`   📤 [${name}] Sending ${text.split('\n').length} message(s), ${text.length} chars`);
    }

    try {
        const token = await getAuthToken();
        const response = await axios.post(PROCESSOR_URL, batchToProcess, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        log(`✅ Processor responded: ${response.status} ${response.data}`);
        lastProcessorTrigger = new Date().toISOString();
    } catch (error) {
        logErr(`❌ Failed to trigger processor: ${error.message}`);
        if (error.response) {
            logErr(`   Response: ${error.response.status} ${JSON.stringify(error.response.data)}`);
        }
        // Restore snapshot — prepend to any new messages that arrived during the attempt
        let restoredCount = 0;
        for (const groupId in snapshot) {
            const { messages, chatName } = snapshot[groupId];
            if (!messageQueues[groupId]) {
                messageQueues[groupId] = { messages: [], chatName };
            }
            messageQueues[groupId].messages = [...messages, ...messageQueues[groupId].messages];
            restoredCount++;
        }
        log(`🔄 Restored ${restoredCount} group queue(s) — will retry next cycle`);
    }
}

// --- Health Check HTTP Server ---
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '8080', 10);

const healthServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        let queueDepth = 0;
        for (const groupId in messageQueues) {
            queueDepth += messageQueues[groupId].messages.length;
        }
        const body = JSON.stringify({
            status: whatsappState === 'connected' ? 'ok' : whatsappState,
            whatsapp: whatsappState,
            uptime_seconds: Math.floor(process.uptime()),
            last_processor_trigger: lastProcessorTrigger,
            last_mashov_poll: lastMashovPoll,
            last_daily_summary: lastDailySummary,
            queue_depth: queueDepth,
            version: process.env.APP_VERSION || 'unknown'
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
    } else {
        res.writeHead(404);
        res.end();
    }
});

healthServer.listen(HEALTH_PORT, () => {
    log(`🩺 Health check listening on port ${HEALTH_PORT}`);
});

// --- Graceful Shutdown ---
async function shutdown(signal) {
    log(`🛑 Received ${signal}, shutting down gracefully...`);
    whatsappState = 'shutting_down';
    saveMashovSession();
    try {
        await whatsapp.destroy();
        log('🛑 WhatsApp client destroyed');
    } catch (err) {
        logErr(`🛑 Error destroying WhatsApp client: ${err.message}`);
    }
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Initialization ---
whatsapp.initialize();