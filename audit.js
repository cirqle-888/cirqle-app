const fs = require('fs');
const path = require('path');

const TARGET_TABLES = ['tasks', 'contribution_scores', 'invoices', 'cashbook_entries', 'payroll', 'contributions'];

function walk(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const stat = fs.statSync(path.join(dir, file));
    if (stat.isDirectory()) {
      walk(path.join(dir, file), fileList);
    } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      fileList.push(path.join(dir, file));
    }
  }
  return fileList;
}

const files = walk('./src');

files.forEach(file => {
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  
  lines.forEach((line, idx) => {
    if (line.includes('.from(')) {
      TARGET_TABLES.forEach(table => {
        if (line.includes(`.from('${table}')`)) {
          // extract surrounding lines to analyze context
          const start = Math.max(0, idx - 3);
          const end = Math.min(lines.length - 1, idx + 5);
          const snippet = lines.slice(start, end + 1).join('\n');
          
          let hasLimit = snippet.includes('.limit(') || snippet.includes('.single(') || snippet.includes('.maybeSingle(') || snippet.includes('.delete()') || snippet.includes('.insert(') || snippet.includes('.update(') || snippet.includes('.upsert(');
          let hasFetchAll = snippet.includes('fetchAll(') || snippet.includes('fetchAllTasks(');
          let hasEq = snippet.includes('.eq(') || snippet.includes('.in(') || snippet.includes('.match(');
          let hasOrder = snippet.includes('.order(');
          let hasStableOrder = snippet.includes(".order('id'") || snippet.includes('.order("id"');
          
          // Heuristic: If it's a select query on a large table without limit and without fetchAll, it's vulnerable to 1000 row cap!
          // If it has pagination (fetchAll) but lacks stable order, it's vulnerable to pagination drift!
          
          if (!hasLimit && !hasFetchAll) {
            console.log(`\n[WARNING: Missing limit/fetchAll] ${file}:${idx + 1}`);
            console.log(`Table: ${table}`);
            if (hasEq) console.log(`Note: Has .eq filter, might be fine if subset is small.`);
            console.log(`Snippet:\n${snippet}`);
          }
          
          if (hasFetchAll && !hasStableOrder) {
            console.log(`\n[WARNING: fetchAll missing stable .order('id')] ${file}:${idx + 1}`);
            console.log(`Table: ${table}`);
            console.log(`Snippet:\n${snippet}`);
          }
        }
      });
    }
  });
});
