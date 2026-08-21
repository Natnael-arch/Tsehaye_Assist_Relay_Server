// Local dev: run with: node -r dotenv/config index.js
// Production: set vars in Railway dashboard → Variables tab
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

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

const GEMINI_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
// NEW VERSION — replace the existing `const MASTER_PROMPT = "...";` line entirely
// with this. Using a template literal (backticks) instead of a quoted string
// with \n escapes means real line breaks are just typed directly — this makes
// the previous double-escaping bug (\\n instead of \n) structurally impossible
// to reintroduce by accident.

const MASTER_PROMPT = `You are Tsehaye, a voice assistant for visually impaired users. Speak only Amharic. Follow these rules exactly.

RULE 1 — SEARCHING FOR A CONTACT
When the user asks to call or text someone, call search_contacts with BOTH the Amharic spelling and the English transliteration in one string, separated by a comma. Example: "አበበ, Abebe".

RULE 2 — IF PERMISSION IS DENIED
If any tool returns 'PERMISSION_DENIED', say exactly: "I need permission to do this. Please ask someone to help you enable this in settings."

RULE 3 — AMBIGUITY (MULTIPLE MATCHES FOUND)
If search_contacts returns 'result': 'AMBIGUITY', do not pick a candidate yourself and do not call any tool. Speak every returned name back to the user in Amharic and ask them to clarify — never drop a name to save words, even if the list is long.
Use this general pattern for any number of candidates: "ከአንድ በላይ [ስም] አግኝቻለሁ - [ስም 1]፣ [ስም 2]፣ ... ወይስ [ስም N]?" — separate every name except the last with "፣", and put "ወይስ" before the final name.
After asking, do not call the tool again until the user has clearly said which name they meant.

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
    if (!contactNames || contactNames.length === 0) return MASTER_PROMPT;
    return MASTER_PROMPT + "\n\nKNOWN CONTACTS: The user's phone contains these saved contacts: " + contactNames.join(", ") + ". When you hear a name and it's unclear or ambiguous, strongly prefer transcribing it as the closest matching name from this list rather than a different name you're not confident about. Still transcribe faithfully what you actually hear — only use this list to resolve genuine uncertainty, not to override a clear, confident hearing.";
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

    let contactNames = [];
    if (request.headers['x-tsehaye-contacts']) {
        try {
            const b64 = request.headers['x-tsehaye-contacts'];
            const decoded = Buffer.from(b64, 'base64').toString('utf8');
            contactNames = JSON.parse(decoded);
            console.log(`📇 Loaded ${contactNames.length} contact names for grounding`);
        } catch (e) {
            console.error(`[Handshake] Failed to parse x-tsehaye-contacts header: ${e.message}`);
        }
    }

    const targetUrl = `${GEMINI_WS_URL}?key=${GEMINI_API_KEY}`;
    const geminiWs = new WebSocket(targetUrl);

    const messageQueue = [];
    let setupCompleteReceived = false;

    geminiWs.on('open', () => {
        // [PHASE 1] Official v1beta Setup
        const setupMsg = {
            setup: {
                model: "models/gemini-3.1-flash-live-preview",
                generationConfig: {
                    responseModalities: ["AUDIO"]
                },
                inputAudioTranscription: {},
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
                            description: "Call this function whenever the user asks to call someone. Provide both the Amharic exact spelling and its English/Latin transliteration (you can put both into the string).",
                            parameters: {
                                type: "OBJECT",
                                properties: {
                                    name: {
                                        type: "STRING",
                                        description: "The name of the person to call"
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
                        }
                    ]
                }]
            }
        };
        console.log(`${BLUE}🔵 [RELAY -> GEMINI] Sending Setup Frame: ${setupMsg.setup.model}${RESET}`);
        geminiWs.send(JSON.stringify(setupMsg));
    });

    geminiWs.on('message', async (message, isBinary) => {
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
                setupCompleteReceived = true;
                let droppedAudioChunks = 0;
                
                while (messageQueue.length > 0) {
                    const msg = messageQueue.shift();
                    
                    const isAudioChunk = msg.clientMsg && msg.clientMsg.realtimeInput && 
                                         (msg.clientMsg.realtimeInput.audio || msg.clientMsg.realtimeInput.mediaChunks);
                    
                    if (isAudioChunk) {
                        droppedAudioChunks++;
                        continue;
                    }
                    
                    console.log(`[Relay] Flushing buffered message (${msg.data.length} bytes)`);
                    geminiWs.send(msg.data, { binary: msg.isBinary });
                }
                
                if (droppedAudioChunks > 0) {
                    console.log(`🗑️ Dropped ${droppedAudioChunks} stale audio chunks from queue after reconnect`);
                }
                clientWs.send(messageStr);
                return;
            }

            // Log transcription wherever Gemini puts it — top level or inside serverContent
            const inputTx = aiMsg.inputTranscription
                || aiMsg.serverContent?.inputTranscription;
            if (inputTx?.text) {
                console.log(`🎙️ [GEMINI HEARD]: "${inputTx.text}"`);
            }

            if (aiMsg.serverContent) {
                console.log(`${YELLOW}🟡 [GEMINI -> RELAY] Prettified serverContent:\n${JSON.stringify(aiMsg.serverContent, null, 2)}${RESET}`);
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
                    if (call.name === "search_contacts") {
                        const name = call.args?.name || "Unknown";
                        console.log(`${BLUE}🔵 [SNIFFER] Detected toolCall 'search_contacts' for: ${name}${RESET}`);
                    }
                }
            }

            if (clientWs.readyState === WebSocket.OPEN) clientWs.send(messageStr);
        } else {
            // Raw Binary Audio
            console.log(`${YELLOW}🟡 [GEMINI -> RELAY] Binary Audio (${message.length} bytes)${RESET}`);
            if (clientWs.readyState === WebSocket.OPEN) clientWs.send(message, { binary: true });
        }
    });

    geminiWs.on('close', (code, reason) => {
        console.log(`${RED}🔴 [GEMINI -> ERROR] Connection Closed (${code}): ${reason}${RESET}`);
        
        // Send error frame to Android client before attempting reconnect
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
                type: "error",
                error: { message: "AI service disconnected", code: "GEMINI_DISCONNECT" }
            }));
        }

        // Attempt one reconnect to Gemini
        console.log(`${YELLOW}🟡 [RELAY] Attempting one Gemini reconnect...${RESET}`);
        const retryGemini = new WebSocket(targetUrl);
        
        retryGemini.on('open', () => {
            console.log(`${GREEN}🟢 [RELAY] Gemini reconnect successful!${RESET}`);
            // Re-send setup
            const setupMsg = {
                setup: {
                    model: "models/gemini-3.1-flash-live-preview",
                    generationConfig: { responseModalities: ["AUDIO"] },
                    inputAudioTranscription: {},
                    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
                    systemInstruction: { parts: [{ text: buildSystemInstruction(contactNames) }] },
                    tools: [{
                        functionDeclarations: [
                            {
                                name: "search_contacts",
                                description: "Call this function whenever the user asks to call someone. Provide both the Amharic exact spelling and its English/Latin transliteration separated by a comma.",
                                parameters: { type: "OBJECT", properties: { name: { type: "STRING", description: "The name of the person to call" } }, required: ["name"] },
                                response: { type: "OBJECT", properties: { result: { type: "STRING", description: "Status: FOUND, PENDING_CONFIRMATION, NOT_FOUND, AMBIGUITY, NO_NAME_PROVIDED" }, name: { type: "STRING", description: "The matched contact's display name" }, number: { type: "STRING", description: "The matched contact's phone number" }, query: { type: "STRING", description: "The search query used (only for NOT_FOUND)" } } }
                            },
                            {
                                name: "add_new_contact",
                                description: "Saves a new person to the user's phonebook.",
                                parameters: { type: "OBJECT", properties: { name: { type: "STRING", description: "The name of the new contact" }, phone_number: { type: "STRING", description: "The phone number of the new contact" } }, required: ["name", "phone_number"] }
                            },
                            {
                                name: "send_text_message",
                                description: "Sends an SMS text message to an existing contact.",
                                parameters: { type: "OBJECT", properties: { recipient_name: { type: "STRING", description: "The name of the recipient" }, message_body: { type: "STRING", description: "The text content of the message" } }, required: ["recipient_name", "message_body"] },
                                response: { type: "OBJECT", properties: { result: { type: "STRING", description: "Status: PENDING_CONFIRMATION, SENT, NOT_FOUND, AMBIGUITY, MISSING_ARGS, PERMISSION_DENIED, ERROR" }, name: { type: "STRING", description: "The matched contact's display name" }, number: { type: "STRING", description: "The matched contact's phone number" }, message_body: { type: "STRING", description: "The message body (only for PENDING_CONFIRMATION)" } } }
                            }
                        ]
                    }]
                }
            };
            retryGemini.send(JSON.stringify(setupMsg));
            
            // Swap the reference — re-wire message handlers
            retryGemini.on('message', (msg, isBin) => {
                // Forward to client
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(msg.toString());
                }
            });
            retryGemini.on('close', () => {
                console.log(`${RED}🔴 [RELAY] Retry Gemini also closed. Giving up.${RESET}`);
                clientWs.close();
            });
            retryGemini.on('error', (err) => {
                console.error(`${RED}🔴 [RELAY] Retry Gemini error: ${err.message}${RESET}`);
                clientWs.close();
            });
        });

        retryGemini.on('error', (err) => {
            console.error(`${RED}🔴 [RELAY] Gemini reconnect failed: ${err.message}. Closing client.${RESET}`);
            clientWs.close();
        });
    });

    geminiWs.on('error', (err) => {
        console.error(`${RED}🔴 [GEMINI -> ERROR] WebSocket Error: ${err.message}${RESET}`);
        // Send error frame to client before closing
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
                type: "error",
                error: { message: `AI connection error: ${err.message}`, code: "GEMINI_ERROR" }
            }));
        }
        clientWs.close();
    });

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

        if (geminiWs.readyState !== WebSocket.OPEN || !setupCompleteReceived) {
            messageQueue.push({ data: messageStr, isBinary: !isJson, clientMsg: clientMsg });
            return;
        }

        if (isJson) {
            try {
                // PTT Signals: Forward activityStart and activityEnd immediately (camelCase per v1beta spec)
                if (clientMsg.realtimeInput && (clientMsg.realtimeInput.activityStart || clientMsg.realtimeInput.activityEnd)) {
                    const signal = clientMsg.realtimeInput.activityStart ? 'activityStart' : 'activityEnd';
                    console.log(`🎤 [CLIENT -> RELAY] PTT Signal: ${signal}`);
                    geminiWs.send(messageStr);
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
                    geminiWs.send(messageStr);
                    return;
                }

                if (clientMsg.clientContent) {
                    console.log(`📡 [CLIENT -> RELAY] Turn Completion Signal Forwarded:\n${JSON.stringify(clientMsg, null, 2)}`);
                }

                // Tool Response from Android → forward to Gemini
                if (clientMsg.toolResponse) {
                    console.log(`${BLUE}🔵 [CLIENT -> RELAY] toolResponse Received:\n${JSON.stringify(clientMsg.toolResponse, null, 2)}${RESET}`);
                    
                    const responseMap = clientMsg.toolResponse.functionResponses?.[0]?.response;
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
                    geminiWs.send(jsonOut);
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
                                    result: `AMBIGUITY: Multiple matches found: ${matches}. Ask user to clarify which one.`
                                }
                            }]
                        }
                    };
                    console.log(`${BLUE}[ConflictHandler] Sending toolResponse for AMBIGUITY: ${matches}${RESET}`);
                    geminiWs.send(JSON.stringify(toolResponse));
                    return;
                }

                geminiWs.send(messageStr);
            } catch (e) {
                console.error(`[Relay] Error handling client JSON: ${e.message}`);
            }
        } else {
            geminiWs.send(message, { binary: true });
        }
    });

    clientWs.on('close', () => {
        console.log(`[Handshake] Client ${clientWs._id} Disconnected`);
        geminiWs.close();
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
});
