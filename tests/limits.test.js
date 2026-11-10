const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLimits, REASON, pcmDurationMs } = require('../limits');

function harness(overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsehaye-limits-'));
    // 2026-11-09T09:00:00Z — 12:00 in Addis Ababa, so the day key is unambiguous.
    let clock = Date.UTC(2026, 10, 9, 9, 0, 0);
    const alerts = [];
    const l = createLimits({
        dataDir: dir,
        now: () => clock,
        notify: (kind, message) => alerts.push({ kind, message }),
        maxLiveSessions: 2,
        globalDailyOpenLimit: 6,
        dailyOpenLimit: 3,
        dailyAudioMinutes: 1,
        dayOffsetMinutes: 180,
        maxConsecutiveFailures: 3,
        openBackoffMs: [2_000, 8_000],
        ...overrides,
    });
    return { l, dir, alerts, advance: (ms) => { clock += ms; }, setClock: (v) => { clock = v; } };
}

const DEV = 'a1b2c3d4e5f60708';
const DEV2 = 'b2c3d4e5f6070809';

test('the day key follows the Tester local offset, not UTC', () => {
    const { l } = harness();
    // 22:30 UTC is 01:30 next day in Addis Ababa.
    assert.equal(l.dayKey(Date.UTC(2026, 10, 9, 22, 30)), '2026-11-10');
    assert.equal(l.dayKey(Date.UTC(2026, 10, 9, 9, 0)), '2026-11-09');
});

test('asking whether an open is allowed does not spend the allowance', () => {
    const { l } = harness({ maxSessionMs: 600_000 });
    for (let i = 0; i < 5; i++) assert.equal(l.canOpen(DEV).ok, true);
    assert.equal(l.snapshot().globalOpens, 0);
    assert.equal(l.snapshot().maxSessionMs, 600_000);
    assert.equal(l.usageFor(DEV).opens, 0);
});

test('the global live-session cap refuses the next phone and frees up on close', () => {
    const { l, alerts } = harness();
    l.noteOpen(DEV);
    l.noteOpen(DEV2);
    assert.equal(l.liveCount(), 2);
    const refused = l.canOpen('c3d4e5f607080910');
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, REASON.GLOBAL_CAP);
    assert.equal(refused.persistent, false);
    assert.ok(refused.retryAfterMs > 0);
    assert.equal(alerts.filter((a) => a.kind === 'global_cap').length, 1);
    l.noteClose(DEV);
    assert.equal(l.canOpen(DEV).ok, true);
});

test('one Tester cannot hold two live sessions by double-counting a close', () => {
    const { l } = harness();
    l.noteOpen(DEV);
    l.noteClose(DEV);
    l.noteClose(DEV);
    assert.equal(l.liveCount(), 0);
});

test('the per-Tester daily open budget is a hard stop, not a warning', () => {
    const { l, alerts } = harness();
    for (let i = 0; i < 3; i++) {
        assert.equal(l.canOpen(DEV).ok, true);
        l.noteOpen(DEV);
        l.noteClose(DEV);
    }
    const refused = l.canOpen(DEV);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, REASON.DAILY_OPENS);
    assert.equal(refused.persistent, true);
    assert.equal(alerts.filter((a) => a.kind === 'daily_opens').length, 1);
    // A different Tester still has their own allowance.
    assert.equal(l.canOpen(DEV2).ok, true);
});

test('the project-wide daily open cap protects the shared free-tier quota', () => {
    const { l } = harness({ globalDailyOpenLimit: 2 });
    l.noteOpen(DEV);
    l.noteClose(DEV);
    l.noteOpen(DEV2);
    l.noteClose(DEV2);
    const refused = l.canOpen('c3d4e5f607080910');
    assert.equal(refused.reason, REASON.GLOBAL_DAILY_OPENS);
    assert.equal(refused.persistent, true);
});

test('audio minutes are counted from PCM and exhaust the day', () => {
    const { l, alerts } = harness();
    assert.equal(l.noteAudio(DEV, 30_000).exhausted, false);
    assert.equal(l.usageFor(DEV).audioMinutes, 0.5);
    assert.equal(l.noteAudio(DEV, 30_000).exhausted, true);
    const refused = l.canOpen(DEV);
    assert.equal(refused.reason, REASON.DAILY_AUDIO);
    assert.equal(refused.persistent, true);
    assert.ok(alerts.some((a) => a.kind === 'daily_audio'));
});

test('three consecutive Gemini open failures hard-stop the Tester, with backoff before that', () => {
    const { l, alerts, advance } = harness();
    const first = l.noteFailure(DEV);
    assert.equal(first.hardStopped, false);
    assert.equal(first.retryAfterMs, 2_000);
    assert.equal(l.canOpen(DEV).reason, REASON.BACKOFF);
    advance(2_001);
    assert.equal(l.canOpen(DEV).ok, true);

    const second = l.noteFailure(DEV);
    assert.equal(second.retryAfterMs, 8_000);
    advance(8_001);
    const third = l.noteFailure(DEV);
    assert.equal(third.hardStopped, true);
    const refused = l.canOpen(DEV);
    assert.equal(refused.reason, REASON.HARD_STOP);
    assert.equal(refused.persistent, true);
    assert.ok(alerts.some((a) => a.kind === 'hard_stop'));
    // Waiting does not clear a hard stop.
    advance(24 * 3_600_000);
    assert.equal(l.canOpen(DEV).reason, REASON.HARD_STOP);
});

