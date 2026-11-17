// Internal view from the command line: read the full investigation report for a case.
//   npm run report                 list recent cases
//   npm run report -- CASE-...     print the full report (evidence, checks, audit trail)
//   npm run report -- CASE-... --json
//   npm run report -- --incidents   suspected incidents
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';

const [id, flag] = process.argv.slice(2);
const store = openStore(loadConfig().dbPath);

if (id === '--incidents') {
  const list = store.incidents(50);
  if (!list.length) console.log('No suspected incidents.');
  for (const i of list) {
    const s = i.last_signals ?? {};
    console.log(`${i.id}  ${i.status.padEnd(10)} ${i.likely_bug ? 'LIKELY FASTPAY BUG ' : ''}${i.title}`);
    console.log(`    cases linked: ${i.case_count} · stuck ${s.stuck}/${s.total} · other customers affected: ${s.others_affected} · first ${i.first_seen} · last ${i.last_seen}`);
  }
  process.exit(0);
}

if (!id) {
  const cases = store.recentCases(20);
  if (!cases.length) console.log('No cases yet.');
  for (const c of cases) {
    const r = store.latestReport(c.id);
    console.log(`${c.id}  ${c.status.padEnd(21)} ${(c.complaint_type ?? '').padEnd(28)} ${r ? `${r.finding.code} (${r.transaction.reference})` : ''}`);
  }
  process.exit(0);
}

const report = store.latestReport(id);
if (!report) {
  console.error(`No report for ${id}.`);
  process.exit(1);
}
if (flag === '--json') {
  console.log(JSON.stringify({ report, audit: store.auditFor(id) }, null, 2));
  process.exit(0);
}

const line = (s = '') => console.log(s);
line(`Report ${report.report_id} · case ${report.case_id} · ${report.generated_at}`);
line(`Customer: ${report.customer.name} (${report.customer.account_id})`);
line(`Complaint: ${report.complaint.type_label} · "${report.complaint.statements.join(' / ')}"`);
line(`Transaction: ${report.transaction.reference} · ${report.transaction.kind_label} · ${report.transaction.amount_display}`);
line();
line(`FINDING: ${report.finding.code}: ${report.finding.title}`);
line(`  ${report.finding.explanation}`);
line(`Claim: ${report.claim_assessment.result} · Confidence: ${report.confidence} · At issue: ${report.amount_at_issue.display}`);
if (report.broke_at) {
  line(`WHERE IT BROKE: ${report.broke_at.party_label}${report.broke_at.likely_bug ? ' (LIKELY FASTPAY BUG)' : ''}: ${report.broke_at.summary}`);
  line(`  ${report.broke_at.explanation}`);
}
if (report.incident && report.incident.status !== 'NOT_CHECKED') {
  line(`INCIDENT CHECK: ${report.incident.status}${report.incident.incident_id ? ` (${report.incident.incident_id}, ${report.incident.linked_cases} case(s) linked)` : ''}`);
  for (const r of report.incident.reasons) line(`  ${r}`);
}
if (report.resolution_guidance) line(`Guidance for resolution: ${report.resolution_guidance}`);
if (report.destination) line(`Delivery confirmed by: ${report.destination.confirmed_by}`);
for (const l of report.limits ?? []) line(`Limit: ${l}`);
line();
line('CHECKS');
for (const c of report.checks) line(`  [${c.answer}] ${c.question}\n        ${c.detail}  (${c.evidence.join(', ')})`);
if (report.discrepancies.length) {
  line('DISCREPANCIES');
  for (const d of report.discrepancies) line(`  ${d.code}: ${d.detail}`);
}
line('EVIDENCE');
for (const e of report.evidence) line(`  ${e.id} ${e.source} · ${e.label} · ${e.retrieved_at}${e.paypal_debug_id ? ` · PayPal debug ${e.paypal_debug_id}` : ''}`);
if (report.customer_view) {
  line();
  line('CUSTOMER SAW');
  line(`  ${report.customer_view.headline}: ${report.customer_view.status}`);
  for (const s of report.customer_view.next_steps) line(`   - ${s}`);
}
