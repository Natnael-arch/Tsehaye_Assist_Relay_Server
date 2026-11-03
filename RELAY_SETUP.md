# How to Run the Tsehaye Assist Secure Proxy Relay (Node.js)

This relay server hides your Gemini API key from the Android frontend and forwards WebSocket communication with the correct headers to allow the BidiGenerateContent endpoint to function seamlessly.

## 1. Prerequisites
- Node.js (v18+) and npm installed.

## 2. Setup
Open a terminal in `relay-server` and run:

```bash
# 1. Install dependencies
npm install

# 2. Set your environment variables
export GEMINI_API_KEY="YOUR_ACTUAL_GEMINI_API_KEY_HERE"
export ADMIN_KEY="YOUR_ADMIN_SECRET_KEY_HERE"

# 3. Start the relay
npm start
```

## 3. Verify
- The server will start on `http://0.0.0.0:8080` (or `PORT` specified in environment).
- The health check is available at `http://localhost:8080/health`.

## 4. Model & Tool Behavior Configuration

Three environment variables control the Gemini Live connection:

- `GEMINI_LIVE_MODEL` — model to use. Default: `gemini-3.8-live`. To roll back, set `export GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview`.
- `GEMINI_TOOL_BEHAVIOR` — function-call behavior. Default: `BLOCKING`, so the model waits for each tool response (required for the call/text confirmation flow). Set to `NON_BLOCKING` only if you intentionally want async tool calls.
- `GEMINI_VOCAB_LIMIT` — how many contact names the app sends as speech-biasing vocabulary. Default: `20`, and `.env` pins it to `20`. Biasing is what keeps Ethiopian names intelligible: an A/B run on a real phone with the same spoken requests, list on vs off, turned "Mom" into "Marmalade" and "Yihun" into Korean, and produced an ambiguity menu for 6 of 8 searches instead of 3 of 9. Set `GEMINI_VOCAB_LIMIT=0` to disable it for experiments only. An unset variable no longer means off.

Names in the biasing list can be echoed back by the model as a fake transcription when the mic hears
near-silence, which is why the app gates push-to-talk on a 300 ms hold and the relay logs
`[VOCAB-ECHO] heard="…" terms=N` (log-only, at 5 or more distinct terms) for any such turn.

The startup log prints the resolved model path and tool behavior so you can verify what the relay is using. Each client connection also logs `[BIASING] vocab=<n>` and the exact `[BIASING-LIST]` sent, so you can confirm biasing is active from the relay side.

## 5. Why this matters
The Node.js relay ensures high-performance WebSocket proxying. By running this proxy, the server establishes the secure connection to Google's Gemini Live API, protecting the API key from exposure in the client application and handling authentication securely.
