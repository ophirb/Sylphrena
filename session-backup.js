const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BUCKET = process.env.SESSION_BACKUP_BUCKET;
const SESSION_DIR = process.env.PUPPETEER_SESSION_DIR || '/usr/src/app/puppeteer_session';
const AUTH_DIR = path.join(SESSION_DIR, 'wwebjs_auth');
const BACKUP_TAR = '/tmp/wwebjs_auth_backup.tar.gz';
const GCS_OBJECT = 'wwebjs_auth.tar.gz';

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }
function logErr(...args) { console.error(`[${new Date().toISOString()}]`, ...args); }

async function getGCSToken() {
    const res = await axios.get(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' } }
    );
    return res.data.access_token;
}

async function backupSession() {
    if (!BUCKET) return;
    if (!fs.existsSync(AUTH_DIR)) {
        log('💾 Session backup: no auth dir found, skipping');
        return;
    }
    try {
        execSync(
            `tar czf ${BACKUP_TAR} ` +
            `--exclude='*/Cache' --exclude='*/GPUCache' ` +
            `--exclude='*/Code Cache' --exclude='*/blob_storage' ` +
            `-C ${SESSION_DIR} wwebjs_auth`
        );
        const token = await getGCSToken();
        const data = fs.readFileSync(BACKUP_TAR);
        await axios.put(
            `https://storage.googleapis.com/${BUCKET}/${GCS_OBJECT}`,
            data,
            {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/gzip' },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            }
        );
        fs.unlinkSync(BACKUP_TAR);
        const sizeMB = (data.length / 1024 / 1024).toFixed(1);
        log(`💾 Session backed up to gs://${BUCKET}/${GCS_OBJECT} (${sizeMB}MB)`);
    } catch (err) {
        logErr(`💾 Session backup failed: ${err.message}`);
        try { fs.unlinkSync(BACKUP_TAR); } catch {}
    }
}

async function restoreSession() {
    if (!BUCKET) return;
    if (fs.existsSync(AUTH_DIR)) {
        log('💾 Session restore: local session exists, skipping');
        return;
    }
    log('💾 No local session — attempting restore from GCS...');
    try {
        const token = await getGCSToken();
        const res = await axios.get(
            `https://storage.googleapis.com/${BUCKET}/${GCS_OBJECT}`,
            { headers: { 'Authorization': `Bearer ${token}` }, responseType: 'arraybuffer' }
        );
        fs.writeFileSync(BACKUP_TAR, Buffer.from(res.data));
        execSync(`tar xzf ${BACKUP_TAR} -C ${SESSION_DIR}`);
        fs.unlinkSync(BACKUP_TAR);
        log(`💾 Session restored from gs://${BUCKET}/${GCS_OBJECT} — no QR scan needed`);
    } catch (err) {
        if (err.response?.status === 404) {
            log('💾 No backup found in GCS — fresh session, QR scan required');
        } else {
            logErr(`💾 Session restore failed: ${err.message}`);
        }
    }
}

module.exports = { backupSession, restoreSession };
