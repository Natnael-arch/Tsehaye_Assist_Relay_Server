// Tester tenancy: who is allowed to hold a Gemini session, and on how many phones at once.
// Kept free of socket/express imports so the decision table is unit-testable.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STATUS = {
    PENDING: 'pending',
    APPROVED: 'approved',
    PAUSED: 'paused',
    REVOKED: 'revoked',
};

// Application close codes. The app maps each one to a spoken clip and stops reconnecting.
const CLOSE = {
    UNPAIRED: 4000,
    REVOKED: 4001,
    ACTIVE_ELSEWHERE: 4002,
    PAUSED: 4003,
    IDENTITY_MISMATCH: 4004,
    UNAVAILABLE: 4005,
};

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

function newToken() {
    return crypto.randomBytes(16).toString('hex');
}

function emptyData() {
    return { version: 1, devices: Object.create(null) };
}

function readData(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return emptyData();
        throw e;
    }
    const parsed = JSON.parse(raw);
    const devices = Object.create(null);
    for (const [id, rec] of Object.entries(parsed.devices || {})) {
        if (DEVICE_ID_PATTERN.test(id)) devices[id] = rec;
    }
    return { version: 1, devices };
}

// Railway's filesystem is ephemeral, so the pairing table lives on a mounted volume and every
// write is temp+rename: a crash mid-write must not leave a half-written table that strands the pilot.
function writeData(filePath, data) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...data, devices: { ...data.devices } }, null, 2));
    fs.renameSync(tmp, filePath);
}

