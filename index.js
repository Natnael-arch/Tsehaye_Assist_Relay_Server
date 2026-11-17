// Local dev: run with: node -r dotenv/config index.js
// Production: set vars in Railway dashboard → Variables tab
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createTenancy, CLOSE } = require('./tenancy');
const { createLimits, REASON, pcmDurationMs } = require('./limits');

// ═══════════════════════════════════════
// ENV VAR VALIDATION
// ═══════════════════════════════════════
const REQUIRED_ENV = ['GEMINI_API_KEY', 'ADMIN_KEY'];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.error(`FATAL: Missing required env var: ${key}`);
        process.exit(1);
    }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;
const PORT = process.env.PORT || 8080;

// Traffic Light Colors
const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const GEMINI_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";
const GEMINI_MODEL_PATH = `models/${GEMINI_MODEL}`;
const TOOL_BEHAVIOR = process.env.GEMINI_TOOL_BEHAVIOR || "BLOCKING";
const GEMINI_DROP_CLIENT_TURNCOMPLETE = (process.env.GEMINI_DROP_CLIENT_TURNCOMPLETE || "0") === "1";
// Contact-name biasing is on by default; an explicit GEMINI_VOCAB_LIMIT=0 turns it off.
const GEMINI_VOCAB_LIMIT = (() => {
    const raw = process.env.GEMINI_VOCAB_LIMIT;
    const parsed = Number.parseInt(raw === undefined || raw === "" ? "20" : raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
})();
const GEMINI_LANG_HINTS = (process.env.GEMINI_LANG_HINTS || "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);

const VOCAB_ECHO_MIN_TERMS = 5;

const GEMINI_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// ═══════════════════════════════════════
// TENANCY — who may hold a Gemini session, and on how many phones at once
// ═══════════════════════════════════════
// Disabled until the tester APK sends the device headers, so today's builds keep working.
const PILOT_DATA_DIR = (() => {
    const configured = process.env.PILOT_DATA_DIR;
    if (configured) return configured;
    return fs.existsSync('/data') ? '/data' : '.';
})();
const TENANCY_ENFORCED = (process.env.TENANCY_ENFORCED || "0") === "1";
const ADMIN_PANEL_ENABLED = (process.env.ADMIN_PANEL_ENABLED || "1") === "1"; // dashboard is live; set to 0 to disable admin API
const ADMIN_PATH = process.env.ADMIN_PATH || "/admin";
const LEASE_TTL_MS = Number.parseInt(process.env.LEASE_TTL_MS || "75000", 10);

const tenancy = createTenancy({
    dataDir: PILOT_DATA_DIR,
    enforced: TENANCY_ENFORCED,
    leaseTtlMs: Number.isFinite(LEASE_TTL_MS) && LEASE_TTL_MS > 0 ? LEASE_TTL_MS : 75_000,
    notify: (kind, message) => console.log(`${YELLOW}🔔 [ALERT ${kind}] ${message}${RESET}`),
});

function identityFrom(request) {
    const h = request.headers || {};
    return {
        deviceId: String(h['x-tsehaye-device'] || ''),
        token: String(h['x-tsehaye-token'] || ''),
        signatureHash: String(h['x-tsehaye-signature'] || ''),
        appVersion: String(h['x-tsehaye-app-version'] || ''),
    };
}

// ═══════════════════════════════════════
// LIMITS — how much of the shared Gemini quota one Tester may spend
// ═══════════════════════════════════════
function envInt(name, fallback) {
    const parsed = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}
function positiveInt(name, fallback) {
    const value = envInt(name, fallback);
    return value > 0 ? value : fallback;
}

const limits = createLimits({
    dataDir: PILOT_DATA_DIR,
    notify: (kind, message) => console.log(`${YELLOW}🔔 [ALERT ${kind}] ${message}${RESET}`),
    maxLiveSessions: positiveInt('MAX_LIVE_SESSIONS', 3),
    globalDailyOpenLimit: positiveInt('GLOBAL_DAILY_OPENS', 100),
    dailyOpenLimit: positiveInt('DAILY_OPENS_PER_TESTER', 40),
    dailyAudioMinutes: positiveInt('DAILY_AUDIO_MINUTES_PER_TESTER', 20),
    // Ethiopia is UTC+3, so the allowance resets at the Tester's midnight, not at 03:00 local.
    dayOffsetMinutes: envInt('PILOT_DAY_OFFSET_MINUTES', 180),
    maxConsecutiveFailures: positiveInt('GEMINI_MAX_OPEN_FAILURES', 3),
    idleTeardownMs: positiveInt('GEMINI_IDLE_TEARDOWN_MS', 30_000),
    maxSessionMs: positiveInt('GEMINI_MAX_SESSION_MS', 15 * 60_000),
});

// Privacy masking & anonymous metric helpers
function maskText(str) {
    if (!str || typeof str !== 'string') return '';
    if (str.length <= 2) return '*'.repeat(str.length);
    return str[0] + '*'.repeat(Math.min(str.length - 2, 8)) + str[str.length - 1];
}

function maskId(id) {
    if (!id || typeof id !== 'string') return 'unidentified';
    return crypto.createHash('sha256').update(id).digest('hex').slice(0, 8);
}

function contactBucket(count) {
    if (count <= 0) return '0';
    if (count <= 20) return '1-20';
    if (count <= 50) return '21-50';
    if (count <= 100) return '51-100';
    return '100+';
}

function maskArgs(args) {
    if (!args || typeof args !== 'object') return args;
    const masked = {};
    for (const [k, v] of Object.entries(args)) {
        masked[k] = typeof v === 'string' ? maskText(v) : v;
    }
    return masked;
}

const MASTER_PROMPT = `You are Tsehaye, a voice assistant for visually impaired users. Speak only Amharic. Follow these rules exactly.

RULE 1 — CHOOSING THE RIGHT TOOL BASED ON INTENT
Determine whether the user wants to CALL someone or SEND A TEXT MESSAGE to someone. These use two completely different tools — never use the wrong one.

1a. If the user wants to CALL someone (e.g. "call X", "dial X", "ደውል"), call search_contacts immediately with just the name.

1b. If the user wants to SEND A TEXT/MESSAGE (e.g. "text X saying Y", "send a message to X", "ላክ", "መልእክት"), call send_text_message DIRECTLY with recipient_name and message_body. Do NOT call search_contacts first for a text request — send_text_message resolves the contact on its own.

1c. In both cases, for the name argument: pass exactly what you heard the user say, then add your own phonetic transliteration of that same name into both scripts separated by a comma.

Rules for what to pass as the name:
- If you heard a Latin name: pass "Latin, Amharic transliteration"
  Example: heard "Nati" → pass "Nati, ናቲ"
- If you heard an Amharic name: pass "Amharic, Latin transliteration"
  Example: heard "አበበ" → pass "አበበ, Abebe"
- Always transliterate what you actually heard — never substitute or guess a different name from memory or context.
- If the user clarifies after disambiguation, apply the same rule to whatever they said in the clarification.

RULE 2 — IF PERMISSION IS DENIED
If any tool returns 'PERMISSION_DENIED', say exactly: "I need permission to do this. Please ask someone to help you enable this in settings."

RULE 3 — AMBIGUITY (MULTIPLE MATCHES FOUND)
If search_contacts returns 'result': 'AMBIGUITY', do not pick a candidate yourself and do not call any tool. Speak every returned name back to the user in Amharic and ask them to clarify — never drop a name to save words, even if the list is long.
Use this general pattern for any number of candidates: "ከአንድ በላይ [ስም] አግኝቻለሁ - [ስም 1]፣ [ስም 2]፣ ... ወይስ [ስም N]?" — separate every name except the last with "፣", and put "ወይስ" before the final name.
After asking, do not call the tool again until the user has clearly said which name they meant.

Once the user answers with which one they mean, immediately call search_contacts (or send_text_message, whichever tool you were originally using) again with that specific person's full name. Do not restart the original request, do not re-ask what the user wants, and do not treat their answer as a brand new command — it is only clarifying which contact to use for the request already in progress.

RULE 4 — KEEP RESPONSES SHORT
Every response must be under 15 words, with one exception: when reading out the full candidate list under Rule 3, always list every name in full even if that goes over 15 words. Getting every name right matters more than brevity there, since dropping a name could mean the wrong person gets called.

RULE 5 — CONFIRMATION GATE (MANDATORY, SAFETY-CRITICAL)
This app never calls or texts anyone automatically — a human must physically confirm first. Your only job at this stage is to ask, then stay silent.

5a. When search_contacts or send_text_message returns 'result': 'PENDING_CONFIRMATION', read the 'name' field from that response (and 'message_body' too, if this is a text message).

5b. Say the confirmation question using this exact phrasing:
   - For a call: "[name] ልደውል?" (using the real name from the 'name' field)
   - For a text: read back both the 'name' and 'message_body' fields.

5c. After asking that question, end your turn immediately. Do not call any tool. Do not say anything else.

5d. While a confirmation is pending, you must not call search_contacts, add_new_contact, or send_text_message again for any reason — including if the audio is unclear or you're not sure what you heard. Staying silent is always the correct move here. Only resume normal tool use after the app sends you a new, unprompted tool call telling you the pending action was resolved.

RULE 6 — NO GREETINGS, EVER
Never introduce yourself, greet the user, or say things like "I am Tsehaye" or "How can I help you?" — not even at the very start of a new session. The user has already spoken their request by the time you receive it. Respond to that request directly, with zero preamble, every time.

RULE 7 — AFTER CONFIRMATION GATE
Once you have asked the user to confirm an action (after receiving PENDING_CONFIRMATION), you MUST wait for the user's voice response. If they say yes or any affirmative (ይሁን, አዎ, okay, correct), call confirm_pending_action with no arguments. If they say no or any negative (አይ, አይሆንም, cancel, stop), call cancel_pending_action with no arguments. Do NOT call search_contacts again. Do NOT generate a text response. Do NOT call any other tool. Just call confirm_pending_action or cancel_pending_action.
If confirm_pending_action or cancel_pending_action returns NOTHING_PENDING, say nothing and call no tool.`;

function buildSystemInstruction(contactNames) {
    return MASTER_PROMPT;
}

function getContactDisplayName(entry) {
    if (typeof entry === "string") {
        return entry;
    }
    if (!entry || typeof entry !== "object") {
        return "";
    }
    const name = entry.displayName ?? entry.display_name ?? entry["display-name"];
    return typeof name === "string" ? name : "";
}

function buildBiasing(contactNames) {
    const vocab = [];
    if (GEMINI_VOCAB_LIMIT > 0 && Array.isArray(contactNames)) {
        const seen = new Set();
        for (const entry of contactNames) {
            const name = getContactDisplayName(entry).trim();
            if (!name) {
                continue;
            }
            const key = name.toLowerCase();
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            vocab.push(name);
            if (vocab.length >= GEMINI_VOCAB_LIMIT) {
                break;
            }
        }
    }
    return { vocab, langHints: GEMINI_LANG_HINTS };
}

/**
 * Counts how many distinct biasing-vocab terms appear in a transcription, which is how we
 * detect the model "hearing" the contact list instead of the user. Whole-token only, so "Abe"
 * inside "Abeba" does not count, and each term is keyed on its first long token so a pair
 * like "Hana" / "Hana Gorebet" is one term, not two.
 */
function countVocabEcho(text, vocab) {
    if (!text || !Array.isArray(vocab) || vocab.length === 0) {
        return 0;
    }
    const split = (value) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const heard = new Set(split(text));
    const matched = new Set();
    for (const entry of vocab) {
        const key = split(getContactDisplayName(entry)).find((token) => token.length >= 3);
        if (key && heard.has(key)) {
            matched.add(key);
        }
    }
    return matched.size;
}

// ═══════════════════════════════════════
// SERVER SETUP
// ═══════════════════════════════════════
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

process.on('uncaughtException', (err) => {
    console.error(`${RED}🔴 [CRASH] UNCAUGHT EXCEPTION: ${err.message}${RESET}`, err);
});

// ═══════════════════════════════════════
// HEALTH CHECK ENDPOINT
// ═══════════════════════════════════════
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        connections: wss.clients.size,
        uptime_sec: Math.floor(process.uptime())
    });
});

