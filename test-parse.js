const fs = require('fs');

const lines = [
  ['id', 'task_id', 'task_title', 'task_date', 'employee_cqid', 'tools_used', 'earnings_inr'],
  ['', '', 'Task 1', '2026-05-01', 'CQ001', 'Claude', '3000']
];

function norm(s) {
  return (s || '').toLowerCase().trim().replace(/[^a-z0-9_]/g, '');
}
const h = lines[0].map(norm)
const iRowId = h.findIndex(c => c === 'id')
const iId    = h.findIndex(c => c === 'task_id')
const iTask  = h.findIndex(c => c.includes('task') && c !== 'task_id' && c !== 'id')
const iDate  = h.findIndex(c => c.includes('date'))
const iCqid  = h.findIndex(c => c.includes('cqid') || c === 'employee_cqid')
const iTools = h.findIndex(c => c === 'tools_used')
const iScore = h.findIndex(c => c.includes('score') || c.includes('pct') || c.includes('percent'))
const iEarn  = h.findIndex(c => c.includes('earn'))

console.log({iRowId, iId, iTask, iDate, iCqid, iTools, iScore, iEarn})
