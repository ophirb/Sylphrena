require('dotenv').config();
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const { exec } = require('child_process');
const { pollMashov, startMashovHeartbeat, saveMashovSession } = require('./mashov');
const { setClient: setNotifyClient, sendDailySummary } = require('./notify');
const { createNotionTask } = require('./shared');
const { backupSession, restoreSession } = require('./session-backup');

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
let whatsappInitAttempt = 0;
let lastProcessorTrigger = null;
let lastMashovPoll = null;
let lastDailySummary = null;
let lastMessageReceived = null;
let lastNotionWrite = null;
let mashovItemsToday = 0;
let mashovItemsTodayDate = null;
let latestQr = null;

// Token to protect the /qr endpoint — use env var for persistence across restarts
const { randomBytes } = require('crypto');
const QR_TOKEN = process.env.QR_TOKEN || randomBytes(8).toString('hex');
log(`🔑 QR endpoint token: ${QR_TOKEN}  →  /qr?token=${QR_TOKEN}`);

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
    latestQr = qr;
    console.log('\n\n\n\n\n\n\n\n');
    log('Scan this QR code with WhatsApp:\n');
    qrcode.generate(qr, {small: true});
});

whatsapp.on('ready', () => {
    whatsappState = 'connected';
    latestQr = null;
    whatsappInitAttempt = 0;
    log('🛡️ Sylphrena Listener is ready.');
    log(`🕒 Job processor will be triggered every ${CHECK_INTERVAL / 1000 / 60} minutes.`);
    setInterval(triggerProcessor, CHECK_INTERVAL);

    // Back up session immediately and then every hour
    backupSession();
    setInterval(backupSession, 60 * 60 * 1000);

    // Notifications
    setNotifyClient(whatsapp);
    async function checkDailySummary() {
        const sent = await sendDailySummary();
        if (sent) lastDailySummary = new Date().toISOString();
    }
    checkDailySummary(); // check immediately on startup
    setInterval(checkDailySummary, 15 * 60 * 1000); // then every 15 min
    log('📲 Daily summary scheduled (checks every 15 min, sends at 18:00 Israel time)');

});