app.get('/', (req, res) => {
    res.json({
        name: 'Tsehaye Assist Relay',
        version: '1.0.0',
        health: '/health'
    });
});

// ═══════════════════════════════════════
// ADMIN — approve, pause and revoke testers
// ═══════════════════════════════════════
const ADMIN_BASE = /^\/[A-Za-z0-9_-]{1,64}$/.test(process.env.ADMIN_PATH || '') ? process.env.ADMIN_PATH : '/admin';

const adminHits = new Map();
function adminRateLimited(ip) {
    const at = Date.now();
    const win = adminHits.get(ip) || { count: 0, resetAt: at + 60_000 };
    if (at > win.resetAt) { win.count = 0; win.resetAt = at + 60_000; }
    win.count += 1;
    adminHits.set(ip, win);
    return win.count > 30;
}

function keyMatches(given, expected) {
    const a = Buffer.from(String(given));
    const b = Buffer.from(String(expected));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
    // Disabled by default: an admin surface is not shipped until it has been hardened.
    if (!ADMIN_PANEL_ENABLED) return res.status(404).json({ error: 'not_found' });
    if (adminRateLimited(req.ip || 'unknown')) return res.status(429).json({ error: 'rate_limited' });
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!ADMIN_KEY || !keyMatches(given, ADMIN_KEY)) return res.status(401).json({ error: 'unauthorized' });
    next();
}

