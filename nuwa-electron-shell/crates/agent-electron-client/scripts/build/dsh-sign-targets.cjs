const fs = require('node:fs');
const path = require('node:path');
const MACHO = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf']);
/** Native libraries do not necessarily have executable mode bits. */
function nativeTargets(root, format = 'macho') {
  if (!fs.existsSync(root)) return [];
  const found = new Set(), seen = new Set();
  const base = fs.realpathSync(root);
  function visit(file) {
    const real = fs.realpathSync(file);
    const relative = path.relative(base, real);
    if (relative.startsWith('..') || path.isAbsolute(relative) || seen.has(real)) return;
    seen.add(real);
    const stat = fs.statSync(real);
    if (stat.isDirectory()) { for (const name of fs.readdirSync(real)) visit(path.join(real, name)); return; }
    if (!stat.isFile() || stat.size < 4) return;
    const fd = fs.openSync(real, 'r');
    try {
      const header = Buffer.alloc(4); fs.readSync(fd, header, 0, 4, 0);
      if (format === 'pe' ? header.subarray(0, 2).toString() === 'MZ' : MACHO.has(header.toString('hex'))) found.add(real);
    } finally { fs.closeSync(fd); }
  }
  visit(base);
  return [...found].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
}
module.exports = { nativeTargets };
