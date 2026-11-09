const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTenancy, CLOSE, STATUS } = require('../tenancy');

function harness(overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsehaye-tenancy-'));
    let clock = 1_000_000;
    const alerts = [];
    const t = createTenancy({
        dataDir: dir,
        enforced: true,
        leaseTtlMs: 75_000,
        maxPendingDevices: 3,
        now: () => clock,
        notify: (kind, message) => alerts.push({ kind, message }),
        ...overrides,
    });
    return { t, dir, alerts, advance: (ms) => { clock += ms; } };
}

const DEV = 'a1b2c3d4e5f60708';

test('disabled tenancy serves everything and records nothing', () => {
    const { t } = harness({ enforced: false });
    const d = t.decide({});
    assert.equal(d.action, 'serve');
    assert.equal(d.reason, 'tenancy_disabled');
    assert.equal(t.listDevices().length, 0);
});

test('connection with no device identity is refused, not silently served', () => {
    const { t, alerts } = harness();
    const d = t.decide({ token: 'whatever' });
    assert.equal(d.action, 'refuse');
    assert.equal(d.closeCode, CLOSE.IDENTITY_MISMATCH);
    assert.equal(alerts.filter((a) => a.kind === 'no_device_id').length, 1);
});

test('malformed device ids are refused, including path-ish and proto keys', () => {
    const { t } = harness();
    for (const bad of ['../../etc/passwd', 'short', 'has space', 'x'.repeat(200), 'protobuf/one']) {
        assert.equal(t.decide({ deviceId: bad }).action, 'refuse', bad);
    }
    assert.equal(t.listDevices().length, 0);
});

test('unknown phone becomes a pending device and gets no Gemini session', () => {
    const { t, alerts } = harness();
    const d = t.decide({ deviceId: DEV, appVersion: '2', signatureHash: 'sig' });
    assert.equal(d.action, 'pending');
    assert.equal(d.closeCode, CLOSE.UNPAIRED);
    const rec = t.listDevices()[0];
    assert.equal(rec.status, STATUS.PENDING);
    assert.equal(rec.appVersion, '2');
    assert.equal(rec.hasToken, false);
    assert.equal(alerts.filter((a) => a.kind === 'pending_request').length, 1);
});

test('a pending phone stays pending until the host approves it', () => {
    const { t } = harness();
    t.decide({ deviceId: DEV });
    assert.equal(t.decide({ deviceId: DEV }).action, 'pending');
    assert.equal(t.approve(DEV, 'Almaz').ok, true);
    const served = t.decide({ deviceId: DEV });
    assert.equal(served.action, 'serve');
    assert.equal(served.testerName, 'Almaz');
    assert.match(served.issueToken, /^[0-9a-f]{32}$/);
});

test('token is issued once and a mismatched token is refused', () => {
    const { t, alerts } = harness();
    t.approve(DEV, 'Bekele');
    const first = t.decide({ deviceId: DEV });
    assert.match(first.issueToken, /^[0-9a-f]{32}$/);
    const second = t.decide({ deviceId: DEV, token: first.issueToken });
    assert.equal(second.action, 'serve');
    assert.equal(second.issueToken, '', 'a device that already holds a token must not be issued a second one');
    assert.equal(t.decide({ deviceId: DEV, token: 'deadbeefdeadbeef' }).closeCode, CLOSE.IDENTITY_MISMATCH);
    assert.equal(alerts.filter((a) => a.kind === 'token_mismatch').length, 1);
});

test('a device identity presenting no token is still served — deliberate bootstrap weakness', () => {
    const { t } = harness();
    t.approve(DEV, 'Chaltu');
    t.decide({ deviceId: DEV });
    assert.equal(t.decide({ deviceId: DEV }).action, 'serve');
});

test('paused refuses with 4003 and resume serves again', () => {
    const { t } = harness();
    t.approve(DEV, 'Dawit');
    t.decide({ deviceId: DEV });
    t.pause(DEV);
    const d = t.decide({ deviceId: DEV });
    assert.equal(d.action, 'refuse');
    assert.equal(d.closeCode, CLOSE.PAUSED);
    assert.equal(d.reason, 'paused');
    t.resume(DEV);
    assert.equal(t.decide({ deviceId: DEV }).action, 'serve');
});

test('revoked refuses with 4001, clears the token, and re-approval issues a new one', () => {
    const { t } = harness();
    t.approve(DEV, 'Eyerus');
    const first = t.decide({ deviceId: DEV }).issueToken;
    t.revoke(DEV);
    assert.equal(t.decide({ deviceId: DEV }).closeCode, CLOSE.REVOKED);
    t.approve(DEV, 'Eyerus');
    const again = t.decide({ deviceId: DEV });
    assert.equal(again.action, 'serve');
    assert.notEqual(again.issueToken, first);
});

