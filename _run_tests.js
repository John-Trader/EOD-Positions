// Runs every _test_*.js in this folder sequentially; exits non-zero on the first failure.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const tests = fs.readdirSync(__dirname).filter(f => /^_test_.*\.js$/.test(f)).sort();
let failed = 0;
for (const t of tests) {
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { encoding: 'utf8', timeout: 30000 });
  const ok = r.status === 0;
  const last = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').filter(Boolean).pop() || '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${t}  ${ok ? '' : '-> ' + last}`);
  if (!ok) failed++;
}
console.log(failed ? `\n${failed} test file(s) FAILED` : `\nAll ${tests.length} test files passed`);
process.exit(failed ? 1 : 0);
