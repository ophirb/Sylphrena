const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createNotionTask } = require('./shared');

const BASE_URL = 'https://web.mashov.info/api';
const DEDUP_FILENAME = 'mashov_processed.json';

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }
function logErr(...args) { console.error(`[${new Date().toISOString()}]`, ...args); }

class MashovClient {
    constructor({ semel, year, username, password }) {
        this.semel = Number(semel);
        this.year = Number(year);
        this.username = username;
        this.password = password;
        this.csrfToken = null;
        this.cookies = null;
        this.userId = null;
        this.children = [];
    }

    async login() {
        const res = await axios.post(`${BASE_URL}/login`, {
            semel: this.semel,
            year: this.year,
            username: this.username,
            password: this.password,
            appName: 'info.mashov.students',
            apiVersion: '3.20200528',
            appVersion: '3.20200528',
            appBuild: '3.20200528',
            deviceUuid: 'chrome',
            devicePlatform: 'chrome',
            deviceManufacturer: 'win',
            deviceModel: 'desktop',
            deviceVersion: '120.0.0.0'
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*'
            }
        });

        // Extract CSRF token from response headers
        this.csrfToken = res.headers['x-csrf-token'];

        // Extract cookies from set-cookie headers
        const setCookies = res.headers['set-cookie'] || [];
        this.cookies = setCookies.map(c => c.split(';')[0]).join('; ');

        const data = res.data;
        this.userId = data.credential.userId;
        this.children = data.accessToken?.children || [];

        log(`🏫 Mashov login successful. userId=${this.userId}, children=${this.children.length}`);
        return data;
    }

    async getHomework(studentId) {
        const id = studentId || this.userId;
        const res = await axios.get(`${BASE_URL}/students/${id}/homework`, {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'x-csrf-token': this.csrfToken,
                'Cookie': this.cookies
            }
        });
        return res.data;
    }

    async logout() {
        try {
            await axios.get(`${BASE_URL}/logout`, {
                headers: {
                    'x-csrf-token': this.csrfToken,
                    'Cookie': this.cookies
                }
            });
        } catch (err) {
            // Logout failures are non-critical
            logErr('🏫 Mashov logout error (non-critical):', err.message);
        }
    }
}

function getDedupPath() {
    const sessionDir = process.env.PUPPETEER_SESSION_DIR || '/usr/src/app/puppeteer_session';
    return path.join(sessionDir, DEDUP_FILENAME);
}

function loadProcessedIds() {
    try {
        const data = fs.readFileSync(getDedupPath(), 'utf8');
        return new Set(JSON.parse(data).processedIds || []);
    } catch {
        return new Set();
    }
}

function saveProcessedIds(ids) {
    fs.writeFileSync(getDedupPath(), JSON.stringify({ processedIds: [...ids] }));
}

async function pollMashov() {
    const { MASHOV_USERNAME, MASHOV_PASSWORD, MASHOV_SCHOOL_SEMEL, MASHOV_YEAR } = process.env;
    if (!MASHOV_USERNAME || !MASHOV_PASSWORD || !MASHOV_SCHOOL_SEMEL || !MASHOV_YEAR) {
        logErr('🏫 Mashov polling skipped: missing credentials');
        return;
    }

    log('🏫 Mashov polling started...');

    const client = new MashovClient({
        semel: MASHOV_SCHOOL_SEMEL,
        year: MASHOV_YEAR,
        username: MASHOV_USERNAME,
        password: MASHOV_PASSWORD
    });

    try {
        const loginData = await client.login();
        const processedIds = loadProcessedIds();

        // Determine which student IDs to fetch homework for
        // If MASHOV_CHILD_FILTER is set, only process children whose privateName contains the filter
        const childFilter = process.env.MASHOV_CHILD_FILTER;
        let studentIds;
        if (client.children.length > 0) {
            let children = client.children;
            if (childFilter) {
                children = children.filter(c => c.privateName && c.privateName.includes(childFilter));
                log(`🏫 Child filter "${childFilter}": matched ${children.length} of ${client.children.length} children`);
            }
            studentIds = children.map(c => c.childGuid);
        } else {
            studentIds = [client.userId];
        }

        let newCount = 0;

        for (const studentId of studentIds) {
            const homework = await client.getHomework(studentId);
            log(`🏫 Fetched ${homework.length} homework item(s) for student ${studentId}`);

            for (const item of homework) {
                if (processedIds.has(item.lessonId)) continue;
                if (!item.homework || item.homework.trim() === '') continue;

                try {
                    const text = item.homework.trim();
                    const isMoodle = /מודל|moodle/i.test(text);
                    const source = isMoodle ? 'Mashov-Moodle' : 'Mashov';
                    const dueDate = item.lessonDate ? item.lessonDate.split('T')[0] : null;
                    await createNotionTask(
                        text,
                        item.subjectName || 'Unknown',
                        dueDate,
                        source
                    );
                    processedIds.add(item.lessonId);
                    newCount++;
                    log(`🏫 ✅ New homework: [${item.subjectName}] "${item.homework.slice(0, 60)}"`);
                } catch (err) {
                    logErr(`🏫 ❌ Failed to create Notion task for lessonId=${item.lessonId}:`, err.message);
                }
            }
        }

        saveProcessedIds(processedIds);
        log(`🏫 Mashov polling complete. ${newCount} new homework item(s) added.`);

        await client.logout();
    } catch (err) {
        logErr('🏫 ❌ Mashov polling error:', err.message);
    }
}

module.exports = { pollMashov };
