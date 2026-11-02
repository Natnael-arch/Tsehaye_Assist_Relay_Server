// Probe for the GEMINI_DROP_CLIENT_TURNCOMPLETE kill-switch.
// Extracts the real guard block from index.js and runs candidate frames through it,
// so the test exercises shipped code instead of a copy.
//   node probe_drop.js            -> uses GEMINI_DROP_CLIENT_TURNCOMPLETE from env (default "1")
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/index.js', 'utf8');
const block = src.match(/^ {8}if \(GEMINI_DROP_CLIENT_TURNCOMPLETE[\s\S]*?^ {8}\}$/m);
if (!block) {
    console.error('❌ Could not locate the kill-switch guard block in index.js');
    process.exit(1);
}

const drops = [];
const fn = new Function('env', 'msg', 'console', `
    const GEMINI_DROP_CLIENT_TURNCOMPLETE = env;
    const isJson = true;
    const clientMsg = msg;
${block[0]}
    return 'FORWARD';
`);

function run(msg) {
    const out = fn('1', msg, { log: (line) => drops.push(line) });
    return out === undefined ? 'DROP' : out;
}

const cases = [
    { name: 'bare turnComplete (what the app sends)', drop: true,
      msg: { clientContent: { turnComplete: true } } },
    { name: 'turnComplete + empty turns[]', drop: true,
      msg: { clientContent: { turnComplete: true, turns: [] } } },
    { name: 'turnComplete + empty parts[]', drop: true,
      msg: { clientContent: { turnComplete: true, parts: [] } } },
    { name: 'turnComplete + empty turns[] and parts[]', drop: true,
      msg: { clientContent: { turnComplete: true, turns: [], parts: [] } } },
    { name: 'turnComplete + real turns[] entry', drop: false,
      msg: { clientContent: { turnComplete: true, turns: [{ role: 'user', parts: [{ text: 'hello' }] }] } } },
    { name: 'turnComplete + real parts[] entry', drop: false,
      msg: { clientContent: { turnComplete: true, parts: [{ text: 'hello' }] } } },
    { name: 'turnComplete:false with empty turns[]', drop: false,
      msg: { clientContent: { turnComplete: false, turns: [] } } },
    { name: 'contentless turns[] without turnComplete', drop: false,
      msg: { clientContent: { turns: [] } } },
    { name: 'audio realtimeInput', drop: false,
      msg: { realtimeInput: { audio: { data: 'AAA' } } } },
];

let failed = 0;
for (const c of cases) {
    drops.length = 0;
    const got = run(c.msg);
    const want = c.drop ? 'DROP' : 'FORWARD';
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? '✅' : '❌'} want=${want.padEnd(7)} got=${got.padEnd(7)}  ${c.name}`);
}
console.log(`\nGuard block under test:\n${block[0]}`);
console.log(failed ? `\n${failed} case(s) FAILED` : `\nAll ${cases.length} cases passed`);
process.exit(failed ? 1 : 0);
