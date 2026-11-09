const { readSessionRows } = require('./session-events.cjs');
const sessions = readSessionRows(process.argv[2]);
const checkpoints = sessions.flat().filter(row => row.includes('[Checkpoint ')).length;
const historyLookup = sessions.some(rows => {
  const call = rows.findLastIndex(row => row.includes('tool/call') && row.includes('read_own_chat'));
  return call >= 0 && rows.some((row, index) => index > call && row.includes('tool/result') && row.includes('734291'));
});
console.log(JSON.stringify({ checkpoints, historyLookup }));