test('a second live connection is refused with ACTIVE_ELSEWHERE, not a kick', () => {
    const { t } = harness();
    t.approve(DEV, 'Fikir');
    const d = t.decide({ deviceId: DEV });
    t.acquireLease(DEV, 'sock-1');
    const second = t.decide({ deviceId: DEV, token: d.issueToken });
    assert.equal(second.action, 'refuse');
    assert.equal(second.closeCode, CLOSE.ACTIVE_ELSEWHERE);
    assert.equal(t.currentSocketId(DEV), 'sock-1', 'the live socket must keep its lease');
});

test('a stale lease expires so a crashed phone is not locked out by its own ghost', () => {
    const { t, advance } = harness();
    t.approve(DEV, 'Girma');
    const d = t.decide({ deviceId: DEV });
    t.acquireLease(DEV, 'sock-1');
    advance(76_000);
    assert.equal(t.decide({ deviceId: DEV, token: d.issueToken }).action, 'serve');
    t.acquireLease(DEV, 'sock-2');
    assert.equal(t.releaseLease(DEV, 'sock-1'), false, 'a departing socket must not free another socket’s lease');
    assert.equal(t.releaseLease(DEV, 'sock-2'), true);
});

test('pause releases the lease so the phone on the other end stops holding one', () => {
    const { t } = harness();
    t.approve(DEV, 'Hail');
    t.decide({ deviceId: DEV });
    t.acquireLease(DEV, 'sock-1');
    t.pause(DEV);
    assert.equal(t.currentSocketId(DEV), null);
});

test('a changed signing key alerts the host but does not lock the tester out', () => {
    const { t, alerts, advance } = harness();
    t.approve(DEV, 'Iyasu');
    t.decide({ deviceId: DEV, signatureHash: 'key-A' });
    const d = t.decide({ deviceId: DEV, signatureHash: 'key-B' });
    assert.equal(d.action, 'serve');
    assert.equal(alerts.filter((a) => a.kind === 'signature_mismatch').length, 1);
    advance(60_000);
    t.decide({ deviceId: DEV, signatureHash: 'key-B' });
    assert.equal(alerts.filter((a) => a.kind === 'signature_mismatch').length, 1, 'the same alert must not storm the host');
});

test('pending devices are capped so the url cannot be flooded with requests', () => {
    const { t, alerts } = harness({ maxPendingDevices: 2 });
    t.decide({ deviceId: 'deviceaaaa1111' });
    t.decide({ deviceId: 'devicebbbb2222' });
    const d = t.decide({ deviceId: 'devicecccc3333' });
    assert.equal(d.action, 'refuse');
    assert.equal(d.closeCode, CLOSE.UNAVAILABLE);
    assert.equal(alerts.filter((a) => a.kind === 'pending_full').length, 1);
    assert.equal(t.listDevices().length, 2);
});

test('the pairing table survives a process restart', () => {
    const { t, dir } = harness();
    t.approve(DEV, 'Mestawos');
    const issued = t.decide({ deviceId: DEV }).issueToken;
    const reopened = createTenancyFresh(dir);
    const list = reopened.listDevices();
    assert.equal(list.length, 1);
    assert.equal(list[0].testerName, 'Mestawos');
    assert.equal(list[0].status, STATUS.APPROVED);
    assert.equal(list[0].hasToken, true);
    const again = reopened.decide({ deviceId: DEV, token: issued });
    assert.equal(again.action, 'serve');
    assert.equal(again.issueToken, '', 'the stored token is the credential, not a new one per boot');
});

test('a proto-named device id cannot pollute object prototypes', () => {
    const { t } = harness();
    t.decide({ deviceId: '__proto__', appVersion: '9' });
    assert.equal({}.testerName, undefined);
    assert.equal({}.appVersion, undefined);
    assert.equal(t.listDevices().length, 1);
});

test('admin actions on an unknown device fail cleanly', () => {
    const { t } = harness();
    assert.deepEqual(t.pause('nosuchdevice123'), { ok: false, error: 'unknown_device' });
    assert.deepEqual(t.revoke('nosuchdevice123'), { ok: false, error: 'unknown_device' });
    assert.equal(t.findDevice('../../x'), null);
    assert.equal(t.findDevice('nosuchdevice123'), null);
    assert.equal(t.approve('../../x', 'Nobody').error, 'malformed_device_id');
});

test('a tester can be pre-registered before the phone ever connects', () => {
    const { t } = harness();
    const made = t.approve('devicezzzz9999', 'Woizero');
    assert.equal(made.ok, true);
    assert.equal(made.device.status, STATUS.APPROVED);
    const d = t.decide({ deviceId: 'devicezzzz9999' });
    assert.equal(d.action, 'serve');
    assert.equal(d.testerName, 'Woizero');
    assert.equal(d.reason, 'token_issued');
});

function createTenancyFresh(dir) {
    return createTenancy({ dataDir: dir, enforced: true, now: () => Date.now() });
}
