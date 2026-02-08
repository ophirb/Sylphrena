require('dotenv').config();
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const qrcode = require('qrcode-terminal');
const { Client: NotionClient } = require("@notionhq/client");

console.log('🚀 Starting Sylphrena (Universal ID Mode)...');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });

// ניהול זיכרון לצבירת הודעות (Aggregation)
const messageQueues = {}; 
// const DEBOUNCE_TIME = 360000; // 6 דקות
const DEBOUNCE_TIME = 360; // 6 דקות

let settings = { authorizedGroups: [] };
if (fs.existsSync('./settings.json')) {
    try {
        settings = JSON.parse(fs.readFileSync('./settings.json'));
    } catch (e) {
        console.error('Error reading settings.json');
    }
}

const whatsapp = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
});

whatsapp.on('qr', qr => {
    console.log('📸 Scan this QR code:');
    qrcode.generate(qr, { small: true });
});

whatsapp.on('ready', () => {
    console.log('🛡️ Sylphrena is ready. You can use standard @g.us IDs now.');
});

whatsapp.on('message_create', async (msg) => {
    // שלב 1: התעלמות מהודעות מערכת
    if (msg.body.startsWith('!')) return;

    // שלב 2: שליפת אובייקט הצ'אט כדי לקבל את ה-ID האמיתי
    const chat = await msg.getChat();
    
    // זה התיקון הגדול: אנחנו בודקים את ה-ID הקבוע של הקבוצה, לא של ההודעה
    const trueGroupId = chat.id._serialized; 

    // לוג דיאגנוסטי כדי שתהיה רגוע
    console.log(`DEBUG: Msg from ${msg.from} -> Mapped to Group: ${trueGroupId}`);

    // בדיקה מול הרשימה המאושרת (עכשיו זה יעבוד עם @g.us)
    if (!settings.authorizedGroups.includes(trueGroupId)) return;

    const chatName = chat.name || "קבוצה ללא שם";
    const content = msg.body || msg.caption || "";
    
    if (content.length < 2) return;

    // --- מכאן הכל אותו דבר (מנגנון הצבירה) ---
    if (!messageQueues[trueGroupId]) {
        messageQueues[trueGroupId] = {
            messages: [],
            timer: null
        };
    }

    messageQueues[trueGroupId].messages.push(content);
    console.log(`📥 [${chatName}] Message captured. Queue size: ${messageQueues[trueGroupId].messages.length}`);

    if (messageQueues[trueGroupId].timer) clearTimeout(messageQueues[trueGroupId].timer);

    messageQueues[trueGroupId].timer = setTimeout(async () => {
        const aggregatedText = messageQueues[trueGroupId].messages.join('\n');
        delete messageQueues[trueGroupId];

        await processTask(aggregatedText, chatName);
    }, DEBOUNCE_TIME);
});

async function processTask(fullText, chatName) {
    try {
        console.log(`🤖 Analyzing aggregated content from "${chatName}"...`);
        // ... (אותו קוד Gemini ו-Notion כמו קודם)
        const prompt = `You are an educational assistant. Analyze the following WhatsApp messages from a school group named "${chatName}".
                        Context: Use the group name to infer the subject.
                        Content: "${fullText}"
                        
                        If these messages describe a school task, homework, or test, extract the details into this JSON format:
                        {"is_homework": true, "subject": "the subject in Hebrew", "task": "short task description in Hebrew", "due_date": "YYYY-MM-DD or null if not mentioned"}.
                        If it is NOT a task, return: {"is_homework": false}.
                        Return ONLY the raw JSON string.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        let responseText = response.text().trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
        const data = JSON.parse(responseText);

        if (data.is_homework) {
            console.log(`📝 Task identified:`, data.task);
            await notion.pages.create({
                parent: { database_id: process.env.DATABASE_ID },
                properties: {
                    'Task': { title: [{ text: { content: data.task } }] },
                    'Subject': { select: { name: data.subject || chatName } },
                    'Due Date': data.due_date ? { date: { start: data.due_date } } : undefined,
                    'Source': { select: { name: 'WhatsApp' } }
                }
            });
            console.log('✅ Notion updated successfully.');
        }
    } catch (err) {
        console.error('❌ Error:', err.message);
    }
}

whatsapp.initialize();