function createTenancy(options = {}) {
    const {
        dataDir = '.',
        now = () => Date.now(),
        notify = () => {},
        enforced = true,
        leaseTtlMs = 75_000,
        maxPendingDevices = 25,
    } = options;

    const filePath = path.join(dataDir, 'pilot-pairing.json');
    const data = readData(filePath);
    const leases = Object.create(null);
    const alertCooldowns = new Map();

    function save() {
        writeData(filePath, data);
    }

    // An unannounced guardrail is indistinguishable from a broken product, so every refusal of
    // consequence reaches the host — but at most once per kind per cooldown window.
    function alert(kind, message, cooldownMs = 3_600_000) {
        const last = alertCooldowns.get(kind);
        if (last !== undefined && now() - last < cooldownMs) return false;
        alertCooldowns.set(kind, now());
        notify(kind, message);
        return true;
    }

    function deviceCountByStatus(status) {
        return Object.values(data.devices).filter((d) => d.status === status).length;
    }

    function noteDevice(deviceId, fields) {
        const rec = data.devices[deviceId] || {
            status: STATUS.PENDING,
            createdAt: new Date(now()).toISOString(),
            token: '',
            testerName: '',
            signatureHash: '',
        };
        Object.assign(rec, fields);
        rec.lastSeenAt = new Date(now()).toISOString();
        data.devices[deviceId] = rec;
        return rec;
    }

    function decide(headers = {}) {
        const deviceId = String(headers.deviceId || '').trim();
        const token = String(headers.token || '').trim();
        const signatureHash = String(headers.signatureHash || '').trim();
        const appVersion = String(headers.appVersion || '').trim();

        if (!enforced) {
            return { action: 'serve', reason: 'tenancy_disabled', deviceId: '', testerName: '' };
        }

        if (!deviceId) {
            alert('no_device_id', 'Connection refused: no device identity sent');
            return { action: 'refuse', closeCode: CLOSE.IDENTITY_MISMATCH, reason: 'no_device_id' };
        }
        if (!DEVICE_ID_PATTERN.test(deviceId)) {
            alert('bad_device_id', `Connection refused: malformed device identity (${deviceId.slice(0, 12)}…)`);
            return { action: 'refuse', closeCode: CLOSE.IDENTITY_MISMATCH, reason: 'malformed_device_id' };
        }

        const rec = data.devices[deviceId];

        if (!rec) {
            if (deviceCountByStatus(STATUS.PENDING) >= maxPendingDevices) {
                alert('pending_full', `Rejected a new pairing request: ${maxPendingDevices} devices already pending`);
                return { action: 'refuse', closeCode: CLOSE.UNAVAILABLE, reason: 'pending_full' };
            }
            noteDevice(deviceId, { appVersion, signatureHash });
            save();
            alert('pending_request', `New phone asking to be paired: ${deviceId}`, 0);
            return { action: 'pending', closeCode: CLOSE.UNPAIRED, reason: 'awaiting_approval', deviceId };
        }

        noteDevice(deviceId, { appVersion: appVersion || rec.appVersion });

        // A pending phone reconnects every 30 seconds; being asked twice is not the host approving.
        if (rec.status === STATUS.PENDING) {
            save();
            return { action: 'pending', closeCode: CLOSE.UNPAIRED, reason: 'awaiting_approval', deviceId };
        }

        if (rec.status === STATUS.PAUSED) {
            save();
            return { action: 'refuse', closeCode: CLOSE.PAUSED, reason: 'paused', deviceId, testerName: rec.testerName };
        }
        if (rec.status === STATUS.REVOKED) {
            save();
            return { action: 'refuse', closeCode: CLOSE.REVOKED, reason: 'revoked', deviceId, testerName: rec.testerName };
        }

        if (rec.token && token && token !== rec.token) {
            save();
            alert('token_mismatch', `Token rejected for ${rec.testerName || deviceId}: presented token does not match the pairing`);
            return { action: 'refuse', closeCode: CLOSE.IDENTITY_MISMATCH, reason: 'token_mismatch', deviceId };
        }

        if (rec.signatureHash && signatureHash && signatureHash !== rec.signatureHash) {
            save();
            alert(
                'signature_mismatch',
                `Signing key changed for ${rec.testerName || deviceId} — every ANDROID_ID may have rotated. Pairings intact, but watch for mass re-pairing.`
            );
        }

        // The invisible handshake: a phone cannot type a code, so the first connection from an
        // approved device identity is what receives the bearer token.
        let issueToken = '';
        if (!rec.token) {
            issueToken = newToken();
            rec.token = issueToken;
            rec.tokenIssuedAt = new Date(now()).toISOString();
            if (signatureHash) rec.signatureHash = signatureHash;
        }
        save();

        const lease = leases[deviceId];
        if (lease && now() - lease.seenAt < leaseTtlMs && lease.socketId !== undefined) {
            return {
                action: 'refuse',
                closeCode: CLOSE.ACTIVE_ELSEWHERE,
                reason: 'active_elsewhere',
                deviceId,
                testerName: rec.testerName,
                since: lease.acquiredAt,
            };
        }

        return {
            action: 'serve',
            reason: issueToken ? 'token_issued' : 'approved',
            deviceId,
            testerName: rec.testerName,
            issueToken,
        };
    }

    function acquireLease(deviceId, socketId) {
        if (!deviceId) return true;
        leases[deviceId] = { socketId, acquiredAt: now(), seenAt: now() };
        return true;
    }

    function renewLease(deviceId) {
        if (leases[deviceId]) leases[deviceId].seenAt = now();
    }

    function releaseLease(deviceId, socketId) {
        const lease = leases[deviceId];
        if (!lease) return false;
        if (socketId !== undefined && lease.socketId !== socketId) return false;
        delete leases[deviceId];
        return true;
    }

    function currentSocketId(deviceId) {
        return leases[deviceId] ? leases[deviceId].socketId : null;
    }

    function listDevices() {
        return Object.entries(data.devices).map(([deviceId, rec]) => ({
            deviceId,
            status: rec.status,
            testerName: rec.testerName || '',
            createdAt: rec.createdAt,
            lastSeenAt: rec.lastSeenAt || '',
            appVersion: rec.appVersion || '',
            hasToken: Boolean(rec.token),
            activeElsewhere: Boolean(leases[deviceId]),
        }));
    }

    function findDevice(rawId) {
        const id = String(rawId || '').trim();
        if (!DEVICE_ID_PATTERN.test(id)) return null;
        return data.devices[id] ? { deviceId: id, ...data.devices[id] } : null;
    }

    function setStatus(rawId, status, extra = {}) {
        const found = findDevice(rawId);
        if (!found) return { ok: false, error: 'unknown_device' };
        const rec = data.devices[found.deviceId];
        rec.status = status;
        Object.assign(rec, extra);
        rec.updatedAt = new Date(now()).toISOString();
        save();
        if (status !== STATUS.APPROVED) releaseLease(found.deviceId);
        return { ok: true, device: { deviceId: found.deviceId, ...rec } };
    }

    return {
        STATUS,
        CLOSE,
        filePath,
        decide,
        listDevices,
        findDevice,
        acquireLease,
        renewLease,
        releaseLease,
        currentSocketId,
        alert,
        // The host registers a Tester by name and device before the phone is ever handed over,
        // so approval must also work on a device that has not connected yet.
        approve: (id, testerName) => {
            const found = findDevice(id);
            if (!found) {
                const cleanId = String(id || '').trim();
                if (!DEVICE_ID_PATTERN.test(cleanId)) return { ok: false, error: 'malformed_device_id' };
                const rec = noteDevice(cleanId, {
                    status: STATUS.APPROVED,
                    testerName: String(testerName || '').slice(0, 60),
                    approvedAt: new Date(now()).toISOString(),
                });
                save();
                return { ok: true, device: { deviceId: cleanId, ...rec } };
            }
            return setStatus(found.deviceId, STATUS.APPROVED, {
                testerName: String(testerName || '').slice(0, 60),
                approvedAt: new Date(now()).toISOString(),
            });
        },
        pause: (id) => setStatus(id, STATUS.PAUSED, {}),
        revoke: (id) => setStatus(id, STATUS.REVOKED, { token: '' }),
        resume: (id) => setStatus(id, STATUS.APPROVED, {}),
        forget: (id) => {
            const found = findDevice(id);
            if (!found) return { ok: false, error: 'unknown_device' };
            delete data.devices[found.deviceId];
            releaseLease(found.deviceId);
            save();
            return { ok: true };
        },
        enforced,
    };
}

module.exports = { createTenancy, CLOSE, STATUS, DEVICE_ID_PATTERN, newToken };