function adminAct(res, result) {
    res.status(result && result.ok ? 200 : 400).json(result || { ok: false, error: 'failed' });
}

app.use(ADMIN_BASE, express.json({ limit: '4kb' }));

app.get(`${ADMIN_BASE}/devices`, requireAdmin, (req, res) => {
    const devices = tenancy.listDevices().map((d) => ({ ...d, usage: limits.usageFor(d.deviceId) }));
    res.json({ enforced: tenancy.enforced, lease_ttl_ms: LEASE_TTL_MS, connections: wss.clients.size, devices });
});

app.get(`${ADMIN_BASE}/usage`, requireAdmin, (req, res) => res.json(limits.snapshot()));

app.post(`${ADMIN_BASE}/devices/:id/clear-hard-stop`, requireAdmin, (req, res) =>
    adminAct(res, limits.clearHardStop(req.params.id)));

app.post(`${ADMIN_BASE}/devices/:id/approve`, requireAdmin, (req, res) =>
    adminAct(res, tenancy.approve(req.params.id, (req.body && req.body.testerName) || '')));
app.post(`${ADMIN_BASE}/devices/:id/pause`, requireAdmin, (req, res) => adminAct(res, tenancy.pause(req.params.id)));
app.post(`${ADMIN_BASE}/devices/:id/resume`, requireAdmin, (req, res) => adminAct(res, tenancy.resume(req.params.id)));
app.post(`${ADMIN_BASE}/devices/:id/revoke`, requireAdmin, (req, res) => adminAct(res, tenancy.revoke(req.params.id)));
app.post(`${ADMIN_BASE}/devices/:id/forget`, requireAdmin, (req, res) => adminAct(res, tenancy.forget(req.params.id)));

// ═ ADMIN DASHBOARD ═ served at /admin/dashboard
// No middleware: the HTML page authenticates via ADMIN_KEY entered in the browser,
// which then calls the requireAdmin-protected API endpoints normally.
app.get(`${ADMIN_BASE}/dashboard`, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-dashboard.html'));
});

// ═══════════════════════════════════════
// WEBSOCKET UPGRADE HANDLER
// ═══════════════════════════════════════
server.on('upgrade', (request, socket, head) => {
    // Accept connections on /relay or root path /
    const url = request.url;
    if (url === '/relay' || url === '/') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            // Decided after the socket exists: an approval or issued token has to be delivered
            // on a live socket, or the phone can end up with a token it never received.
            wss.emit('connection', ws, request, tenancy.decide(identityFrom(request)));
        });
    } else {
        socket.destroy();
    }
});

function closeForTenant(ws, decision) {
    const reason = decision.reason || 'refused';
    const status = decision.action === 'pending' ? 'pending' : 'refused';
    try {
        ws.send(JSON.stringify({ type: 'pairing', status, reason, tester: decision.testerName || '' }));
    } catch (e) {
        console.error(`[Tenancy] Could not send pairing frame: ${e.message}`);
    }
    setTimeout(() => {
        try { ws.close(decision.closeCode || CLOSE.UNAVAILABLE, reason); } catch (e) { /* already gone */ }
    }, 250);
}

