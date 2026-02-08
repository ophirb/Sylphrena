require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const scanner = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true, 
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    }
});

scanner.on('qr', qr => {
    console.log('📸 Scan this QR code to start scanning:');
    qrcode.generate(qr, { small: true });
});

scanner.on('ready', async () => {
    console.log('🛡️  Deep Scanner & Live Listener Ready...');
    
    // שלב 1: סריקה ראשונית של מה שקיים בזיכרון
    const chats = await scanner.getChats();
    const groups = chats.filter(chat => chat.isGroup);
    
    console.log('\n--- 📋 רשימת קבוצות קיימות (מתוך הזיכרון) ---');
    const staticResults = [];
    for (const group of groups) {
        staticResults.push({
            'שם הקבוצה': group.name,
            'ID נוכחי': group.id._serialized
        });
    }
    console.table(staticResults);
    
    console.log('\n--- 🎧 מאזין להודעות חיות (כאן יופיעו ה-LIDs המדויקים) ---');
    console.log('ברגע שתתקבל הודעה בקבוצה כלשהי, ה-ID המבצעי שלה יופיע למטה.\n');
});

// שלב 2: האזנה חיה להודעות נכנסות כדי לחלוץ LID בזמן אמת
scanner.on('message_create', async (msg) => {
    try {
        const chat = await msg.getChat();
        
        // אנחנו מעבדים רק קבוצות
        if (chat.isGroup) {
            const chatName = chat.name || "קבוצה ללא שם";
            const liveID = msg.from; // זה המזהה שבאמת משמש להעברת ההודעה ברשת

            console.log(`\n✨ הודעה התקבלה ב: "${chatName}"`);
            console.log(`📌 LID המבצעי להעתקה: ${liveID}`);
            console.log(`📅 זמן זיהוי: ${new Date().toLocaleTimeString()}`);
            console.log('-------------------------------------------');
        }
    } catch (err) {
        // התעלמות משגיאות שנובעות מהודעות מערכת או הודעות פרטיות
    }
});

scanner.initialize();