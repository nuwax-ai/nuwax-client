const { readSessionRows } = require('./session-events.cjs');
const sessions = readSessionRows(process.argv[2]);
let passed = false;
let toolCalls = 0;
for (const rows of sessions) {
  const call = rows.findIndex(value => value.includes('tool/call') && value.includes('list_bots'));
  const result = rows.findIndex((value, index) => index > call && value.includes('tool/result'));
  if (call >= 0) toolCalls++;
  if (call >= 0 && result > call && rows.some((value, index) => index > result && value.includes('assistant/message') && value.includes('DSH_PLATFORM_OK'))) passed = true;
}
console.log(JSON.stringify({ passed, sessionFiles: sessions.length, toolCalls }));