// ═══════════════════════════════════════
// WEBSOCKET CONNECTION HANDLER
// ═══════════════════════════════════════
wss.on('connection', (clientWs, request, decision) => {
    clientWs._id = Math.random().toString(36).substr(2, 9);
    console.log(`[Handshake] New Client Connected. Assigned ID: ${clientWs._id}`);
    console.log(`[RELAY] CLIENT CONNECT: id=${clientWs._id}`);

    let tenant = null;
    if (decision && decision.action !== 'serve') {
        console.log(`${YELLOW}[Tenancy] ${decision.action}: ${decision.reason} (device=${decision.deviceId || 'unidentified'})${RESET}`);
        closeForTenant(clientWs, decision);
        return;
    }
    if (decision && decision.deviceId) {
        tenant = decision;
        clientWs._tenantId = tenant.deviceId;
        clientWs._lastSeen = Date.now();
        tenancy.acquireLease(tenant.deviceId, clientWs._id);
        console.log(`${GREEN}[Tenancy] Serving "${tenant.testerName || 'unnamed'}" device=${tenant.deviceId} version=${tenant.appVersion || 'unknown'} ${tenant.issueToken ? '(token issued)' : '(token ok)'}${RESET}`);
        clientWs.send(JSON.stringify({
            type: 'pairing',
            status: 'approved',
            tester: tenant.testerName || '',
            token: tenant.issueToken || '',
        }));
    }

    let contactNames = [];
    if (request.headers['x-tsehaye-contacts']) {
        try {
            const b64 = request.headers['x-tsehaye-contacts'];
            const decoded = Buffer.from(b64, 'base64').toString('utf8');
            const parsed = JSON.parse(decoded);
            contactNames = Array.isArray(parsed) ? parsed : [];
            console.log(`📇 Loaded ${contactNames.length} contact names for grounding`);
        } catch (e) {
            console.error(`[Handshake] Failed to parse x-tsehaye-contacts header: ${e.message}`);
        }
    }
    console.log(`[METRIC] event=session_start device=${maskId(clientWs._tenantId)} version=${tenant?.appVersion || 'unknown'} contactsBucket=${contactBucket(contactNames.length)}`);

    const state = {
        geminiWs: null,
        setupCompleteReceived: false,
        messageQueue: [],
        lastHeard: "",
        heardFresh: true,
        lastPassed: null,
        usageTotal: 0,
        sessionOpens: 0,
        vocabTerms: [],
        liveSessionOpen: false
    };

    const targetUrl = `${GEMINI_WS_URL}?key=${GEMINI_API_KEY}`;

    function buildSetupMessage(contactNames, biasing = buildBiasing(contactNames)) {
        const inputAudioTranscription = {};
        if (GEMINI_VOCAB_LIMIT > 0) {
            inputAudioTranscription.customVocabulary = biasing.vocab;
        }
        if (biasing.langHints.length > 0) {
            inputAudioTranscription.languageCodes = biasing.langHints;
        }
        return {
            setup: {
                model: GEMINI_MODEL_PATH,
                generationConfig: {
                    responseModalities: ["AUDIO"]
                },
                inputAudioTranscription,
                realtimeInputConfig: {
                    automaticActivityDetection: {
                        disabled: true
                    }
                },
                systemInstruction: {
                    parts: [{ text: buildSystemInstruction(contactNames) }]
                },
                tools: [{
                    functionDeclarations: [
                        {
                            name: "search_contacts",
                            behavior: TOOL_BEHAVIOR,
                            description: "Call this function whenever the user asks to call or text someone. Pass exactly what you heard as a comma-separated pair of the name in both scripts — the original as heard plus your phonetic transliteration of it. Never substitute a name you know from context. Transliterate only what was actually spoken.",
                            parameters: {
                                type: "OBJECT",
                                properties: {
                                    name: {
                                        type: "STRING",
                                        description: "The name exactly as heard followed by its phonetic transliteration in the other script, separated by a comma. Example: 'Nati, ናቲ' or 'አበበ, Abebe'. Never invent or substitute a different name."
                                    }
                                },
                                required: ["name"]
                            },
                            response: {
                                type: "OBJECT",
                                properties: {
                                    result: { type: "STRING", description: "Status: FOUND, PENDING_CONFIRMATION, NOT_FOUND, AMBIGUITY, NO_NAME_PROVIDED" },
                                    name: { type: "STRING", description: "The matched contact's display name" },
                                    number: { type: "STRING", description: "The matched contact's phone number" },
                                    query: { type: "STRING", description: "The search query used (only for NOT_FOUND)" }
                                }
                            }
                        },
                        {
                            name: "add_new_contact",
                            behavior: TOOL_BEHAVIOR,
                            description: "Saves a new person to the user's phonebook.",
                            parameters: {
                                type: "OBJECT",
                                properties: {
                                    name: { type: "STRING", description: "The name of the new contact" },
                                    phone_number: { type: "STRING", description: "The phone number of the new contact" }
                                },
                                required: ["name", "phone_number"]
                            }
                        },
                        {
                            name: "send_text_message",
                            behavior: TOOL_BEHAVIOR,
                            description: "Sends an SMS text message to an existing contact.",
                            parameters: {
                                type: "OBJECT",
                                properties: {
                                    recipient_name: { type: "STRING", description: "The name of the recipient" },
                                    message_body: { type: "STRING", description: "The text content of the message" }
                                },
                                required: ["recipient_name", "message_body"]
                            },
                            response: {
                                type: "OBJECT",
                                properties: {
                                    result: { type: "STRING", description: "Status: PENDING_CONFIRMATION, SENT, NOT_FOUND, AMBIGUITY, MISSING_ARGS, PERMISSION_DENIED, ERROR" },
                                    name: { type: "STRING", description: "The matched contact's display name" },
                                    number: { type: "STRING", description: "The matched contact's phone number" },
                                    message_body: { type: "STRING", description: "The message body (only for PENDING_CONFIRMATION)" }
                                }
                            }
                        },
                        {
                            name: "confirm_pending_action",
                            behavior: TOOL_BEHAVIOR,
                            description: "Call this tool when the user verbally confirms a pending action by saying yes, okay, correct, ይሁን, አዎ, or any affirmative response.",
                            parameters: {
                                type: "OBJECT",
                                properties: {},
                                required: []
                            }
                        },
                        {
                            name: "cancel_pending_action",
                            behavior: TOOL_BEHAVIOR,
                            description: "Call this tool when the user verbally cancels a pending action by saying no, cancel, stop, አይ, አይሆንም, or any negative response.",
                            parameters: {
                                type: "OBJECT",
                                properties: {},
                                required: []
                            }
                        }
                    ]
                }]
            }
        };
    }

    // ── Session lifecycle: push-to-talk drives Gemini, not the phone's socket ──
    let idleTimer = null;
    let maxSessionTimer = null;

    function endLiveSession() {
        if (!state.liveSessionOpen) return;
        state.liveSessionOpen = false;
        limits.noteClose(clientWs._tenantId || '');
    }

    function cancelIdleTeardown() {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    }

    function cancelMaxSessionTimer() {
        if (maxSessionTimer) {
            clearTimeout(maxSessionTimer);
            maxSessionTimer = null;
        }
    }

    function teardownGemini(reason) {
        cancelIdleTeardown();
        cancelMaxSessionTimer();
        const ws = state.geminiWs;
        state.geminiWs = null;
        state.setupCompleteReceived = false;
        state.messageQueue.length = 0;
        endLiveSession();
        if (ws) {
            ws.removeAllListeners();
            try { ws.close(); } catch (e) { /* already gone */ }
        }
        console.log(`[SESSION] Gemini torn down reason=${reason} device=${clientWs._tenantId || 'unpaired'} live=${limits.liveCount()}`);
    }

    function scheduleIdleTeardown() {
        cancelIdleTeardown();
        idleTimer = setTimeout(() => {
            idleTimer = null;
            teardownGemini('idle');
        }, limits.idleTeardownMs);
    }

    // A guardrail that only logs is a silent failure: the app speaks UNAVAILABLE on an error frame.
    function speakLimit(reason, retryAfterMs) {
        console.log(`${YELLOW}[LIMIT] Refusing Gemini open device=${clientWs._tenantId || 'unpaired'} reason=${reason} retryAfterMs=${retryAfterMs || 0}${RESET}`);
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
                type: 'error',
                error: { message: `Service limit: ${reason}`, code: `LIMIT_${String(reason).toUpperCase()}` }
            }));
        }
    }

    function ensureGemini() {
        const ws = state.geminiWs;
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return true;
        const deviceId = clientWs._tenantId || '';
        const verdict = limits.canOpen(deviceId);
        if (!verdict.ok) {
            state.messageQueue.length = 0;
            speakLimit(verdict.reason, verdict.retryAfterMs);
            return false;
        }
        limits.noteOpen(deviceId);
        state.liveSessionOpen = true;
        console.log(`[SESSION] Opening Gemini on push-to-talk device=${deviceId || 'unpaired'} live=${limits.liveCount()}`);
        connectToGemini();
        return true;
    }

    function connectToGemini() {
        state.sessionOpens++;
        if (state.geminiWs) {
            // Fully tear down the old connection before replacing it
            state.geminiWs.removeAllListeners();
            if (state.geminiWs.readyState === WebSocket.OPEN ||
                state.geminiWs.readyState === WebSocket.CONNECTING) {
                state.geminiWs.close();
            }
        }
        state.setupCompleteReceived = false;
        const ws = new WebSocket(targetUrl);
        state.geminiWs = ws;

        ws.on('open', () => {
            console.log(`${GREEN}🟢 [RELAY] Gemini connected (open #${state.sessionOpens})${RESET}`);
            cancelMaxSessionTimer();
            maxSessionTimer = setTimeout(() => {
                teardownGemini('max_session_length');
                speakLimit('max_session_length');
            }, limits.maxSessionMs);
            console.log(`${BLUE}🔵 [RELAY -> GEMINI] Sending Setup Frame: ${GEMINI_MODEL_PATH}${RESET}`);
            const biasing = buildBiasing(contactNames);
            state.vocabTerms = biasing.vocab;
            const setupFrame = JSON.stringify(buildSetupMessage(contactNames, biasing));
            console.log(`[SETUP-SIZE] chars=${setupFrame.length}`);
            console.log(`[BIASING] vocab=${biasing.vocab.length} langHints=${biasing.langHints.length ? biasing.langHints.join(",") : "none"} setupChars=${setupFrame.length}`);
            if (GEMINI_VOCAB_LIMIT > 0) {
                console.log(`[BIASING-LIST] count=${biasing.vocab.length} (contacts masked)`);
                console.log(`[BIASING-CUT] total=${contactNames.length} sent=${biasing.vocab.length}`);
            }
            ws.send(setupFrame);
        });

        ws.on('message', async (message, isBinary) => {
            console.log(`📦 [RAW GEMINI FRAME]: ${message.toString().slice(0, 500)}`);
            let messageStr = message.toString();
            let isJson = false;
            let aiMsg = null;

            // [CRITICAL FIX] Handle JSON-in-Binary handshake (Gemini v1beta behavior)
            if (isBinary) {
                if (messageStr.trim().startsWith('{')) {
                    try {
                        aiMsg = JSON.parse(messageStr);
                        isJson = true;
                    } catch (e) {
                        isJson = false;
                    }
                }
            } else {
                try {
                    aiMsg = JSON.parse(messageStr);
                    isJson = true;
                } catch (e) {
                    isJson = false;
                }
            }

            if (isJson) {
                console.log(`🔍 [AIMSGS KEYS]: ${Object.keys(aiMsg).join(', ')}`);
                if (aiMsg.setupComplete) {
                    console.log(`${GREEN}🟢 [GEMINI -> RELAY] setupComplete Received! Opening Gate.${RESET}`);
                    state.setupCompleteReceived = true;
                    limits.noteSuccess(clientWs._tenantId || '');
                    // This session was opened by the press that queued these frames, so the audio
                    // is the command itself. Dropping it would leave the Tester speaking into a void.
                    let flushed = 0;
                    while (state.messageQueue.length > 0) {
                        const msg = state.messageQueue.shift();
                        ws.send(msg.data, { binary: msg.isBinary });
                        flushed++;
                    }
                    console.log(`[Relay] Flushed ${flushed} buffered frame(s) into the new session`);
                    clientWs.send(messageStr);
                    return;
                }

                const usage = aiMsg.usageMetadata || aiMsg.serverContent?.usageMetadata;
                if (usage) {
                    const promptTokens = usage.promptTokenCount ?? 0;
                    const responseTokens = usage.responseTokenCount ?? 0;
                    const totalTokens = usage.totalTokenCount ?? (promptTokens + responseTokens);
                    state.usageTotal += totalTokens;
                    limits.noteUsage(clientWs._tenantId || '', { promptTokens, responseTokens, totalTokens });
                    console.log(`[USAGE] clientId=${clientWs._id} device=${clientWs._tenantId || 'unpaired'} prompt=${promptTokens} response=${responseTokens} total=${totalTokens} modalities=${summarizeUsageDetails(usage)}`);
                }

                // Log transcription wherever Gemini puts it — top level or inside serverContent
                const inputTx = aiMsg.inputTranscription
                    || aiMsg.serverContent?.inputTranscription;
                if (inputTx?.text) {
                    if (state.heardFresh) {
                        state.lastHeard = "";
                        state.heardFresh = false;
                    }
                    state.lastHeard = appendHeard(state.lastHeard, inputTx.text);
                    console.log(`🎙️ [GEMINI HEARD]: "${maskText(inputTx.text)}"`);
                    const echoTerms = countVocabEcho(inputTx.text, state.vocabTerms);
                    if (echoTerms >= VOCAB_ECHO_MIN_TERMS) {
                        console.log(`[VOCAB-ECHO] heard="${inputTx.text.slice(0, 80)}" terms=${echoTerms}`);
                    }
                }

                if (aiMsg.serverContent) {
                    console.log(`${YELLOW}🟡 [GEMINI -> RELAY] Prettified serverContent:\n${JSON.stringify(aiMsg.serverContent, null, 2)}${RESET}`);
                    if (aiMsg.serverContent.turnComplete === true) {
                        console.log(`[RELAY] GEMINI TURN COMPLETE: clientId=${clientWs._id}`);
                        state.heardFresh = true;
                    }
                    const parts = aiMsg.serverContent.modelTurn?.parts || [];
                    parts.forEach(async part => {
                        // Check for standard v1beta tool calls
                        if (part.executableCalls) {
                            const call = part.executableCalls[0];
                            if (call.name === "search_contacts") {
                                const name = call.args?.name || "Unknown";
                                console.log(`${BLUE}🔵 [SNIFFER] Detected tool_call 'search_contacts' for: ${maskText(name)}${RESET}`);
                            }
                        }

                        if (part.text) {
                            console.log(`${YELLOW}🟡 [GEMINI -> RELAY] Token: "${part.text}"${RESET}`);
                        }
                        if (part.inlineData) console.log(`${YELLOW}🟡 [GEMINI -> RELAY] Inline Audio Chunks (${part.inlineData.data.length} bytes)${RESET}`);
                        if (part.callCalls) console.log(`${YELLOW}🟡 [GEMINI -> RELAY] Tool Requests: ${JSON.stringify(part.callCalls)}${RESET}`);
                    });
                }

                // [TOP-LEVEL TOOL CALL] Gemini sends toolCall at root level
                if (aiMsg.toolCall) {
                    const calls = aiMsg.toolCall.functionCalls || [];
                    console.log(`${YELLOW}🟡 [GEMINI -> RELAY] toolCall: ${calls.map(c => `${c.name}(${JSON.stringify(maskArgs(c.args))})`).join(', ')}${RESET}`);
                    for (const call of calls) {
                        if (call.name === "search_contacts" || call.name === "send_text_message") {
                            const passed = (call.name === "search_contacts"
                                ? call.args?.name
                                : call.args?.recipient_name) || "";
                            state.lastPassed = passed;
                            traceToolCall(state.lastHeard || "", passed, call.name);
                        }
                        if (call.name === "search_contacts") {
                            const name = call.args?.name || "Unknown";
                            console.log(`${BLUE}🔵 [SNIFFER] Detected toolCall 'search_contacts' for: ${maskText(name)}${RESET}`);
                        }
                    }
                    state.heardFresh = true;
                }

                if (clientWs.readyState === WebSocket.OPEN) clientWs.send(messageStr);
            } else {
                // Raw Binary Audio
                console.log(`${YELLOW}🟡 [GEMINI -> RELAY] Binary Audio (${message.length} bytes)${RESET}`);
                if (clientWs.readyState === WebSocket.OPEN) clientWs.send(message, { binary: true });
            }
        });

        // An upstream close is never re-dialled on its own — the next activityStart opens a fresh
        // session. Reconnecting here is what burned quota on a phone nobody was talking to.
        let openFailureCounted = false;
        function countOpenFailure() {
            if (openFailureCounted || state.setupCompleteReceived) return;
            openFailureCounted = true;
            const outcome = limits.noteFailure(clientWs._tenantId || '');
            console.log(`${RED}[LIMIT] Gemini open failed device=${clientWs._tenantId || 'unpaired'} streak=${outcome.failures} hardStopped=${outcome.hardStopped}${RESET}`);
        }

        ws.on('close', (code, reason) => {
            console.log(`${RED}🔴 [GEMINI -> ERROR] Connection Closed (${code}): ${reason}${RESET}`);
            countOpenFailure();
            const wasCurrent = state.geminiWs === ws;
            if (wasCurrent) {
                state.geminiWs = null;
                state.setupCompleteReceived = false;
                state.messageQueue.length = 0;
                endLiveSession();
                cancelIdleTeardown();
                // Speak only if this was the session the Tester is waiting on.
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        type: "error",
                        error: { message: "AI service disconnected", code: "GEMINI_DISCONNECT" }
                    }));
                }
            }
        });

        ws.on('error', (err) => {
            console.error(`${RED}🔴 [GEMINI -> ERROR] WebSocket Error: ${err.message}${RESET}`);
            countOpenFailure();
        });
    }

    const NAME_TRACE_LOG = './name-trace.log';

    function appendHeard(prev, next) {
        if (!prev) return next;
        if (!next) return prev;
        const needsSpace = !/\s$/.test(prev) && !/^\s/.test(next);
        return prev + (needsSpace ? " " : "") + next;
    }

    function writeNameTrace(entry) {
        try {
            fs.appendFileSync(NAME_TRACE_LOG, JSON.stringify(entry) + "\n");
        } catch (e) {
            console.error(`[NAME-TRACE] write failed: ${e.message}`);
        }
    }

    function traceToolCall(heard, passed, fn) {
        const mask = typeof maskText === 'function' ? maskText : (s) => s;
        const isProbe = clientWs && clientWs._id === 'probe';
        const displayHeard = isProbe ? heard : mask(heard);
        const displayPassed = isProbe ? passed : mask(passed);
        console.log(`[NAME-TRACE] fn=${fn} heard="${displayHeard}" | passed="${displayPassed}"`);
        writeNameTrace({
            timestamp: new Date().toISOString(),
            clientId: clientWs._id,
            fn,
            heard: displayHeard,
            passed: displayPassed,
            result: null,
            matched: null
        });
    }

    function summarizeUsageDetails(usage) {
        const format = (details) => (details || [])
            .map(d => `${d.modality || d.type || "UNKNOWN"}:${d.tokenCount ?? 0}`)
            .join(",");
        return `prompt[${format(usage.promptTokensDetails)}] response[${format(usage.responseTokensDetails)}]`;
    }

    // These two never carry a contact or a fresh request: the app is echoing the outcome of an
    // action that was already traced, so pairing them with lastHeard/lastPassed invents a
    // request that belongs to an earlier turn.
    const NON_CONVERSATIONAL_FNS = new Set(["confirm_pending_action", "cancel_pending_action"]);

    /**
     * Records one answered tool call. Takes the whole response map so every result the app can
     * emit lands in the trace with whatever identifies it: a matched name, ambiguity candidates,
     * or the query that found nothing.
     */
    function traceToolResponse(responseMap, fn) {
        const map = typeof responseMap === "string" ? { result: responseMap } : (responseMap || {});
        const result = map.result || "UNKNOWN";
        const mask = typeof maskText === 'function' ? maskText : (s) => s;
        const tag = typeof maskId === 'function' ? maskId(clientWs._tenantId) : (clientWs._tenantId || 'unidentified');

        if (NON_CONVERSATIONAL_FNS.has(fn)) {
            console.log(`[NAME-TRACE] fn=${fn} result=${result}`);
            console.log(`[METRIC] event=task_result device=${tag} fn=${fn} result=${result}`);
            writeNameTrace({
                timestamp: new Date().toISOString(),
                clientId: clientWs._id,
                fn,
                result
            });
            return;
        }

        const isProbe = clientWs && clientWs._id === 'probe';
        const matched = map.name || "-";
        const candidates = Array.isArray(map.matches) && map.matches.length ? map.matches : null;
        const query = map.query || null;

        const displayMatched = isProbe || !matched || matched === '-' ? matched : mask(matched);
        const displayCandidates = candidates ? (isProbe ? candidates : candidates.map(mask)) : null;
        const displayQuery = query ? (isProbe ? query : mask(query)) : null;

        console.log(`[NAME-TRACE] fn=${fn || "unknown"} result=${result} matched="${displayMatched}"` +
            (displayCandidates ? ` candidates=${JSON.stringify(displayCandidates)}` : ""));
        console.log(`[METRIC] event=task_result device=${tag} fn=${fn || "unknown"} result=${result}`);
        writeNameTrace({
            timestamp: new Date().toISOString(),
            clientId: clientWs._id,
            fn: fn || null,
            heard: isProbe ? (state.lastHeard || "") : mask(state.lastHeard || ""),
            passed: isProbe ? (state.lastPassed || "") : mask(state.lastPassed || ""),
            result,
            matched: displayMatched,
            ...(displayCandidates ? { candidates: displayCandidates } : {}),
            ...(displayQuery ? { query: displayQuery } : {})
        });
    }

    // No eager connect: an idle app used to hold a Gemini session open, which is what burned the
    // free tier. The first activityStart opens it; activityEnd plus the idle window closes it.

    clientWs.on('ping', () => {
        clientWs._lastSeen = Date.now();
        if (clientWs._tenantId) tenancy.renewLease(clientWs._tenantId);
    });
    clientWs.on('pong', () => {
        clientWs._lastSeen = Date.now();
        if (clientWs._tenantId) tenancy.renewLease(clientWs._tenantId);
    });

    clientWs.on('message', (message, isBinary) => {
        clientWs._lastSeen = Date.now();
        if (clientWs._tenantId) tenancy.renewLease(clientWs._tenantId);
        let messageStr = message.toString();
        const isJson = messageStr.trim().startsWith('{');
        let clientMsg = null;

        if (isJson) {
            try {
                clientMsg = JSON.parse(messageStr);

                // [DEPRECATION FIX] Transform mediaChunks -> audio (v1beta requirement)
                if (clientMsg.realtimeInput && clientMsg.realtimeInput.mediaChunks) {
                    const chunk = clientMsg.realtimeInput.mediaChunks[0];
                    if (chunk && chunk.data) {
                        // Transform to modern v1beta Bidi format (camelCase)
                        const modernInput = {
                            realtimeInput: {
                                audio: {
                                    data: chunk.data,
                                    mimeType: chunk.mimeType || "audio/pcm;rate=16000"
                                }
                            }
                        };
                        messageStr = JSON.stringify(modernInput);
                        clientMsg = modernInput;
                    }
                }
            } catch (e) {
                console.error(`[Relay] Client JSON Parse Error: ${e.message}`);
                return;
            }
        }

        if (isJson && clientMsg?.type === 'ANNOUNCEMENT_FAILED') {
            const clip = String(clientMsg.clip || 'unknown').slice(0, 64);
            const why = String(clientMsg.why || 'unknown').slice(0, 64);
            console.error(`${RED}🔇 [SILENT FAILURE] device=${clientWs._tenantId || 'unpaired'} clip=${clip} why=${why}${RESET}`);
            tenancy.alert('announcement_failed', `A phone could not speak to its user: clip=${clip} why=${why}`);
            return;
        }

        if (GEMINI_DROP_CLIENT_TURNCOMPLETE && isJson && clientMsg?.clientContent) {
            const clientContent = clientMsg.clientContent;
            const hasTurns = clientContent.turns && clientContent.turns.length;
            const hasParts = clientContent.parts && clientContent.parts.length;
            const isBareTurnComplete = clientContent.turnComplete === true
                && !hasTurns
                && !hasParts;
            if (isBareTurnComplete) {
                console.log(`[DROP] clientContent turnComplete dropped`);
                return;
            }
        }

        // Push-to-talk owns the session: a press opens Gemini, a release starts the idle window.
        // Audio also opens it, so a build that never sends activityStart still works.
        const ri = isJson ? clientMsg?.realtimeInput : null;
        const isAudioIn = !isJson || Boolean(ri && (ri.audio || ri.mediaChunks));
        if (ri?.activityStart) cancelIdleTeardown();
        if (ri?.activityStart || isAudioIn) {
            if (!ensureGemini()) return;
        }
        if (ri?.activityEnd) scheduleIdleTeardown();

        if (!state.geminiWs || state.geminiWs.readyState !== WebSocket.OPEN || !state.setupCompleteReceived) {
            state.messageQueue.push({ data: messageStr, isBinary: !isJson, clientMsg: clientMsg });
            return;
        }

        if (isJson) {
            try {
                // PTT Signals: Forward activityStart and activityEnd immediately (camelCase per v1beta spec)
                if (clientMsg.realtimeInput && (clientMsg.realtimeInput.activityStart || clientMsg.realtimeInput.activityEnd)) {
                    const signal = clientMsg.realtimeInput.activityStart ? 'activityStart' : 'activityEnd';
                    console.log(`🎤 [CLIENT -> RELAY] PTT Signal: ${signal}`);
                    state.geminiWs.send(messageStr);
                    return;
                }

                // Audio input parsing for RMS check
                if (clientMsg.realtimeInput && clientMsg.realtimeInput.audio) {
                    const data = clientMsg.realtimeInput.audio.data;
                    if (data) {
                        const buffer = Buffer.from(data, 'base64');
                        let sum = 0;
                        for (let i = 0; i < buffer.length; i += 2) {
                            if (i+1 < buffer.length) {
                                const sample = buffer.readInt16LE(i);
                                sum += sample * sample;
                            }
                        }
                        const rms = Math.sqrt(sum / (buffer.length / 2));
                        console.log(`🎤 [CLIENT -> RELAY] RMS: ${rms.toFixed(2)} | B64: ${data.length} | Forwarding: realtimeInput.audio`);
                        const spent = limits.noteAudio(clientWs._tenantId || '', pcmDurationMs(buffer.length, clientMsg.realtimeInput.audio.mimeType));
                        if (spent.exhausted) {
                            teardownGemini('daily_audio_exhausted');
                            speakLimit(REASON.DAILY_AUDIO);
                            return;
                        }
                    }
                    state.geminiWs.send(messageStr);
                    return;
                }

                if (clientMsg.clientContent) {
                    console.log(`📡 [CLIENT -> RELAY] Turn Completion Signal Forwarded:\n${JSON.stringify(clientMsg, null, 2)}`);
                }

                // Tool Response from Android → forward to Gemini
                if (clientMsg.toolResponse) {
                    console.log(`${BLUE}🔵 [CLIENT -> RELAY] toolResponse Received:\n${JSON.stringify(clientMsg.toolResponse, null, 2)}${RESET}`);
                    
                    const first = clientMsg.toolResponse.functionResponses?.[0];
                    const responseMap = first?.response;
                    traceToolResponse(responseMap, first?.name);
                    if (responseMap?.result === "NOT_FOUND") {
                        console.log(`${YELLOW}[SEARCH] Searching phone for: ${responseMap.query || "unknown"} (0 results found)${RESET}`);
                        // Add suggestion so prompt instruction triggers
                        responseMap.suggestion = "Try a different name";
                    } else if (responseMap?.result === "FOUND") {
                        console.log(`${GREEN}[SEARCH] Searching phone for: ${responseMap.name || "unknown"} (Found)${RESET}`);
                    }
                    
                    // We mutated clientMsg in place, now we stringify the updated one
                    const jsonOut = JSON.stringify(clientMsg);
                    console.log(`${BLUE}🔵 [RELAY -> GEMINI] Sending Tool Response at ${new Date().toISOString()}:${RESET}`);
                    console.log(`${BLUE}${jsonOut}${RESET}`);
                    state.geminiWs.send(jsonOut);
                    return;
                }

                // Mock Conflict Handling via toolResponse
                if (clientMsg.type === "AMBIGUITY") {
                    const matches = clientMsg.matches.join(", ");
                    const functionCallId = clientMsg.functionCallId;
                    traceToolResponse({ result: "AMBIGUITY", matches: clientMsg.matches }, "search_contacts");
                    
                    // Send a proper toolResponse back to Gemini
                    const toolResponse = {
                        toolResponse: {
                            functionResponses: [{
                                id: functionCallId,
                                name: "search_contacts",
                                response: {
                                    result: `AMBIGUITY: Multiple contacts match: ${matches}. Ask the user which specific one they mean. As soon as they answer, call search_contacts again immediately with that person's FULL name exactly as listed here (one of: ${matches}). Do not restart or reinterpret the original request — only resolve which contact to use.`
                                }
                            }]
                        }
                    };
                    console.log(`${BLUE}[ConflictHandler] Sending toolResponse for AMBIGUITY: ${matches}${RESET}`);
                    state.geminiWs.send(JSON.stringify(toolResponse));
                    return;
                }

                state.geminiWs.send(messageStr);
            } catch (e) {
                console.error(`[Relay] Error handling client JSON: ${e.message}`);
            }
        } else {
            const spent = limits.noteAudio(clientWs._tenantId || '', pcmDurationMs(message.length));
            if (spent.exhausted) {
                teardownGemini('daily_audio_exhausted');
                speakLimit(REASON.DAILY_AUDIO);
                return;
            }
            state.geminiWs.send(message, { binary: true });
        }
    });

    clientWs.on('close', () => {
        console.log(`[Handshake] Client ${clientWs._id} Disconnected`);
        console.log(`[RELAY] CLIENT DISCONNECT: id=${clientWs._id}`);
        console.log(`[USAGE-SESSION] clientId=${clientWs._id} device=${clientWs._tenantId || 'unpaired'} total=${state.usageTotal} opens=${state.sessionOpens}`);
        if (clientWs._tenantId) {
            tenancy.releaseLease(clientWs._tenantId, clientWs._id);
            console.log(`[Tenancy] Lease released for device=${clientWs._tenantId}`);
        }
        teardownGemini('client_disconnected');
        // Audio and token counters are debounced; a disconnect must not lose the last second.
        limits.flush();
    });
});

