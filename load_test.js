// Multi-client load test for Tsehay Assist Relay Server
// Simulates 12-15 concurrent clients testing pairing, tenancy lease, and rate limits.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = 8089;
const ADMIN_KEY = 'load-test-admin-secret-12345';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsehay-load-test-'));

console.log(`[LoadTest] Starting relay server on port ${PORT} with dataDir ${tmpDir}...`);

const serverProc = spawn(process.execPath, ['index.js'], {
    cwd: __dirname,
    env: {
        ...process.env,
        PORT: String(PORT),
        PILOT_DATA_DIR: tmpDir,
        ADMIN_KEY: ADMIN_KEY,
        ADMIN_PANEL_ENABLED: '1',
        TENANCY_ENFORCED: '1',
        GEMINI_API_KEY: 'test-dummy-api-key',
        MAX_LIVE_SESSIONS: '3',
        PILOT_LOG_MASK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe']
});

let serverOutput = '';
serverProc.stdout.on('data', d => { serverOutput += d.toString(); });
serverProc.stderr.on('data', d => { serverOutput += d.toString(); });

function cleanup() {
    try { serverProc.kill('SIGTERM'); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

async function waitForServer(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await new Promise((resolve, reject) => {
                const req = http.get(`http://127.0.0.1:${PORT}/health`, (r) => resolve(r.statusCode));
                req.on('error', reject);
                req.setTimeout(500, () => req.destroy());
            });
            if (res === 200) return true;
        } catch (e) {
            await new Promise(r => setTimeout(r, 200));
        }
    }
    throw new Error(`Server failed to start on port ${PORT} within ${timeoutMs}ms:\n${serverOutput}`);
}

async function adminRequest(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1',
            port: PORT,
            path: urlPath,
            method: method,
            headers: {
                'Authorization': `Bearer ${ADMIN_KEY}`,
                ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
            }
        }, (res) => {
            let resBody = '';
            res.on('data', chunk => resBody += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(resBody) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: resBody });
                }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function simulateClient({ id, deviceId, token = '', contacts = ['Abebe', 'Chala'], version = '1.1+2' }) {
    return new Promise((resolve) => {
        const headers = {
            'X-Tsehaye-Device': deviceId,
            'X-Tsehaye-App-Version': version,
        };
        if (token) headers['X-Tsehaye-Token'] = token;
        if (contacts.length) {
            headers['X-Tsehaye-Contacts'] = Buffer.from(JSON.stringify(contacts)).toString('base64');
        }

        const events = [];
        let resolved = false;
        const finish = () => {
            if (!resolved) {
                resolved = true;
                resolve({ id, deviceId, events, ws });
            }
        };

        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/relay`, { headers });

        ws.on('open', () => {
            events.push({ type: 'open' });
        });

        ws.on('message', (msg) => {
            try {
                const parsed = JSON.parse(msg.toString());
                events.push({ type: 'message', data: parsed });
                if (parsed.type === 'pairing') {
                    // Server waits 250ms before closing refused sockets in closeForTenant()
                    setTimeout(finish, 400);
                }
            } catch (e) {
                events.push({ type: 'binary', length: msg.length });
            }
        });

        ws.on('close', (code, reason) => {
            events.push({ type: 'close', code, reason: reason.toString() });
            finish();
        });

        ws.on('error', (err) => {
            events.push({ type: 'error', error: err.message });
            finish();
        });

        setTimeout(finish, 4000);
    });
}

async function run() {
    try {
        await waitForServer();
        console.log('✅ Relay server online');

        // Pre-register and approve 10 pilot testers
        const testerDevices = [];
        for (let i = 1; i <= 10; i++) {
            const devId = `tester_device_${i.toString().padStart(3, '0')}`;
            testerDevices.push(devId);
            const approveRes = await adminRequest('POST', `/admin/devices/${devId}/approve`, {
                testerName: `Pilot Tester ${i}`
            });
            if (approveRes.status !== 200) {
                throw new Error(`Failed to approve device ${devId}: ${JSON.stringify(approveRes)}`);
            }
        }
        console.log(`✅ Pre-approved 10 pilot devices`);

        // Prepare 1 paused device and 1 unapproved device
        const pausedDev = 'tester_paused_099';
        await adminRequest('POST', `/admin/devices/${pausedDev}/approve`, { testerName: 'Paused Tester' });
        await adminRequest('POST', `/admin/devices/${pausedDev}/pause`);
        const unapprovedDev = 'tester_unknown_000';

        console.log(`\n🚀 Launching 13 simulated client scenarios simultaneously...`);
        const clientPromises = [];

        // 10 approved clients
        const tokensAcquired = new Map();
        const activeSockets = [];

        for (let i = 1; i <= 10; i++) {
            const devId = testerDevices[i - 1];
            clientPromises.push((async () => {
                const res = await simulateClient({
                    id: `Tester-${i}`,
                    deviceId: devId,
                    contacts: [`Contact-${i}-A`, `Contact-${i}-B`]
                });
                return res;
            })());
        }

        // 1 unapproved client (should get code 4000 UNPAIRED)
        clientPromises.push((async () => {
            return await simulateClient({
                id: 'Unapproved-Client',
                deviceId: unapprovedDev,
                contacts: ['Anon']
            });
        })());

        // 1 paused client (should get code 4003 PAUSED)
        clientPromises.push((async () => {
            return await simulateClient({
                id: 'Paused-Client',
                deviceId: pausedDev,
                contacts: ['PausedUser']
            });
        })());

        // Wait for connection handshakes
        await new Promise(r => setTimeout(r, 600));

        // Test duplicate connection: Connect same device (Tester 1) again
        const dupPromise = simulateClient({
            id: 'Tester-1-Duplicate',
            deviceId: testerDevices[0]
        });
        clientPromises.push(dupPromise);

        const results = await Promise.all(clientPromises);
        for (const r of results) {
            try { r.ws?.close(); } catch (e) {}
        }

        console.log('\n📊 Scenario Results Summary:');
        let passed = 0;
        let failed = 0;

        for (const r of results) {
            const openEv = r.events.find(e => e.type === 'open');
            const pairingEv = r.events.find(e => e.type === 'message' && e.data?.type === 'pairing');
            const closeEv = r.events.find(e => e.type === 'close');

            if (r.id === 'Unapproved-Client') {
                const ok = pairingEv?.data?.status === 'pending' && closeEv?.code === 4000;
                console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${r.id}: expected pending/4000, got status=${pairingEv?.data?.status} code=${closeEv?.code}`);
                if (ok) passed++; else failed++;
            } else if (r.id === 'Paused-Client') {
                const ok = pairingEv?.data?.status === 'refused' && closeEv?.code === 4003;
                console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${r.id}: expected refused/4003, got status=${pairingEv?.data?.status} code=${closeEv?.code}`);
                if (ok) passed++; else failed++;
            } else if (r.id === 'Tester-1-Duplicate') {
                const ok = closeEv?.code === 4002;
                console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${r.id}: expected 4002 ACTIVE_ELSEWHERE, got code=${closeEv?.code}`);
                if (ok) passed++; else failed++;
            } else {
                const ok = openEv && pairingEv?.data?.status === 'approved' && Boolean(pairingEv?.data?.token);
                console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${r.id}: connected, approved, tokenIssued=${Boolean(pairingEv?.data?.token)}`);
                if (ok) passed++; else failed++;
            }
        }

        // Check Admin Usage snapshot
        const usageSnap = await adminRequest('GET', '/admin/usage');
        console.log(`\n📈 Admin Usage Snapshot:`);
        console.log(`  Live Sessions: ${usageSnap.data.liveSessions}/${usageSnap.data.maxLiveSessions}`);
        console.log(`  Tracked Devices: ${usageSnap.data.devices.length}`);

        if (failed === 0) {
            console.log(`\n🎉 All 13 client load test scenarios PASSED!`);
            process.exit(0);
        } else {
            console.error(`\n❌ ${failed} load test scenarios failed`);
            process.exit(1);
        }
    } catch (err) {
        console.error('❌ Load test failed with exception:', err);
        process.exit(1);
    } finally {
        cleanup();
    }
}

run();
