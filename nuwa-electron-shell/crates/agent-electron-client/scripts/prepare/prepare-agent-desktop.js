const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../../../..');
import(pathToFileURL(path.join(root, 'scripts/client/agent-desktop-resources.mjs')).href)
  .then(({ prepareAgentDesktop }) => prepareAgentDesktop(root))
  .catch(error => { console.error('[agent-desktop]', error.message); process.exitCode = 1; });