// ═══════════════════════════════════════
// TENANT HEARTBEAT
// ═══════════════════════════════════════
// A lease held by a phone that died silently would lock out the Tester's next device,
// and the relay would never find out. Only sockets we accepted on tenancy are checked,
// so legacy builds that never send the device headers are left alone.
setInterval(() => {
    const now = Date.now();
    wss.clients.forEach((client) => {
        if (!client._tenantId) return;
        const lastSeen = client._lastSeen || 0;
        if (now - lastSeen > LEASE_TTL_MS) {
            console.log(`[Tenancy] Device=${client._tenantId} silent for ${Math.round((now - lastSeen) / 1000)}s — dropping`);
            tenancy.releaseLease(client._tenantId, client._id);
            client.terminate();
            return;
        }
        client.ping();
    });
}, 30_000);

// ═══════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════
process.on('SIGTERM', () => {
    console.log('SIGTERM received — closing connections cleanly');
    wss.clients.forEach(client => {
        client.close(1001, 'Server restarting, reconnect in 10 seconds');
    });
    setTimeout(() => process.exit(0), 3000);
});

// ═══════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════
server.listen(PORT, '0.0.0.0', () => {
    console.log(`${GREEN}✅ Tsehaye Assist Relay Running on port ${PORT}${RESET}`);
    console.log(`${GREEN}   Model: ${GEMINI_MODEL_PATH} | Tool behavior: ${TOOL_BEHAVIOR}${RESET}`);
    console.log(`   Tenancy: ${TENANCY_ENFORCED ? "ENFORCED" : "disabled (all clients served)"} | data dir: ${PILOT_DATA_DIR} | lease ttl: ${LEASE_TTL_MS}ms`);
    console.log(`   Admin panel: ${ADMIN_PANEL_ENABLED ? `on ${ADMIN_BASE}` : "disabled"}`);
    const snap = limits.snapshot();
    console.log(`   Limits: ${snap.maxLiveSessions} live Gemini sessions | ${snap.globalDailyOpenLimit} opens/day project-wide | ${snap.dailyOpenLimit} opens + ${snap.dailyAudioMinutes} audio min/day per Tester`);
    console.log(`   Session: opened on activityStart, torn down ${snap.idleTeardownMs}ms after activityEnd | day resets at UTC${snap.dayOffsetMinutes >= 0 ? '+' : ''}${snap.dayOffsetMinutes / 60} | usage store: ${limits.filePath}`);
});
