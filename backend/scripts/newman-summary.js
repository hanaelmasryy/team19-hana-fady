// Turns a Newman JSON report into a Markdown table (used by the
// "Deployed security regression" GitHub Actions workflow, issue #12).
// Usage: node scripts/newman-summary.js <report.json> "<title>"
// Prints the table; exits 1 if any assertion failed.

const fs = require('fs');

const [file, title = 'Newman results'] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const run = report.run;
const stats = run.stats;

const rows = [];
for (const exec of run.executions) {
  const name = exec.item.name;
  if (exec.requestError) {
    rows.push(['FAIL', name, `request failed: ${exec.requestError.message}`]);
    continue;
  }
  if (!exec.response) {
    rows.push(['SKIP', name, 'skipped (no test accounts given)']);
    continue;
  }
  const status = `${exec.response.code}`;
  for (const a of exec.assertions || []) {
    rows.push([a.error ? 'FAIL' : 'PASS', `${name} – ${a.assertion}`, a.error ? a.error.message : status]);
  }
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160);
const failed = stats.assertions.failed + stats.requests.failed;
const skipped = rows.filter((r) => r[0] === 'SKIP').length;
const lines = [
  `# ${title}`,
  '',
  `**${stats.assertions.total - stats.assertions.failed} of ${stats.assertions.total} checks passed, ` +
    `${stats.assertions.failed} failed** (${stats.requests.total} requests` +
    `${skipped ? `, ${skipped} skipped` : ''}).`,
  '',
  '| Result | Check | Detail |',
  '|---|---|---|',
  ...rows.map((r) => `| ${r[0]} | ${cell(r[1])} | ${cell(r[2])} |`),
];
console.log(lines.join('\n'));
process.exit(failed > 0 ? 1 : 0);
