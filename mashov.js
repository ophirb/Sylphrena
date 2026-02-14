const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createNotionTask } = require('./shared');

const BASE_URL = 'https://web.mashov.info/api';
const DEDUP_FILENAME = 'mashov_processed.json';

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }
function logErr(...args) { console.error(`[${new Date().toISOString()}]`, ...args); }

// Persistent client instance — reused across polls to avoid repeated logins
let persistentClient = null;

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
        this.loggedIn = false;
        // Stable device ID derived from username — Mashov sees the same "device" every time
        this.deviceUuid = crypto.createHash('md5').update(`sylphrena-${username}`).digest('hex');
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
            deviceUuid: this.deviceUuid,
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

        this.csrfToken = res.headers['x-csrf-token'];
        const setCookies = res.headers['set-cookie'] || [];
        this.cookies = setCookies.map(c => c.split(';')[0]).join('; ');

        const data = res.data;
        this.userId = data.credential.userId;
        this.children = data.accessToken?.children || [];
        this.loggedIn = true;

        log(`🏫 Mashov login successful. userId=${this.userId}, children=${this.children.length}`);
        return data;
    }

    async ensureLoggedIn() {
        if (!this.loggedIn) {
            await this.login();
        }
    }

    async _authGet(url) {
        try {
            const res = await axios.get(url, {
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'x-csrf-token': this.csrfToken,
                    'Cookie': this.cookies
                }
            });
            return res.data;
        } catch (err) {
            if (err.response?.status === 401) {
                log('🏫 Session expired, re-logging in...');
                this.loggedIn = false;
                await this.login();
                const res = await axios.get(url, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'x-csrf-token': this.csrfToken,
                        'Cookie': this.cookies
                    }
                });
                return res.data;
            }
            throw err;
        }
    }

    async getHomework(studentId) {
        return this._authGet(`${BASE_URL}/students/${studentId || this.userId}/homework`);
    }

    async getGroups(studentId) {
        return this._authGet(`${BASE_URL}/students/${studentId || this.userId}/groups`);
    }

    async getMoodleAssignments(studentId) {
        return this._authGet(`${BASE_URL}/students/${studentId || this.userId}/moodle/assignments/grades`);
    }
}

function getDedupPath() {
    const sessionDir = process.env.PUPPETEER_SESSION_DIR || '/usr/src/app/puppeteer_session';
    return path.join(sessionDir, DEDUP_FILENAME);
}

function loadProcessedIds() {
    try {
        const data = fs.readFileSync(getDedupPath(), 'utf8');
        const raw = JSON.parse(data).processedIds || [];
        // Migrate old numeric lessonId keys to prefixed format
        return new Set(raw.map(id => typeof id === 'number' || /^\d+$/.test(id) ? `hw_${id}` : id));
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

    // Reuse persistent client — only creates a new one on first call
    if (!persistentClient) {
        persistentClient = new MashovClient({
            semel: MASHOV_SCHOOL_SEMEL,
            year: MASHOV_YEAR,
            username: MASHOV_USERNAME,
            password: MASHOV_PASSWORD
        });
    }

    try {
        await persistentClient.ensureLoggedIn();
        const processedIds = loadProcessedIds();

        const childFilter = process.env.MASHOV_CHILD_FILTER;
        let studentIds;
        if (persistentClient.children.length > 0) {
            let children = persistentClient.children;
            if (childFilter) {
                children = children.filter(c => c.privateName && c.privateName.includes(childFilter));
                log(`🏫 Child filter "${childFilter}": matched ${children.length} of ${persistentClient.children.length} children`);
            }
            studentIds = children.map(c => c.childGuid);
        } else {
            studentIds = [persistentClient.userId];
        }

        let newCount = 0;

        for (const studentId of studentIds) {
            // --- Homework ---
            const homework = await persistentClient.getHomework(studentId);
            log(`🏫 Fetched ${homework.length} homework item(s) for student ${studentId}`);

            for (const item of homework) {
                const dedupKey = `hw_${item.lessonId}`;
                if (processedIds.has(dedupKey)) continue;
                if (!item.homework || item.homework.trim() === '') continue;

                try {
                    const text = item.homework.trim();
                    const isMoodle = /מודל|moodle/i.test(text);
                    const source = isMoodle ? 'Mashov-Moodle' : 'Mashov';
                    const dueDate = item.lessonDate ? item.lessonDate.split('T')[0] : null;
                    await createNotionTask(text, item.subjectName || 'Unknown', dueDate, source);
                    processedIds.add(dedupKey);
                    newCount++;
                    log(`🏫 ✅ New homework: [${item.subjectName}] "${text.slice(0, 60)}"`);
                } catch (err) {
                    logErr(`🏫 ❌ Failed to create Notion task for lessonId=${item.lessonId}:`, err.message);
                }
            }

            // --- Moodle assignments ---
            try {
                const [assignments, groups] = await Promise.all([
                    persistentClient.getMoodleAssignments(studentId),
                    persistentClient.getGroups(studentId)
                ]);
                const subjectMap = {};
                for (const g of groups) subjectMap[g.groupId] = g.subjectName;

                log(`🏫 Fetched ${assignments.length} Moodle assignment(s) for student ${studentId}`);

                for (const item of assignments) {
                    const dedupKey = `moodle_${item.itemId}`;
                    if (processedIds.has(dedupKey)) continue;

                    try {
                        const subject = subjectMap[item.groupId] || item.groupName || 'Unknown';
                        const dueDate = item.endTime && item.endTime > 0
                            ? new Date(item.endTime * 1000).toISOString().split('T')[0]
                            : null;
                        await createNotionTask(item.itemName, subject, dueDate, 'Mashov-Moodle');
                        processedIds.add(dedupKey);
                        newCount++;
                        log(`🏫 ✅ New Moodle task: [${subject}] "${item.itemName.slice(0, 60)}"`);
                    } catch (err) {
                        logErr(`🏫 ❌ Failed to create Notion task for moodle itemId=${item.itemId}:`, err.message);
                    }
                }
            } catch (err) {
                logErr(`🏫 ⚠️ Moodle assignments fetch failed for student ${studentId}:`, err.message);
            }
        }

        saveProcessedIds(processedIds);
        log(`🏫 Mashov polling complete. ${newCount} new item(s) added.`);
    } catch (err) {
        logErr('🏫 ❌ Mashov polling error:', err.message);
        // Reset client on unrecoverable errors so next poll retries login
        persistentClient.loggedIn = false;
    }
}

module.exports = { pollMashov };
