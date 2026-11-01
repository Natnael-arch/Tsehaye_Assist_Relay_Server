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

Two environment variables control the Gemini Live connection:

- `GEMINI_LIVE_MODEL` — model to use. Default: `gemini-3.8-live`. To roll back, set `export GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview`.
- `GEMINI_TOOL_BEHAVIOR` — function-call behavior. Default: `BLOCKING`, so the model waits for each tool response (required for the call/text confirmation flow). Set to `NON_BLOCKING` only if you intentionally want async tool calls.

The startup log prints the resolved model path and tool behavior so you can verify what the relay is using.

## 5. Why this matters
The Node.js relay ensures high-performance WebSocket proxying. By running this proxy, the server establishes the secure connection to Google's Gemini Live API, protecting the API key from exposure in the client application and handling authentication securely.
