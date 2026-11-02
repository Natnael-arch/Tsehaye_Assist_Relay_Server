// Local dev: run with: node -r dotenv/config index.js
// Production: set vars in Railway dashboard → Variables tab
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

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
const GEMINI_VOCAB_LIMIT = (() => {
    const parsed = Number.parseInt(process.env.GEMINI_VOCAB_LIMIT || "0", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
})();
const GEMINI_LANG_HINTS = (process.env.GEMINI_LANG_HINTS || "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);

const GEMINI_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

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
Once you have asked the user to confirm an action (after receiving PENDING_CONFIRMATION), you MUST wait for the user's voice response. If they say yes or any affirmative (ይሁን, አዎ, okay, correct), call confirm_pending_action with no arguments. If they say no or any negative (አይ, አይሆንም, cancel, stop), call cancel_pending_action with no arguments. Do NOT call search_contacts again. Do NOT generate a text response. Do NOT call any other tool. Just call confirm_pending_action or cancel_pending_action.`;

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
// WEBSOCKET UPGRADE HANDLER
// ═══════════════════════════════════════
server.on('upgrade', (request, socket, head) => {
    // Accept connections on /relay or root path /
    const url = request.url;
    if (url === '/relay' || url === '/') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

// ═══════════════════════════════════════
// WEBSOCKET CONNECTION HANDLER
// ═══════════════════════════════════════
wss.on('connection', (clientWs, request) => {
    clientWs._id = Math.random().toString(36).substr(2, 9);
    console.log(`[Handshake] New Client Connected. Assigned ID: ${clientWs._id}`);
    console.log(`[RELAY] CLIENT CONNECT: id=${clientWs._id}`);

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

    const state = {
        geminiWs: null,
        setupCompleteReceived: false,
        messageQueue: [],
        reconnecting: false,
        lastHeard: "",
        heardFresh: true,
        lastPassed: null,
        usageTotal: 0,
        reconnectCount: 0
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

    function connectToGemini(isReconnect = false) {
        if (isReconnect) {
            state.reconnectCount++;
        }
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
            console.log(`${GREEN}🟢 [RELAY] Gemini ${isReconnect ? 'reconnected' : 'connected'}${RESET}`);
            console.log(`${BLUE}🔵 [RELAY -> GEMINI] Sending Setup Frame: ${GEMINI_MODEL_PATH}${RESET}`);
            const biasing = buildBiasing(contactNames);
            const setupFrame = JSON.stringify(buildSetupMessage(contactNames, biasing));
            console.log(`[SETUP-SIZE] chars=${setupFrame.length}`);
            console.log(`[BIASING] vocab=${biasing.vocab.length} langHints=${biasing.langHints.length ? biasing.langHints.join(",") : "none"} setupChars=${setupFrame.length}`);
            if (GEMINI_VOCAB_LIMIT > 0) {
                console.log(`[BIASING-LIST] ${JSON.stringify(biasing.vocab)}`);
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
                    let droppedAudioChunks = 0;
                    
                    while (state.messageQueue.length > 0) {
                        const msg = state.messageQueue.shift();
                        
                        const isAudioChunk = msg.clientMsg && msg.clientMsg.realtimeInput && 
                                             (msg.clientMsg.realtimeInput.audio || msg.clientMsg.realtimeInput.mediaChunks);
                        
                        if (isAudioChunk) {
                            droppedAudioChunks++;
                            continue;
                        }
                        
                        console.log(`[Relay] Flushing buffered message (${msg.data.length} bytes)`);
                        ws.send(msg.data, { binary: msg.isBinary });
                    }
                    
                    if (droppedAudioChunks > 0) {
                        console.log(`🗑️ Dropped ${droppedAudioChunks} stale audio chunks from queue after reconnect`);
                    }
                    clientWs.send(messageStr);
                    return;
                }

                const usage = aiMsg.usageMetadata || aiMsg.serverContent?.usageMetadata;
                if (usage) {
                    const promptTokens = usage.promptTokenCount ?? 0;
                    const responseTokens = usage.responseTokenCount ?? 0;
                    const totalTokens = usage.totalTokenCount ?? (promptTokens + responseTokens);
                    state.usageTotal += totalTokens;
                    console.log(`[USAGE] clientId=${clientWs._id} prompt=${promptTokens} response=${responseTokens} total=${totalTokens} modalities=${summarizeUsageDetails(usage)}`);
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
                    console.log(`🎙️ [GEMINI HEARD]: "${inputTx.text}"`);
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
                                console.log(`${BLUE}🔵 [SNIFFER] Detected tool_call 'search_contacts' for: ${name}${RESET}`);
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
                    console.log(`${YELLOW}🟡 [GEMINI -> RELAY] Prettified toolCall:\n${JSON.stringify(aiMsg.toolCall, null, 2)}${RESET}`);
                    const calls = aiMsg.toolCall.functionCalls || [];
                    for (const call of calls) {
                        if (call.name === "search_contacts" || call.name === "send_text_message") {
                            const passed = (call.name === "search_contacts"
                                ? call.args?.name
                                : call.args?.recipient_name) || "";
                            state.lastPassed = passed;
                            traceToolCall(state.lastHeard || "", passed);
                        }
                        if (call.name === "search_contacts") {
                            const name = call.args?.name || "Unknown";
                            console.log(`${BLUE}🔵 [SNIFFER] Detected toolCall 'search_contacts' for: ${name}${RESET}`);
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

        ws.on('close', (code, reason) => {
            console.log(`${RED}🔴 [GEMINI -> ERROR] Connection Closed (${code}): ${reason}${RESET}`);
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                    type: "error",
                    error: { message: "AI service disconnected", code: "GEMINI_DISCONNECT" }
                }));
            }
            // Only reconnect if this closed connection is STILL the
            // current active one — prevents a stale/already-replaced
            // connection's close event from triggering a second,
            // redundant reconnect
            if (state.geminiWs === ws && !state.reconnecting) {
                state.reconnecting = true;
                console.log(`${YELLOW}🟡 [RELAY] Attempting Gemini reconnect...${RESET}`);
                setTimeout(() => {
                    state.reconnecting = false;
                    connectToGemini(true);
                }, 500);
            }
        });

        ws.on('error', (err) => {
            console.error(`${RED}🔴 [GEMINI -> ERROR] WebSocket Error: ${err.message}${RESET}`);
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

    function traceToolCall(heard, passed) {
        console.log(`[NAME-TRACE] heard="${heard}" | passed="${passed}"`);
        writeNameTrace({
            timestamp: new Date().toISOString(),
            clientId: clientWs._id,
            heard,
            passed,
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

    function traceToolResponse(result, matched) {
        const heard = state.lastHeard || "";
        const passed = state.lastPassed || "";
        console.log(`[NAME-TRACE] result=${result} matched="${matched}"`);
        writeNameTrace({
            timestamp: new Date().toISOString(),
            clientId: clientWs._id,
            heard,
            passed,
            result,
            matched
        });
    }

    connectToGemini(false);

    clientWs.on('message', (message, isBinary) => {
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
                    
                    const responseMap = clientMsg.toolResponse.functionResponses?.[0]?.response;
                    traceToolResponse(
                        responseMap?.result || "UNKNOWN",
                        responseMap?.name || "-"
                    );
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
            state.geminiWs.send(message, { binary: true });
        }
    });

    clientWs.on('close', () => {
        console.log(`[Handshake] Client ${clientWs._id} Disconnected`);
        console.log(`[RELAY] CLIENT DISCONNECT: id=${clientWs._id}`);
        console.log(`[USAGE-SESSION] clientId=${clientWs._id} total=${state.usageTotal} reconnects=${state.reconnectCount}`);
        if (state.geminiWs) {
            state.geminiWs.removeAllListeners();
            state.geminiWs.close();
        }
    });
});

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
});
