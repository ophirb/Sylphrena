const express = require('express');
const { processTask } = require('./shared');

console.log('🚀 Starting Sylphrena Processor...');

const app = express();
app.use(express.json({limit: '10mb'})); // Middleware to parse JSON bodies

app.post('/', async (req, res) => {
    const messageBatches = req.body;
    if (!messageBatches || typeof messageBatches !== 'object') {
        return res.status(400).send('Bad Request: Expected a JSON object of message batches.');
    }

    console.log(`📦 Received ${Object.keys(messageBatches).length} batch(es) to process.`);

    // Process all batches concurrently without waiting for them to finish.
    for (const chatName in messageBatches) {
        const aggregatedText = messageBatches[chatName];
        processTask(aggregatedText, chatName).catch(err => {
            console.error(`Error in background task for ${chatName}:`, err);
        });
    }

    res.status(202).send('Accepted: Tasks are being processed in the background.');
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
    console.log(`🚀 Sylphrena processor listening on port ${port}`);
});