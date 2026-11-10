// Spend guardrails: how many Gemini sessions may be live, and how much one Tester may use per day.
// Kept free of socket/express imports so the policy is unit-testable. Counters are durable because
// a redeploy must not hand every Tester a fresh allowance.
const fs = require('node:fs');
const path = require('node:path');

const REASON = {
    GLOBAL_CAP: 'global_cap',
    GLOBAL_DAILY_OPENS: 'global_daily_opens',
    DAILY_OPENS: 'daily_opens',
    DAILY_AUDIO: 'daily_audio',
    HARD_STOP: 'hard_stop',
    BACKOFF: 'backoff',
};

// A refusal the Tester cannot wait out: retrying every 30s until midnight is just churn.
const PERSISTENT = new Set([REASON.DAILY_OPENS, REASON.DAILY_AUDIO, REASON.HARD_STOP, REASON.GLOBAL_DAILY_OPENS]);

function emptyData() {
    return { version: 1, day: '', globalOpens: 0, devices: Object.create(null) };
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
        if (/^[A-Za-z0-9_-]{6,128}$/.test(id)) devices[id] = rec;
    }
    return {
        version: 1,
        day: String(parsed.day || ''),
        globalOpens: Number(parsed.globalOpens) || 0,
        devices,
    };
}

function writeData(filePath, data) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...data, devices: { ...data.devices } }, null, 2));
    fs.renameSync(tmp, filePath);
}

function emptyCounters(day) {
    return {
        day,
        opens: 0,
        audioMs: 0,
        promptTokens: 0,
        responseTokens: 0,
        totalTokens: 0,
        lifetimeOpens: 0,
        lifetimeTokens: 0,
        consecutiveFailures: 0,
        hardStoppedAt: '',
        backoffUntil: 0,
    };
}

