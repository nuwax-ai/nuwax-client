// Read-only hashes, except the explicit synthetic seed action in our QA root.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = 'C:/nuwax-qa/integration-20261018', installed = root + '/NuwaxIntegrationQA';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
assert.equal(read(root + '/owner.json').kind, 'Owned integrated Windows QA');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = (name, value) => { fs.writeFileSync(root + '/' + name + '.json', JSON.stringify(value, null, 2)); console.log(JSON.stringify(value).slice(0, 2500)); };
const files = (base, relative = '', result = {}) => {
  if (!fs.existsSync(base)) return result;
  for (const entry of fs.readdirSync(path.join(base, relative), { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), 'Unexpected link in evidence target');
    const rel = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files(base, rel, result);
    else result[rel] = digest(path.join(base, rel));
  }
  return result;
};
const action = process.argv[2], label = process.argv[3];
if (action === 'payload') {
  fs.writeFileSync(root + '/clean-payload-hashes.json', JSON.stringify(files(root + '/payload')));
  const asar = require('C:/nuwax-qa/u1-20261018/toolchain/node_modules/@electron/asar');
  const archive = root + '/payload/resources/app.asar';
  const pkg = JSON.parse(asar.extractFile(archive, 'package.json'));
  const build = ['dist/main/main.js', 'dist/preload/index.js', 'dist/index.html', 'qa-bootstrap.cjs'].map(file => ({ file, sha256: crypto.createHash('sha256').update(asar.extractFile(archive, file.replaceAll('/', path.sep))).digest('hex') }));
  save('package-evidence', { version: pkg.version, build, installers: ['1', '2'].map(n => { const file = root + '/installers/NuwaxIntegrationQA-3.0.17-qa.integration.' + n + '.exe'; return { file, bytes: fs.statSync(file).size, sha256: digest(file) }; }) });
} else if (action === 'verify') {
  const expected = read(root + '/clean-payload-hashes.json'), bad = [];
  for (const [relative, hash] of Object.entries(expected)) {
    const file = path.join(installed, relative);
    if (!fs.existsSync(file) || digest(file) !== hash) bad.push(relative);
  }
  assert.equal(bad.length, 0, 'Installed payload differs: ' + bad.slice(0, 12));
  save('payload-verified-' + label, { passed: true, count: Object.keys(expected).length, mismatches: bad });
} else if (action === 'seed') {
  const fixture = ['qa-workspace/session.txt', 'qa-top.txt', 'resources/qa-resource.txt', 'resources/qa-dir/中文/原位.txt', 'resources/app.asar.unpacked/qa-nested.txt', 'resources/app.asar.unpacked/node_modules/qa-user.txt', 'locales/qa-user.txt', 'resources/app.asar.unpacked/node_modules/qa-workspace/deep/state.txt'];
  const hashes = {};
  for (const relative of fixture) { const file = path.join(installed, relative); assert(!fs.existsSync(file)); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'Synthetic integrated QA: ' + relative); hashes[relative] = digest(file); }
  for (const target of read(root + '/isolation.json').realQaDataTargets) { fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'integration-sentinel.txt'), 'Synthetic QA local data'); }
  fs.writeFileSync(root + '/outside-install-sentinel.txt', 'Synthetic outside install data');
  save('unknown-fixture', hashes);
} else if (action === 'unknown') {
  const expected = read(root + '/unknown-fixture.json');
  for (const [rel, hash] of Object.entries(expected)) assert.equal(digest(path.join(installed, rel)), hash, rel);
  assert.equal(fs.readFileSync(root + '/outside-install-sentinel.txt', 'utf8'), 'Synthetic outside install data');
  save('unknown-verified-' + label, { passed: true, count: Object.keys(expected).length, restoredAtOriginalPaths: true, outsideSentinelPreserved: true });
} else if (action === 'data-snapshot') {
  save('data-snapshot-' + label, read(root + '/isolation.json').realQaDataTargets.map(base => ({ base, files: files(base) })));
} else if (action === 'data-verify') {
  const snapshot = read(root + '/data-snapshot-' + label + '.json');
  let count = 0;
  for (const { base, files: expected } of snapshot) for (const [rel, hash] of Object.entries(expected)) { assert.equal(digest(path.join(base, rel)), hash, path.join(base, rel)); count++; }
  save('data-verified-' + label, { passed: true, count });
} else if (action === 'data-deleted') {
  const targets = read(root + '/isolation.json').realQaDataTargets;
  for (const target of targets) assert(!fs.existsSync(target), target);
  save('data-deletion-verified', { passed: true, targets });
} else throw Error('Unknown evidence action');
