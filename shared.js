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
        const prompt = `You are an educational assistant. Analyze the following WhatsApp messages from a school group named "${chatName}".
                        Today is ${dayOfWeek}, ${today}.
                        Content: "${fullText}"

                        If these messages describe a school task, homework, or test, extract the details into this JSON format:
                        {"is_homework": true, "task": "task description in Hebrew including the due date if mentioned", "due_date": "YYYY-MM-DD or null if not mentioned"}.
                        If it is NOT a task, return: {"is_homework": false}.
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