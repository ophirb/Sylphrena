#!/usr/bin/env node
'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { execSync, spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ONBOARD_SESSION_DIR = path.join(__dirname, '.wwebjs_onboard');
const SECRET_NAME = 'authorized-groups';
const DEFAULT_VM_NAME = 'sylphrena-listener-vm';
const DEFAULT_ZONE = 'us-central1-a';
const QR_TIMEOUT_MS = 120_000;


// --- Helpers ---

function runGcloud(cmd) {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function askQuestion(rl, question) {
    return new Promise(resolve => rl.question(question, resolve));
}

function parseNumbers(input, max) {
    const nums = input.split(',').map(s => parseInt(s.trim(), 10));
    const invalid = nums.filter(n => isNaN(n) || n < 1 || n > max);
    if (invalid.length > 0) return null;
    return nums;
}

function streamVmLogs(vmName, zone, projectId) {
    return new Promise((resolve) => {
        const child = spawn('gcloud', [
            'compute', 'ssh', vmName,
            `--zone=${zone}`, `--project=${projectId}`,
            '--command', `sudo docker logs -f ${vmName}`
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        const READY_MSG = 'Sylphrena Listener is ready';
        const TIMEOUT_MS = 300_000;

        const timeout = setTimeout(() => {
            console.log('\nLog stream timed out (5 min). The VM is still running.');
            child.kill();
            resolve();
        }, TIMEOUT_MS);

        function onData(data) {
            process.stdout.write(data);
            if (data.toString().includes(READY_MSG)) {
                clearTimeout(timeout);
                console.log('\nListener is ready — disconnecting from logs.\n');
                child.kill();
                resolve();
            }
        }

        child.stdout.on('data', onData);
        child.stderr.on('data', onData);

        child.on('close', () => {
            clearTimeout(timeout);
            resolve();
        });
    });
}

// --- Phase 0: Preflight ---

function checkPrereqs() {
    console.log('\n--- Preflight Checks ---\n');

    try {
        runGcloud('gcloud --version');
    } catch {
        console.error('gcloud CLI not found. Install it from https://cloud.google.com/sdk/docs/install');
        process.exit(1);
    }

    const projectId = runGcloud('gcloud config get-value project 2>/dev/null');
    if (!projectId) {
        console.error('No GCP project configured. Run: gcloud config set project <PROJECT_ID>');
        process.exit(1);
    }
    console.log(`GCP Project: ${projectId}`);

    try {
        runGcloud(`gcloud secrets describe ${SECRET_NAME} --project=${projectId} 2>/dev/null`);
    } catch {
        console.error(`Cannot access secret "${SECRET_NAME}". Check that:\n  - You are authenticated: gcloud auth login\n  - You have secretmanager.secretAccessor role on the project`);
        process.exit(1);
    }

    console.log('All preflight checks passed.\n');
    return projectId;
}

// --- Phase 1: Fetch Existing Groups ---

function fetchExistingGroups(projectId) {
    try {
        const raw = runGcloud(`gcloud secrets versions access latest --secret=${SECRET_NAME} --project=${projectId}`);
        const groups = new Set(raw.split(',').filter(Boolean));
        if (groups.size > 0) {
            console.log(`Currently authorized groups (${groups.size}):`);
            for (const id of groups) {
                console.log(`  - ${id}`);
            }
        } else {
            console.log('No groups currently authorized.');
        }
        return groups;
    } catch {
        console.log('No existing authorized groups found (new setup).');
        return new Set();
    }
}

// --- Phase 2: WhatsApp Connection ---

async function connectWhatsApp() {
    console.log('\n--- Connecting to WhatsApp ---\n');

    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: ONBOARD_SESSION_DIR
        }),
        puppeteer: {
            headless: true,
            protocolTimeout: 120_000,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        }
    });

    let qrShown = false;

    client.on('qr', qr => {
        qrShown = true;
        console.log('Scan this QR code with WhatsApp:\n');
        qrcode.generate(qr, { small: true });
        console.log('Waiting for authentication...\n');
    });

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            client.destroy().catch(() => {});
            reject(new Error('QR code scan timed out after 2 minutes. Please try again.'));
        }, QR_TIMEOUT_MS);

        client.on('ready', () => {
            clearTimeout(timeout);
            resolve();
        });

        client.on('auth_failure', (msg) => {
            clearTimeout(timeout);
            reject(new Error(`Authentication failed: ${msg}`));
        });

        client.initialize().catch(err => {
            clearTimeout(timeout);
            reject(err);
        });
    });

    if (!qrShown) {
        console.log('Reusing saved session (no QR scan needed).');
    }
    console.log('WhatsApp connected.\n');

    console.log('Fetching group list...');
    const allChats = await client.getChats();
    const groups = allChats.filter(chat => chat.isGroup);
    groups.sort((a, b) => a.name.localeCompare(b.name));

    console.log(`Found ${groups.length} group(s).\n`);

    // Disconnect immediately — we have all the data we need
    await client.destroy();

    return groups;
}

