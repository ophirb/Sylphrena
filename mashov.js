const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createNotionTask } = require('./shared');
const { sendError } = require('./notify');

const BASE_URL = 'https://web.mashov.info/api';
const DEDUP_FILENAME = 'mashov_processed.json';
const SESSION_FILENAME = 'mashov_session.json';

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
        this.authToken = null;
        this.userId = null;
        this.children = [];
        this._loginPromise = null; // mutex: prevents concurrent logins
        // Stable device ID derived from username — Mashov sees the same "device" every time
        this.deviceUuid = crypto.createHash('md5').update(`sylphrena-${username}`).digest('hex');
        this._loadSession();
    }

    _getSessionPath() {
        const sessionDir = process.env.PUPPETEER_SESSION_DIR || '/usr/src/app/puppeteer_session';
        return path.join(sessionDir, SESSION_FILENAME);
    }

    _loadSession() {
        try {
            const data = JSON.parse(fs.readFileSync(this._getSessionPath(), 'utf8'));
            this.csrfToken = data.csrfToken;
            this.cookies = data.cookies;
            this.authToken = data.authToken || null;
            this.userId = data.userId;
            this.children = data.children || [];
            this.loggedIn = true;
            log(`🏫 Mashov session restored from disk (jwt=${this.authToken ? 'present' : 'missing'})`);
        } catch {
            // No saved session — will login on first poll
        }
    }

    _saveSession() {
        try {
            fs.writeFileSync(this._getSessionPath(), JSON.stringify({
                csrfToken: this.csrfToken,
                cookies: this.cookies,
                authToken: this.authToken,
                userId: this.userId,
                children: this.children
            }));
            log('🏫 Mashov session saved to disk');
        } catch (err) {
            logErr(`🏫 Failed to save Mashov session: ${err.message}`);
        }
    }

    async login() {
        // If a login is already in flight, wait for it instead of starting another
        if (this._loginPromise) {
            log('🏫 Login already in progress, waiting...');
            return this._loginPromise;
        }
        this._loginPromise = this._doLogin();
        try {
            return await this._loginPromise;
        } finally {
            this._loginPromise = null;
        }
    }

    async _doLogin() {
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

        // Extract the long-lived JWT for persistent auth
        const authCookie = setCookies.find(c => c.startsWith('MashovAuthToken='));
        this.authToken = authCookie ? authCookie.split(';')[0].split('=').slice(1).join('=') : null;

        const data = res.data;
        this.userId = data.credential.userId;
        this.children = data.accessToken?.children || [];
        this.loggedIn = true;

        this._saveSession();

        log(`🏫 Mashov login successful. userId=${this.userId}, children=${this.children.length}, jwt=${this.authToken ? 'present' : 'missing'}`);
        return data;
    }

    async ensureLoggedIn() {
        if (!this.loggedIn) {
            await this.login();
        }
    }

    async heartbeat() {
        if (!this.loggedIn) return;
        try {
            const res = await axios.get(`${BASE_URL}/students/${this.userId}/groups`, {
                headers: this._authHeaders()
            });
            this._updateCookiesFromResponse(res);
            log('🏫 Mashov heartbeat OK — session alive');
        } catch (err) {
            if (err.response?.status === 401) {
                // Server-side session expired — try JWT re-auth to silently
                // re-establish without a full login (which triggers "new device" email)
                if (this.authToken) {
                    try {
                        log('🏫 Heartbeat: session expired, trying JWT re-auth...');
                        const res = await axios.get(`${BASE_URL}/students/${this.userId}/groups`, {
                            headers: {
                                'Accept': 'application/json, text/plain, */*',
                                'Cookie': `MashovAuthToken=${this.authToken}`
                            }
                        });
                        this._updateCookiesFromResponse(res);
                        this._saveSession();
                        log('🏫 Heartbeat: JWT re-auth successful — session re-established without login');
                        return;
                    } catch (jwtErr) {
                        log('🏫 Heartbeat: JWT re-auth failed, will re-login on next poll');
                    }
                }
                this.loggedIn = false;
            } else {
                logErr(`🏫 Heartbeat failed: ${err.message}`);
            }
        }
    }

    _authHeaders() {
        const headers = { 'Accept': 'application/json, text/plain, */*' };
        if (this.csrfToken) headers['x-csrf-token'] = this.csrfToken;
        // Use full cookies when available (fresh login), JWT-only as fallback (restored session)
        headers['Cookie'] = this.cookies || (this.authToken ? `MashovAuthToken=${this.authToken}` : '');
        return headers;
    }

    // Capture refreshed cookies from API responses (like a phone app's cookie jar)
    _updateCookiesFromResponse(res) {
        const setCookies = res.headers['set-cookie'];
        if (!setCookies || setCookies.length === 0) return;

        // Merge new cookie values into existing cookies
        const cookieMap = {};
        for (const c of (this.cookies || '').split('; ').filter(Boolean)) {
            const [key] = c.split('=');
            cookieMap[key] = c;
        }
        for (const c of setCookies) {
            const value = c.split(';')[0];
            const [key] = value.split('=');
            cookieMap[key] = value;
        }
        this.cookies = Object.values(cookieMap).join('; ');

        // Update JWT if refreshed
        const authCookie = setCookies.find(c => c.startsWith('MashovAuthToken='));
        if (authCookie) {
            const newToken = authCookie.split(';')[0].split('=').slice(1).join('=');
            if (newToken !== this.authToken) {
                this.authToken = newToken;
                log('🏫 JWT refreshed from API response');
                this._saveSession();
            }
        }

        // Update CSRF token if refreshed
        const csrfCookie = setCookies.find(c => c.startsWith('Csrf-Token='));
        if (csrfCookie) {
            const newCsrf = csrfCookie.split(';')[0].split('=').slice(1).join('=');
            if (newCsrf !== this.csrfToken) this.csrfToken = newCsrf;
        }
    }

    async _authGet(url) {
        try {
            const res = await axios.get(url, { headers: this._authHeaders() });
            this._updateCookiesFromResponse(res);
            return res.data;
        } catch (err) {
            if (err.response?.status === 401 && this.authToken) {
                // Session cookies expired — try JWT-only before doing a full login
                log('🏫 Session expired, retrying with JWT...');
                try {
                    const res = await axios.get(url, {
                        headers: {
                            'Accept': 'application/json, text/plain, */*',
                            'Cookie': `MashovAuthToken=${this.authToken}`
                        }
                    });
                    this._updateCookiesFromResponse(res);
                    return res.data;
                } catch (jwtErr) {
                    log('🏫 JWT retry failed, doing full login...');
                }
            }
            if (err.response?.status === 401) {
                this.loggedIn = false;
                await this.login();
                const res = await axios.get(url, { headers: this._authHeaders() });
                this._updateCookiesFromResponse(res);
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

async function pollMashov(onComplete) {
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
        let students; // [{ id, name }]
        if (persistentClient.children.length > 0) {
            let children = persistentClient.children;
            if (childFilter) {
                children = children.filter(c => c.privateName && c.privateName.includes(childFilter));
                log(`🏫 Child filter "${childFilter}": matched ${children.length} of ${persistentClient.children.length} children`);
            }
            students = children.map(c => ({ id: c.childGuid, name: c.privateName || '' }));
        } else {
            students = [{ id: persistentClient.userId, name: '' }];
        }

        const multiChild = students.length > 1;
        let newCount = 0;

        for (const student of students) {
            const studentId = student.id;
            const namePrefix = multiChild && student.name ? `[${student.name}] ` : '';
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
                    await createNotionTask(namePrefix + text, item.subjectName || 'Unknown', dueDate, source);
                    processedIds.add(dedupKey);
                    newCount++;
                    log(`🏫 ✅ New homework: [${item.subjectName}] "${text.slice(0, 60)}"`);
                } catch (err) {
                    logErr(`🏫 ❌ Failed to create Notion task for lessonId=${item.lessonId}:`, err.message);
                }
            }

            // --- Moodle assignments (serialized to avoid concurrent 401 → double login) ---
            try {
                const groups = await persistentClient.getGroups(studentId);
                const assignments = await persistentClient.getMoodleAssignments(studentId);
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
                        await createNotionTask(namePrefix + item.itemName, subject, dueDate, 'Mashov-Moodle');
                        processedIds.add(dedupKey);
                        newCount++;
                        log(`🏫 ✅ New Moodle task: [${subject}] "${item.itemName.slice(0, 60)}"`);
                    } catch (err) {
                        logErr(`🏫 ❌ Failed to create Notion task for moodle itemId=${item.itemId}:`, err.message);
                    }
                }
            } catch (err) {
                logErr(`🏫 ⚠️ Moodle assignments fetch failed for student ${studentId}:`, err.message);
                sendError(`Moodle assignments fetch failed: ${err.message}`);
            }
        }

        saveProcessedIds(processedIds);
        log(`🏫 Mashov polling complete. ${newCount} new item(s) added.`);
        if (onComplete) onComplete();
    } catch (err) {
        logErr('🏫 ❌ Mashov polling error:', err.message);
        sendError(`Mashov polling failed: ${err.message}`);
        // Only force re-login on auth errors; other errors (network, etc.) can retry with existing session
        if (err.response?.status === 401 || err.response?.status === 403) {
            persistentClient.loggedIn = false;
        }
    }
}

function startMashovHeartbeat() {
    // Ping Mashov every 10 min to keep the session alive between 30-min polls
    const HEARTBEAT_INTERVAL = 10 * 60 * 1000;
    setInterval(() => {
        if (persistentClient) persistentClient.heartbeat();
    }, HEARTBEAT_INTERVAL);
    log(`🏫 Mashov heartbeat started (every ${HEARTBEAT_INTERVAL / 1000 / 60} min)`);
}

function saveMashovSession() {
    if (persistentClient) persistentClient._saveSession();
}

module.exports = { pollMashov, startMashovHeartbeat, saveMashovSession };
