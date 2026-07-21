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

## 4. Why this matters
The Node.js relay ensures high-performance WebSocket proxying. By running this proxy, the server establishes the secure connection to Google's Gemini Live API, protecting the API key from exposure in the client application and handling authentication securely.