// --- Phase 3: Display Groups ---

function generateHtml(groups, existingGroups) {
    const rows = groups.map((g, i) => {
        const id = g.id._serialized;
        const authorized = existingGroups.has(id);
        const cls = authorized ? ' class="auth"' : '';
        const tag = authorized ? 'V' : '';
        return `<tr${cls}><td>${i + 1}</td><td>${tag}</td><td dir="auto">${g.name}</td><td>${id}</td></tr>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="he" dir="ltr">
<head>
<meta charset="utf-8">
<title>Sylphrena - WhatsApp Groups</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 1000px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 1.4em; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 6px 12px; border: 1px solid #ddd; text-align: left; }
  th { background: #f5f5f5; }
  td:nth-child(1) { width: 40px; text-align: center; }
  td:nth-child(2) { width: 30px; text-align: center; color: green; font-weight: bold; }
  td:nth-child(3) { direction: rtl; unicode-bidi: plaintext; }
  td:nth-child(4) { font-family: monospace; font-size: 0.85em; color: #666; }
  tr.auth { background: #e8f5e9; }
  #filter { padding: 8px; width: 300px; margin-bottom: 12px; font-size: 1em; }
</style>
</head>
<body>
<h1>Sylphrena - WhatsApp Groups (${groups.length})</h1>
<p>Use the # column to select groups in the terminal.</p>
<input id="filter" type="text" placeholder="Filter groups..." autofocus>
<table>
<thead><tr><th>#</th><th>Auth</th><th>Group Name</th><th>Group ID</th></tr></thead>
<tbody id="groups">
${rows}
</tbody>
</table>
<script>
document.getElementById('filter').addEventListener('input', function() {
  const q = this.value.toLowerCase();
  document.querySelectorAll('#groups tr').forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});
</script>
</body>
</html>`;
}

function displayGroups(groups, existingGroups) {
    // Write HTML file and open in browser for proper Hebrew rendering
    const htmlPath = path.join(os.tmpdir(), 'sylphrena-groups.html');
    fs.writeFileSync(htmlPath, generateHtml(groups, existingGroups));
    execSync(`open "${htmlPath}"`);
    console.log(`Group list opened in browser (${htmlPath})`);
    console.log('Use the browser to find group numbers, then enter them here.\n');

    // Also print a compact terminal list (numbers + IDs only)
    console.log('--- WhatsApp Groups (terminal reference) ---\n');
    for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const id = g.id._serialized;
        const tag = existingGroups.has(id) ? '*' : ' ';
        const num = String(i + 1).padStart(3);
        console.log(`  ${num}.${tag} ${id}`);
    }
    console.log('\n  * = currently authorized\n');
}

// --- Phase 4: Action Menu ---

async function promptAction(rl) {
    while (true) {
        const answer = (await askQuestion(rl,
            'What would you like to do? (a)dd groups, (r)emove groups, (q)uit: '
        )).trim().toLowerCase();

        if (answer === 'a' || answer === 'add') return 'add';
        if (answer === 'r' || answer === 'remove') return 'remove';
        if (answer === 'q' || answer === 'quit') return 'quit';
        console.log('Invalid choice. Enter a, r, or q.\n');
    }
}

// --- Phase 5: Add Groups ---

async function handleAdd(rl, groups, existingGroups) {
    const notAuthorized = groups.filter(g => !existingGroups.has(g.id._serialized));

    if (notAuthorized.length === 0) {
        console.log('\nAll groups are already authorized. Nothing to add.\n');
        return null;
    }

    console.log('\nGroups available to add:\n');
    for (let i = 0; i < notAuthorized.length; i++) {
        const g = notAuthorized[i];
        const num = String(i + 1).padStart(3);
        console.log(`  ${num}. (${g.id._serialized}) ${g.name}`);
    }
    console.log('');

    while (true) {
        const answer = (await askQuestion(rl,
            'Enter group numbers to add (comma-separated, e.g. 1,3), "all", or "b" to go back: '
        )).trim().toLowerCase();

        if (answer === 'b' || answer === 'back') return null;

        if (answer === 'all') {
            const merged = new Set(existingGroups);
            for (const g of notAuthorized) merged.add(g.id._serialized);
            console.log(`\nGroups to add (${notAuthorized.length}):`);
            for (const g of notAuthorized) {
                console.log(`  + (${g.id._serialized}) ${g.name}`);
            }
            console.log(`Total authorized after update: ${merged.size}`);
            return merged;
        }

        const nums = parseNumbers(answer, notAuthorized.length);
        if (!nums) {
            console.log(`Invalid selection. Enter numbers between 1 and ${notAuthorized.length}.\n`);
            continue;
        }

        const selected = nums.map(n => notAuthorized[n - 1]);
        const merged = new Set(existingGroups);
        for (const g of selected) merged.add(g.id._serialized);

        console.log(`\nGroups to add (${selected.length}):`);
        for (const g of selected) {
            console.log(`  + (${g.id._serialized}) ${g.name}`);
        }
        console.log(`Total authorized after update: ${merged.size}`);
        return merged;
    }
}

// --- Phase 6: Remove Groups ---

async function handleRemove(rl, groups, existingGroups) {
    if (existingGroups.size === 0) {
        console.log('\nNo groups are currently authorized. Nothing to remove.\n');
        return null;
    }

    // Build display list — match IDs to names where possible
    const groupMap = new Map(groups.map(g => [g.id._serialized, g.name]));
    const authorizedList = [...existingGroups];

    console.log('\nCurrently authorized groups:\n');
    for (let i = 0; i < authorizedList.length; i++) {
        const id = authorizedList[i];
        const name = groupMap.get(id) || '(unknown group)';
        const num = String(i + 1).padStart(3);
        console.log(`  ${num}. (${id}) ${name}`);
    }
    console.log('');

    while (true) {
        const answer = (await askQuestion(rl,
            'Enter group numbers to remove (comma-separated, e.g. 1,3), or "b" to go back: '
        )).trim().toLowerCase();

        if (answer === 'b' || answer === 'back') return null;

        const nums = parseNumbers(answer, authorizedList.length);
        if (!nums) {
            console.log(`Invalid selection. Enter numbers between 1 and ${authorizedList.length}.\n`);
            continue;
        }

        const toRemove = new Set(nums.map(n => authorizedList[n - 1]));
        const remaining = new Set([...existingGroups].filter(id => !toRemove.has(id)));

        console.log(`\nGroups to remove (${toRemove.size}):`);
        for (const id of toRemove) {
            const name = groupMap.get(id) || '(unknown group)';
            console.log(`  - (${id}) ${name}`);
        }
        console.log(`Total authorized after update: ${remaining.size}`);
        return remaining;
    }
}

// --- Phase 7: Update Secret Manager ---

function updateSecret(projectId, allGroupIds) {
    const value = [...allGroupIds].join(',');
    try {
        execSync(
            `gcloud secrets versions add ${SECRET_NAME} --data-file=- --project=${projectId}`,
            { input: value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        console.log('Secret Manager updated successfully.\n');
    } catch (err) {
        console.error('Failed to update Secret Manager. Check that you have roles/secretmanager.secretVersionManager.');
        console.error(err.message);
    }
}

// --- Phase 8: Restart VM & Authenticate ---

async function restartAndAuth(rl, projectId) {
    const answer = (await askQuestion(rl, 'Restart the listener VM to pick up changes? (y/n): ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
        console.log('Skipping. Remember to restart the VM manually for changes to take effect.\n');
        return;
    }

    const vmName = (await askQuestion(rl, `VM name [${DEFAULT_VM_NAME}]: `)).trim() || DEFAULT_VM_NAME;
    const zone = (await askQuestion(rl, `Zone [${DEFAULT_ZONE}]: `)).trim() || DEFAULT_ZONE;

    // Step 1: Reset the VM
    console.log(`Restarting ${vmName} in ${zone}...`);
    try {
        runGcloud(`gcloud compute instances reset ${vmName} --zone=${zone} --project=${projectId}`);
        console.log('VM restarted.\n');
    } catch (err) {
        console.error('Failed to restart VM:', err.message);
        console.error(`You can restart manually: gcloud compute instances reset ${vmName} --zone=${zone} --project=${projectId}\n`);
        return;
    }

    // Step 2: Wait for container to start, then stream logs for QR scan
    const scanAnswer = (await askQuestion(rl, 'Stream VM logs to scan the QR code from here? (y/n): ')).trim().toLowerCase();
    if (scanAnswer !== 'y' && scanAnswer !== 'yes') {
        console.log(`You can scan later by running:\n  gcloud compute ssh ${vmName} --zone=${zone} --command="sudo docker logs -f ${vmName}"\n`);
        return;
    }

    console.log('Waiting 60 seconds for the container to start...');
    execSync('sleep 60');

    console.log('Streaming VM logs — scan the QR code with WhatsApp.\n');
    await streamVmLogs(vmName, zone, projectId);
}

// --- Scan-only mode: just stream VM logs for QR code ---

async function scanOnly() {
    console.log('========================================');
    console.log('   Sylphrena — Stream VM Logs (QR Scan)');
    console.log('========================================\n');

    const projectId = checkPrereqs();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const vmName = (await askQuestion(rl, `VM name [${DEFAULT_VM_NAME}]: `)).trim() || DEFAULT_VM_NAME;
        const zone = (await askQuestion(rl, `Zone [${DEFAULT_ZONE}]: `)).trim() || DEFAULT_ZONE;

        const restartAnswer = (await askQuestion(rl, 'Restart the VM first? (y/n) [n]: ')).trim().toLowerCase();
        if (restartAnswer === 'y' || restartAnswer === 'yes') {
            console.log(`Restarting ${vmName} in ${zone}...`);
            try {
                runGcloud(`gcloud compute instances reset ${vmName} --zone=${zone} --project=${projectId}`);
                console.log('VM restarted. Waiting 60 seconds for the container to start...');
                execSync('sleep 60');
            } catch (err) {
                console.error('Failed to restart VM:', err.message);
                return;
            }
        }

        console.log('\nStreaming VM logs — scan the QR code with WhatsApp.\n');
        await streamVmLogs(vmName, zone, projectId);
    } finally {
        rl.close();
    }
}

// --- Main ---

async function main() {
    console.log('========================================');
    console.log('   Sylphrena Onboarding Tool');
    console.log('========================================');

    const projectId = checkPrereqs();
    const existingGroups = fetchExistingGroups(projectId);

    const groups = await connectWhatsApp();

    if (groups.length === 0) {
        console.log('No groups found. Make sure the WhatsApp account is added to at least one group.');
        return;
    }

    displayGroups(groups, existingGroups);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    try {
        const action = await promptAction(rl);
        if (action === 'quit') {
            console.log('Cancelled.');
            return;
        }

        let updatedSet;
        if (action === 'add') {
            updatedSet = await handleAdd(rl, groups, existingGroups);
        } else {
            updatedSet = await handleRemove(rl, groups, existingGroups);
        }

        if (!updatedSet) {
            console.log('No changes made.');
            return;
        }

        const confirm = (await askQuestion(rl, '\nUpdate Secret Manager? (y/n): ')).trim().toLowerCase();
        if (confirm !== 'y' && confirm !== 'yes') {
            console.log('Cancelled. No changes made.\n');
            return;
        }

        updateSecret(projectId, updatedSet);
        await restartAndAuth(rl, projectId);

        console.log('Done. Onboarding complete.');
    } finally {
        rl.close();
    }
}

// --- Sign-out mode: clear VM session so a different user can link ---

async function signOut() {
    console.log('========================================');
    console.log('   Sylphrena — Sign Out WhatsApp');
    console.log('========================================\n');

    const projectId = checkPrereqs();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const vmName = (await askQuestion(rl, `VM name [${DEFAULT_VM_NAME}]: `)).trim() || DEFAULT_VM_NAME;
        const zone = (await askQuestion(rl, `Zone [${DEFAULT_ZONE}]: `)).trim() || DEFAULT_ZONE;

        const confirm = (await askQuestion(rl,
            'This will sign out the current WhatsApp account everywhere.\nYou will need to scan QR codes with the new account afterward.\nContinue? (y/n): '
        )).trim().toLowerCase();

        if (confirm !== 'y' && confirm !== 'yes') {
            console.log('Cancelled.');
            return;
        }

        // Clear local onboard session
        console.log('Clearing local session...');
        if (fs.existsSync(ONBOARD_SESSION_DIR)) {
            fs.rmSync(ONBOARD_SESSION_DIR, { recursive: true, force: true });
            console.log('  Local session cleared.');
        } else {
            console.log('  No local session found.');
        }

        // Clear authorized groups from Secret Manager
        console.log('Clearing authorized groups...');
        try {
            execSync(
                `gcloud secrets versions add ${SECRET_NAME} --data-file=- --project=${projectId}`,
                { input: '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            console.log('  Authorized groups cleared.');
        } catch (err) {
            console.error('  Failed to clear authorized groups:', err.message);
        }

        // Clear VM session
        console.log('Clearing VM session...');
        try {
            runGcloud(
                `gcloud compute ssh ${vmName} --zone=${zone} --project=${projectId} --command=` +
                `"sudo docker stop ${vmName} && sudo rm -rf /var/lib/sylphrena/puppeteer_session/* && sudo docker start ${vmName}"`
            );
            console.log('  VM session cleared and container restarting.');
        } catch (err) {
            console.error('  Failed to clear VM session:', err.message);
        }

        console.log('\nFull sign-out complete (sessions + authorized groups).');
        console.log('To set up a new user:');
        console.log('  1. npm run scan     — scan QR with the new WhatsApp account (VM bot)');
        console.log('  2. npm run onboard  — scan QR again to manage groups (local tool)\n');
    } finally {
        rl.close();
    }
}

// --- Entry point ---

const command = process.argv[2];

if (command === 'scan') {
    scanOnly().catch(err => {
        console.error('Fatal error:', err.message);
        process.exit(1);
    });
} else if (command === 'signout') {
    signOut().catch(err => {
        console.error('Fatal error:', err.message);
        process.exit(1);
    });
} else {
    main().catch(err => {
        console.error('Fatal error:', err.message);
        process.exit(1);
    });
}