// --- Mashov Polling (independent of WhatsApp connection) ---
const MASHOV_INTERVAL = parseInt(process.env.MASHOV_CHECK_INTERVAL_MS || '1800000', 10);
const mashovComplete = (newItems = 0) => {
    lastMashovPoll = new Date().toISOString();
    if (newItems > 0) {
        lastNotionWrite = new Date().toISOString();
        const todayStr = new Date().toISOString().split('T')[0];
        if (mashovItemsTodayDate !== todayStr) { mashovItemsToday = 0; mashovItemsTodayDate = todayStr; }
        mashovItemsToday += newItems;
    }
};
if (process.env.MASHOV_USERNAME) {
    log(`🏫 Mashov polling enabled, interval: ${MASHOV_INTERVAL / 1000 / 60} minutes`);
    pollMashov(mashovComplete);
    setInterval(() => pollMashov(mashovComplete), MASHOV_INTERVAL);
    startMashovHeartbeat();
} else {
    log('🏫 Mashov polling disabled (no MASHOV_USERNAME configured)');
}

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
        lastMessageReceived = new Date().toISOString();

        // Create a Notion alert when a file/image is shared in the chat
        if (msg.hasMedia) {
            try {
                const msgTime = new Date(msg.timestamp * 1000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
                await createNotionTask(
                    `התקבל קובץ בשעה ${msgTime}`,
                    chatName, null, 'WhatsApp', process.env.DATABASE_ID
                );
                lastNotionWrite = new Date().toISOString();
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
        const response = await axios.post(PROCESSOR_URL, { batches: batchToProcess, databaseId: process.env.DATABASE_ID }, {
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

function timeSince(isoString) {
    if (!isoString) return null;
    const seconds = Math.floor((Date.now() - new Date(isoString)) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function timeUntil(isoString) {
    if (!isoString) return null;
    const seconds = Math.floor((new Date(isoString) - Date.now()) / 1000);
    if (seconds <= 0) return 'now';
    if (seconds < 60) return `in ${seconds}s`;
    if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
    return `in ${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function nextDailySummaryISO() {
    const israelNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const next = new Date(israelNow);
    next.setHours(18, 0, 0, 0);
    if (israelNow.getHours() >= 18) next.setDate(next.getDate() + 1);
    return next.toISOString();
}

const healthServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        let queueDepth = 0;
        for (const groupId in messageQueues) {
            queueDepth += messageQueues[groupId].messages.length;
        }

        const whatsappOk = whatsappState === 'connected';
        const whatsappDetail = {
            connected: 'Connected and listening',
            initializing: 'Connecting — session may need QR scan',
            disconnected: 'Disconnected — QR scan required',
            shutting_down: 'Shutting down',
        }[whatsappState] || whatsappState;

        const mashovEnabled = !!process.env.MASHOV_USERNAME;
        const mashovOk = mashovEnabled && lastMashovPoll !== null;
        const nextMashovPoll = lastMashovPoll
            ? new Date(new Date(lastMashovPoll).getTime() + MASHOV_INTERVAL).toISOString()
            : null;
        const mashovDetail = !mashovEnabled
            ? 'Disabled (no MASHOV_USERNAME)'
            : lastMashovPoll
                ? `Last poll ${timeSince(lastMashovPoll)}, next ${timeUntil(nextMashovPoll)}`
                : 'Enabled — waiting for first poll';

        const processorOk = lastProcessorTrigger !== null || queueDepth === 0;
        const processorDetail = lastProcessorTrigger
            ? `Last triggered ${timeSince(lastProcessorTrigger)}${queueDepth > 0 ? `, ${queueDepth} message(s) queued` : ', queue empty'}`
            : queueDepth > 0
                ? `Never triggered — ${queueDepth} message(s) queued`
                : 'No messages processed yet';

        const summaryOk = lastDailySummary !== null;
        const summaryDetail = lastDailySummary
            ? `Last sent ${timeSince(lastDailySummary)}, next ${timeUntil(nextDailySummaryISO())}`
            : `Not sent yet — next ${timeUntil(nextDailySummaryISO())}`;

        const mem = process.memoryUsage();
        const mb = v => Math.round(v / 1024 / 1024);
        const heapUsedMB = mb(mem.heapUsed);
        const heapTotalMB = mb(mem.heapTotal);
        const rssMB = mb(mem.rss);
        const memWarning = heapUsedMB > 200 ? ' ⚠️ approaching heap limit' : '';

        const allOk = whatsappOk && (!mashovEnabled || mashovOk);
        const overallStatus = allOk ? 'ok' : whatsappState === 'initializing' ? 'initializing' : 'degraded';

        const body = JSON.stringify({
            status: overallStatus,
            version: process.env.APP_VERSION || 'unknown',
            uptime: `${Math.floor(process.uptime() / 60)}m ${Math.floor(process.uptime() % 60)}s`,
            memory: {
                heap_used: `${heapUsedMB}MB`,
                heap_total: `${heapTotalMB}MB`,
                rss: `${rssMB}MB`,
                detail: `${heapUsedMB}/${heapTotalMB}MB heap, ${rssMB}MB RSS${memWarning}`,
            },
            components: {
                whatsapp: {
                    ok: whatsappOk,
                    state: whatsappState,
                    detail: whatsappDetail,
                    ...(whatsappInitAttempt > 1 && { retry: `attempt ${whatsappInitAttempt}/5` }),
                    last_message: lastMessageReceived ? timeSince(lastMessageReceived) : 'none this session',
                },
                mashov: {
                    ok: mashovOk,
                    detail: mashovDetail,
                    items_today: mashovItemsToday,
                    last_notion_write: lastNotionWrite ? timeSince(lastNotionWrite) : 'none this session',
                },
                processor: { ok: processorOk, queue_depth: queueDepth, detail: processorDetail },
                notifications: { ok: true, detail: summaryDetail },
            }
        }, null, 2);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
    } else if (req.method === 'GET' && req.url.startsWith('/qr')) {
        const params = new URL(req.url, 'http://localhost').searchParams;
        if (params.get('token') !== QR_TOKEN) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
            return;
        }
        if (!latestQr) {
            const msg = whatsappState === 'connected'
                ? 'WhatsApp is already connected — no QR needed.'
                : 'No QR code available yet — try again in a few seconds.';
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sylphrena QR</title><style>body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;background:#f5f5f5;color:#555;font-size:18px;}</style></head><body><p>${msg}</p></body></html>`);
            return;
        }
        const qrJson = JSON.stringify(latestQr);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="15"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sylphrena QR</title><style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;background:#f5f5f5;}h2{color:#333;margin-bottom:16px;}p{color:#888;font-size:13px;margin-top:16px;}</style></head><body><h2>Scan with WhatsApp</h2><div id="qr"></div><p>Auto-refreshes every 15 seconds</p><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>new QRCode(document.getElementById('qr'),{text:${qrJson},width:256,height:256});</script></body></html>`);
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

// --- OOM Watchdog ---
// If heap exceeds 220MB (V8 is capped at 256MB), trigger a graceful shutdown
// so Docker's --restart always brings the container back clean.
// Skip the first 2 minutes to let WhatsApp fully initialize.
const OOM_HEAP_THRESHOLD_MB = 220;
setInterval(() => {
    const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    if (heapMB > OOM_HEAP_THRESHOLD_MB) {
        if (process.uptime() < 120) {
            log(`⚠️ OOM watchdog: heap ${heapMB}MB > ${OOM_HEAP_THRESHOLD_MB}MB — init grace period, skipping`);
            return;
        }
        logErr(`🔴 OOM watchdog: heap ${heapMB}MB > ${OOM_HEAP_THRESHOLD_MB}MB — triggering graceful restart`);
        shutdown('OOM_WATCHDOG');
    }
}, 2 * 60 * 1000);

// --- Initialization ---
async function initializeWhatsApp(attempt = 1, maxAttempts = 5) {
    whatsappInitAttempt = attempt;
    try {
        if (attempt === 1) await restoreSession();
        await whatsapp.initialize();
    } catch (err) {
        logErr(`❌ WhatsApp initialization failed (attempt ${attempt}/${maxAttempts}): ${err.message}`);
        if (attempt < maxAttempts) {
            const delay = attempt * 15000; // 15s, 30s, 45s, 60s
            log(`🔄 Retrying in ${delay / 1000}s...`);
            setTimeout(() => initializeWhatsApp(attempt + 1, maxAttempts), delay);
        } else {
            logErr('❌ WhatsApp initialization failed after all retries — QR scan required');
        }
    }
}
initializeWhatsApp();