test('a successful open clears the failure streak', () => {
    const { l, advance } = harness();
    l.noteFailure(DEV);
    advance(2_001);
    l.noteFailure(DEV);
    advance(8_001);
    l.noteSuccess(DEV);
    assert.equal(l.usageFor(DEV).consecutiveFailures, 0);
    const next = l.noteFailure(DEV);
    assert.equal(next.hardStopped, false);
    assert.equal(next.retryAfterMs, 2_000);
});

test('the host can clear a hard stop, and only for a device that exists', () => {
    const { l } = harness();
    l.noteFailure(DEV);
    l.noteFailure(DEV);
    l.noteFailure(DEV);
    assert.equal(l.clearHardStop('nope').ok, false);
    assert.equal(l.clearHardStop(DEV).ok, true);
    assert.equal(l.canOpen(DEV).ok, true);
    assert.equal(l.usageFor(DEV).hardStoppedAt, '');
});

test('counters survive a restart — a redeploy must not refill every allowance', () => {
    const { l, dir } = harness();
    l.noteOpen(DEV);
    l.noteAudio(DEV, 45_000);
    l.noteUsage(DEV, { promptTokens: 100, responseTokens: 40, totalTokens: 140 });
    l.flush();
    const reopened = createLimits({
        dataDir: dir,
        now: () => Date.UTC(2026, 10, 9, 9, 0, 0),
        dayOffsetMinutes: 180,
        dailyOpenLimit: 3,
        dailyAudioMinutes: 1,
    });
    assert.equal(reopened.usageFor(DEV).opens, 1);
    assert.equal(reopened.usageFor(DEV).audioMinutes, 0.8);
    assert.equal(reopened.usageFor(DEV).totalTokens, 140);
    assert.equal(reopened.snapshot().globalOpens, 1);
    // Live sessions are memory-only: a redeploy must not strand a Tester behind a ghost session.
    assert.equal(reopened.liveCount(), 0);
});

test('midnight resets the daily allowance but keeps lifetime totals and the hard stop', () => {
    const { l, setClock } = harness();
    l.noteOpen(DEV);
    l.noteClose(DEV);
    l.noteOpen(DEV);
    l.noteClose(DEV);
    l.noteOpen(DEV);
    l.noteClose(DEV);
    l.noteAudio(DEV, 60_000);
    l.noteUsage(DEV, { totalTokens: 500 });
    l.noteFailure(DEV);
    l.noteFailure(DEV);
    l.noteFailure(DEV);
    assert.equal(l.canOpen(DEV).reason, REASON.HARD_STOP);

    setClock(Date.UTC(2026, 10, 9, 21, 30)); // 00:30 next day in Addis Ababa
    assert.equal(l.canOpen(DEV).reason, REASON.HARD_STOP);
    l.clearHardStop(DEV);
    assert.equal(l.canOpen(DEV).ok, true);
    const u = l.usageFor(DEV);
    assert.equal(u.opens, 0);
    assert.equal(u.audioMinutes, 0);
    assert.equal(u.totalTokens, 0);
    assert.equal(u.lifetimeOpens, 3);
    assert.equal(u.lifetimeTokens, 500);
    assert.equal(l.snapshot().globalOpens, 0);
});

test('an unidentified legacy client is still bound by the global caps', () => {
    const { l } = harness({ maxLiveSessions: 1 });
    assert.equal(l.canOpen('').ok, true);
    l.noteOpen('');
    assert.equal(l.canOpen('').reason, REASON.GLOBAL_CAP);
    assert.equal(l.usageFor(''), null);
    l.noteClose('');
    assert.equal(l.canOpen('').ok, true);
});

test('token usage accumulates per Tester for the cost column', () => {
    const { l } = harness();
    l.noteUsage(DEV, { promptTokens: 10, responseTokens: 5 });
    l.noteUsage(DEV, { promptTokens: 7, responseTokens: 3, totalTokens: 10 });
    const u = l.usageFor(DEV);
    assert.equal(u.promptTokens, 17);
    assert.equal(u.responseTokens, 8);
    assert.equal(u.totalTokens, 25);
    assert.equal(u.lifetimeTokens, 25);
});

test('PCM duration uses the rate in the mimeType', () => {
    // one second of 16 kHz 16-bit mono
    assert.equal(pcmDurationMs(32_000, 'audio/pcm;rate=16000'), 1_000);
    assert.equal(pcmDurationMs(48_000, 'audio/pcm;rate=24000'), 1_000);
    assert.equal(pcmDurationMs(32_000), 1_000);
    assert.equal(pcmDurationMs(0), 0);
    assert.equal(pcmDurationMs(100, 'audio/pcm;rate=0'), 0);
});

test('the usage file is written atomically and never left half-written', () => {
    const { l, dir } = harness();
    l.noteOpen(DEV);
    const files = fs.readdirSync(dir);
    assert.deepEqual(files, ['pilot-usage.json']);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'pilot-usage.json'), 'utf8'));
    assert.equal(parsed.devices[DEV].opens, 1);
});

test('a corrupt usage file fails loudly at boot rather than silently refilling every allowance', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsehaye-limits-corrupt-'));
    fs.writeFileSync(path.join(dir, 'pilot-usage.json'), '{"devices":');
    assert.throws(() => createLimits({ dataDir: dir }), SyntaxError);
});