function createLimits(options = {}) {
    const {
        dataDir = '.',
        now = () => Date.now(),
        notify = () => {},
        // Google publishes no RPM/RPD for the live family any more (Oct 2026: per-project numbers
        // are only in the AI Studio dashboard). maxLiveSessions matches the documented free-tier
        // concurrent-session cap; the rest are deliberately conservative for three Testers.
        // Every value is env-tunable, but there is no off switch.
        maxLiveSessions = 3,
        globalDailyOpenLimit = 100,
        dailyOpenLimit = 40,
        dailyAudioMinutes = 20,
        dayOffsetMinutes = 180,
        maxConsecutiveFailures = 3,
        openBackoffMs = [2_000, 8_000],
        idleTeardownMs = 30_000,
        maxSessionMs = 15 * 60_000,
    } = options;

    const filePath = path.join(dataDir, 'pilot-usage.json');
    const data = readData(filePath);
    const live = new Map();
    const alertCooldowns = new Map();
    let savePending = false;

    function dayKey(ts = now()) {
        return new Date(ts + dayOffsetMinutes * 60_000).toISOString().slice(0, 10);
    }

    function save() {
        writeData(filePath, data);
        savePending = false;
    }

    // Audio arrives many times a second; a rename per chunk would thrash the volume. Counters are
    // written on open/close/refusal and at most once a second otherwise.
    function saveSoon() {
        if (savePending) return;
        savePending = true;
        setTimeout(() => {
            if (savePending) save();
        }, 1_000).unref?.();
    }

    function alert(kind, message, cooldownMs = 3_600_000) {
        const last = alertCooldowns.get(kind);
        if (last !== undefined && now() - last < cooldownMs) return false;
        alertCooldowns.set(kind, now());
        notify(kind, message);
        return true;
    }

    function rollDay() {
        const today = dayKey();
        if (data.day === today) return today;
        data.day = today;
        data.globalOpens = 0;
        for (const rec of Object.values(data.devices)) {
            rec.opens = 0;
            rec.audioMs = 0;
            rec.promptTokens = 0;
            rec.responseTokens = 0;
            rec.totalTokens = 0;
            rec.day = today;
            // A hard stop is a human decision to undo, not something midnight silently reverses.
        }
        save();
        return today;
    }

    function counters(deviceId) {
        const today = rollDay();
        const rec = data.devices[deviceId];
        if (!rec) {
            data.devices[deviceId] = emptyCounters(today);
            return data.devices[deviceId];
        }
        if (rec.day !== today) {
            const fresh = emptyCounters(today);
            fresh.lifetimeOpens = rec.lifetimeOpens || 0;
            fresh.lifetimeTokens = rec.lifetimeTokens || 0;
            fresh.consecutiveFailures = rec.consecutiveFailures || 0;
            fresh.hardStoppedAt = rec.hardStoppedAt || '';
            fresh.backoffUntil = rec.backoffUntil || 0;
            data.devices[deviceId] = fresh;
            return fresh;
        }
        return rec;
    }

    function liveCount() {
        let n = 0;
        for (const v of live.values()) n += v;
        return n;
    }

    function refuse(reason, retryAfterMs = 0) {
        return { ok: false, reason, persistent: PERSISTENT.has(reason), retryAfterMs };
    }

    /**
     * May this device open a Gemini session right now? Unidentified clients (legacy builds, or
     * tenancy disabled) are still bound by the global caps, which is what protects the shared
     * project quota.
     */
    function canOpen(deviceId = '') {
        rollDay();
        if (liveCount() >= maxLiveSessions) {
            alert('global_cap', `All ${maxLiveSessions} Gemini sessions are in use — a phone was told to wait`);
            return refuse(REASON.GLOBAL_CAP, idleTeardownMs);
        }
        if (data.globalOpens >= globalDailyOpenLimit) {
            alert('global_daily_opens', `Project-wide daily limit reached: ${data.globalOpens}/${globalDailyOpenLimit} Gemini opens`);
            return refuse(REASON.GLOBAL_DAILY_OPENS);
        }
        if (!deviceId) return { ok: true };

        const rec = counters(deviceId);
        if (rec.hardStoppedAt) {
            return refuse(REASON.HARD_STOP);
        }
        if (rec.backoffUntil > now()) {
            return refuse(REASON.BACKOFF, rec.backoffUntil - now());
        }
        if (rec.opens >= dailyOpenLimit) {
            alert('daily_opens', `Tester ${deviceId} used ${rec.opens}/${dailyOpenLimit} Gemini opens today`);
            return refuse(REASON.DAILY_OPENS);
        }
        if (rec.audioMs >= dailyAudioMinutes * 60_000) {
            alert('daily_audio', `Tester ${deviceId} used ${Math.round(rec.audioMs / 60_000)}/${dailyAudioMinutes} audio minutes today`);
            return refuse(REASON.DAILY_AUDIO);
        }
        return { ok: true };
    }

    function noteOpen(deviceId = '') {
        rollDay();
        data.globalOpens++;
        if (deviceId) {
            const rec = counters(deviceId);
            rec.opens++;
            rec.lifetimeOpens++;
            live.set(deviceId, (live.get(deviceId) || 0) + 1);
        } else {
            live.set('', (live.get('') || 0) + 1);
        }
        save();
    }

    function noteClose(deviceId = '') {
        const n = live.get(deviceId) || 0;
        if (n <= 1) live.delete(deviceId);
        else live.set(deviceId, n - 1);
    }

    /** Input audio only: PCM bytes are a deterministic measure that does not depend on Gemini's mood. */
    function noteAudio(deviceId, ms) {
        if (!deviceId || !(ms > 0)) return { exhausted: false };
        const rec = counters(deviceId);
        rec.audioMs += ms;
        saveSoon();
        const limitMs = dailyAudioMinutes * 60_000;
        if (rec.audioMs >= limitMs) {
            alert('daily_audio', `Tester ${deviceId} reached ${dailyAudioMinutes} audio minutes today`);
            return { exhausted: true };
        }
        return { exhausted: false };
    }

    function noteUsage(deviceId, usage = {}) {
        if (!deviceId) return;
        const rec = counters(deviceId);
        const prompt = Number(usage.promptTokens) || 0;
        const response = Number(usage.responseTokens) || 0;
        const total = Number(usage.totalTokens) || prompt + response;
        rec.promptTokens += prompt;
        rec.responseTokens += response;
        rec.totalTokens += total;
        rec.lifetimeTokens += total;
        saveSoon();
    }

    /** @return whether the relay must stop dialling Gemini for this Tester until a human clears it. */
    function noteFailure(deviceId = '') {
        if (!deviceId) return { hardStopped: false, failures: 0, retryAfterMs: 0 };
        const rec = counters(deviceId);
        rec.consecutiveFailures++;
        const backoff = openBackoffMs[Math.min(rec.consecutiveFailures - 1, openBackoffMs.length - 1)] || 0;
        rec.backoffUntil = now() + backoff;
        if (rec.consecutiveFailures >= maxConsecutiveFailures) {
            rec.hardStoppedAt = new Date(now()).toISOString();
            rec.backoffUntil = 0;
            save();
            alert('hard_stop', `Gemini failed ${rec.consecutiveFailures} times in a row for ${deviceId} — stopped trying. Clear it from the admin page.`);
            return { hardStopped: true, failures: rec.consecutiveFailures, retryAfterMs: 0 };
        }
        save();
        alert('gemini_open_failed', `Gemini open failed for ${deviceId} (${rec.consecutiveFailures}/${maxConsecutiveFailures}) — waiting ${backoff}ms`, 0);
        return { hardStopped: false, failures: rec.consecutiveFailures, retryAfterMs: backoff };
    }

    function noteSuccess(deviceId = '') {
        if (!deviceId) return;
        const rec = counters(deviceId);
        if (!rec.consecutiveFailures && !rec.backoffUntil) return;
        rec.consecutiveFailures = 0;
        rec.backoffUntil = 0;
        save();
    }

    function clearHardStop(deviceId) {
        const rec = data.devices[deviceId];
        if (!rec) return { ok: false, error: 'unknown_device' };
        rec.consecutiveFailures = 0;
        rec.hardStoppedAt = '';
        rec.backoffUntil = 0;
        save();
        return { ok: true };
    }

    function usageFor(deviceId) {
        const rec = data.devices[deviceId];
        if (!rec) return null;
        return {
            day: rec.day,
            opens: rec.opens,
            audioMinutes: Math.round((rec.audioMs / 60_000) * 10) / 10,
            promptTokens: rec.promptTokens,
            responseTokens: rec.responseTokens,
            totalTokens: rec.totalTokens,
            lifetimeOpens: rec.lifetimeOpens,
            lifetimeTokens: rec.lifetimeTokens,
            consecutiveFailures: rec.consecutiveFailures,
            hardStoppedAt: rec.hardStoppedAt || '',
            live: live.get(deviceId) || 0,
        };
    }

    function snapshot() {
        rollDay();
        return {
            day: data.day,
            dayOffsetMinutes,
            liveSessions: liveCount(),
            maxLiveSessions,
            globalOpens: data.globalOpens,
            globalDailyOpenLimit,
            dailyOpenLimit,
            dailyAudioMinutes,
            idleTeardownMs,
            maxSessionMs,
            devices: Object.keys(data.devices).map((id) => ({ deviceId: id, ...usageFor(id) })),
        };
    }

    rollDay();

    return {
        REASON,
        filePath,
        idleTeardownMs,
        maxSessionMs,
        dayKey,
        canOpen,
        noteOpen,
        noteClose,
        noteAudio,
        noteUsage,
        noteFailure,
        noteSuccess,
        clearHardStop,
        usageFor,
        snapshot,
        liveCount,
        flush: save,
    };
}

/** Milliseconds of 16-bit mono PCM at the rate named in the mimeType (Gemini input is 16 kHz). */
function pcmDurationMs(byteLength, mimeType = 'audio/pcm;rate=16000') {
    const m = /rate=(\d+)/.exec(String(mimeType));
    const rate = m ? Number(m[1]) : 16_000;
    if (!(rate > 0) || !(byteLength > 0)) return 0;
    return (byteLength / 2 / rate) * 1_000;
}

module.exports = { createLimits, REASON, PERSISTENT, pcmDurationMs };