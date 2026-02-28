const { getUpcomingTasks } = require('./shared');

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }
function logErr(...args) { console.error(`[${new Date().toISOString()}]`, ...args); }

// Phone numbers (Israel format without leading +) — configured via env vars
const SUMMARY_NUMBERS = (process.env.SUMMARY_NUMBERS || '').split(',').filter(Boolean);
const ERROR_NUMBER = process.env.ERROR_NUMBER || '';

let client = null;
let lastErrorSentAt = 0;
let lastSummarySentDate = null;
let pendingAlert = null; // buffered alert to send when WA reconnects

function setClient(whatsappClient) {
    client = whatsappClient;
    log('📲 Notify module initialized with WhatsApp client');
    if (pendingAlert) {
        const msg = pendingAlert;
        pendingAlert = null;
        log('📲 Flushing buffered alert after reconnect');
        sendWhatsApp(ERROR_NUMBER, msg).catch(() => {});
    }
}

async function sendWhatsApp(number, text) {
    if (!client) {
        logErr('📲 Cannot send — WhatsApp client not set');
        return;
    }
    const chatId = `${number}@c.us`;
    try {
        await client.sendMessage(chatId, text);
        log(`📲 Sent message to ${number}`);
    } catch (err) {
        logErr(`📲 Failed to send to ${number}: ${err.message}`);
    }
}

async function sendError(message) {
    const now = Date.now();
    if (now - lastErrorSentAt < 60 * 60 * 1000) {
        log('📲 Error alert throttled (max 1/hour)');
        return;
    }
    lastErrorSentAt = now;
    const text = `⚠️ Sylphrena Error:\n${message}`;
    if (!client) {
        pendingAlert = text; // flush when WhatsApp reconnects via setClient()
        log('📲 WhatsApp not ready — alert buffered for reconnect');
        return;
    }
    await sendWhatsApp(ERROR_NUMBER, text);
}

async function sendDailySummary() {
    const now = new Date();
    const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const hour = israelTime.getHours();
    const todayStr = israelTime.toISOString().split('T')[0];

    // Only send at 18:xx Israel time, and only once per day
    if (hour !== 18) return;
    if (lastSummarySentDate === todayStr) return;
    lastSummarySentDate = todayStr;

    log('📲 Preparing daily summary...');

    try {
        const tasks = await getUpcomingTasks(process.env.DATABASE_ID);

        let text;
        if (tasks.length === 0) {
            text = '📚 סיכום יומי — אין משימות פתוחות ✨';
        } else {
            // Group tasks by due date
            const byDate = {};
            for (const t of tasks) {
                const date = t.dueDate || 'ללא תאריך';
                if (!byDate[date]) byDate[date] = [];
                byDate[date].push(t);
            }

            const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
            const lines = ['📚 סיכום יומי — כל המשימות הפתוחות:\n'];

            for (const [date, dateTasks] of Object.entries(byDate)) {
                if (date === 'ללא תאריך') {
                    lines.push(`📅 *ללא תאריך*`);
                } else {
                    const d = new Date(date + 'T00:00:00');
                    const dayName = dayNames[d.getDay()];
                    const formatted = `${d.getDate()}/${d.getMonth() + 1}`;
                    lines.push(`📅 *יום ${dayName} ${formatted}*`);
                }
                for (const t of dateTasks) {
                    lines.push(`  • ${t.subject}: ${t.task}`);
                }
                lines.push('');
            }

            text = lines.join('\n').trim();
        }

        for (const number of SUMMARY_NUMBERS) {
            await sendWhatsApp(number, text);
        }
        log('📲 Daily summary sent successfully');
        return true;
    } catch (err) {
        logErr(`📲 Failed to send daily summary: ${err.message}`);
        return false;
    }
}

module.exports = { setClient, sendError, sendDailySummary };
