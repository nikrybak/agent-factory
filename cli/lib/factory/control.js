'use strict';

function buildControlReport(districts, ledgerSummary = {}) {
  if (!districts || typeof districts !== 'object' || Array.isArray(districts)) throw new Error('districts must be an object');
  const blocking = [];
  const entries = Object.entries(districts).sort(([a], [b]) => a.localeCompare(b));
  for (const [district, report] of entries) {
    if (!report || !['PASS', 'COMPLETE'].includes(report.status)) {
      blocking.push({ district, status: report?.status || 'MISSING', gaps: report?.gaps || [] });
    }
  }
  return {
    schemaVersion: '1.0.0',
    status: blocking.length ? 'FAIL' : 'COMPLETE',
    health: { districtsTotal: entries.length, districtsPassing: entries.length - blocking.length, ledger: ledgerSummary },
    districts: Object.fromEntries(entries),
    blocking,
  };
}

module.exports = { buildControlReport };
