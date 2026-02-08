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
    console.log('📸 Scan this QR code:');
    qrcode.generate(qr, { small: true });
});

scanner.on('ready', async () => {
    console.log('🛡️  Scanning Group History for LIDs...');
    
    // שליפת כל הצ'אטים
    const chats = await scanner.getChats();
    const groups = chats.filter(chat => chat.isGroup);
    
    const results = [];

    for (const group of groups) {
        let derivedLid = 'Not Found (Wait for new msg)';
        
        // בדיקה 1: האם יש הודעה אחרונה בזיכרון?
        if (group.lastMessage && group.lastMessage.from) {
            // אם ההודעה התקבלה מהקבוצה, ה-from שלה הוא ה-ID שאנחנו צריכים
            if (group.lastMessage.from.includes('@lid') || group.lastMessage.from.includes('@g.us')) {
                derivedLid = group.lastMessage.from;
            }
        } 
        
        results.push({
            'שם הקבוצה': group.name,
            'ID רגיל (Standard)': group.id._serialized,
            'ID מחולץ מהיסטוריה (LID)': derivedLid
        });
    }

    console.log('\n--- 📋 תוצאות סריקת היסטוריה ---');
    console.table(results);
    console.log('--------------------------------------------------');
    console.log('✅ העתק את העמודה "ID מחולץ מהיסטוריה" לקובץ settings.json.');
    console.log('הערה: אם עדיין כתוב Not Found, הקבוצה ריקה או שההיסטוריה לא נטענה.');
});

scanner.initialize();