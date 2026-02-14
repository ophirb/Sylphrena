require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Client: NotionClient } = require("@notionhq/client");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });

async function processTask(fullText, chatName) {
    try {
        console.log(`🤖 Analyzing aggregated content from "${chatName}"...`);
        const today = new Date().toISOString().split('T')[0];
        const dayOfWeek = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()];
        const prompt = `You are an educational assistant analyzing WhatsApp messages from an Israeli school group named "${chatName}".
Today is ${dayOfWeek}, ${today}.
Messages: "${fullText}"

Determine if these messages contain ANY homework, assignment, test, or school task.
Be INCLUSIVE — even short messages like "צריך לפתור עמוד 70" or "מבחן ביום שלישי" count as homework.
If messages in Hebrew mention solving (לפתור), reading (לקרוא), studying (ללמוד), submitting (להגיש), preparing (להכין), or any school work — it IS homework.

IMPORTANT: Dates in Israel are dd/mm/yyyy. For example, "17.1" or "17/1" means January 17th, "5.3" means March 5th. Convert to YYYY-MM-DD for the output.

If homework found, return: {"is_homework": true, "task": "task description in Hebrew including the due date if mentioned", "due_date": "YYYY-MM-DD or null if not mentioned"}
If NOT homework, return: {"is_homework": false}
Return ONLY the raw JSON string.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        let responseText = response.text().trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
        const data = JSON.parse(responseText);

        if (data.is_homework) {
            console.log(`📝 Task identified:`, data.task);
            await createNotionTask(data.task, chatName, data.due_date, 'WhatsApp');
            console.log('✅ Notion updated successfully.');
        }
    } catch (err) {
        console.error('❌ Error processing task:', err.message);
    }
}

async function createNotionTask(taskText, subject, dueDate, source) {
    const properties = {
        'Task': { title: [{ text: { content: taskText } }] },
        'Subject': { select: { name: subject } },
        'Source': { select: { name: source } }
    };
    if (dueDate) {
        properties['Due Date'] = { date: { start: dueDate } };
    }
    await notion.pages.create({
        parent: { database_id: process.env.DATABASE_ID },
        properties
    });
}

module.exports = { processTask, createNotionTask };