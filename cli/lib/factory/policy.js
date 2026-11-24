'use strict';
const { loadCatalog } = require('./catalog-loader');

const RISK = ['low', 'medium', 'high', 'critical'];
const DATA_RISK = { public: 'low', internal: 'medium', confidential: 'high', restricted: 'critical' };
const RISK_GATES = {
  low: [],
  medium: ['architecture'],
  high: ['architecture'],
  critical: ['architecture'],
};
function maxRisk(...levels) { return RISK[Math.max(...levels.filter(Boolean).map(level => RISK.indexOf(level)), 0)]; }
function unique(values) { return [...new Set(values)].sort(); }

function loadCatalogs(rootDir) {
  const profiles = loadCatalog(rootDir, 'factory/catalog/profiles.json');
  const stackSignals = loadCatalog(rootDir, 'factory/catalog/stack-signals.json');
  return { profiles, stackSignals };
}

function composeProfiles(names, catalog) {
  const definitions = catalog.profiles || {};
  const unknown = [];
  const selected = [];
  for (const name of names || []) {
    if (!definitions[name]) unknown.push(name); else selected.push(definitions[name]);
  }
  return {
    minimumRisk: maxRisk(...selected.map(item => item.minimumRisk)),
    capabilities: unique(selected.flatMap(item => item.capabilities || [])),
    requiredGates: unique(selected.flatMap(item => item.requiredGates || [])),
    unknown: unique(unknown),
  };
}

function evaluatePolicy({ manifest, detection, catalogs }) {
  const profiles = composeProfiles(manifest.profiles || [], catalogs.profiles);
  const derived = maxRisk(
    DATA_RISK[manifest.risk?.dataSensitivity],
    manifest.risk?.internetExposure ? 'medium' : 'low',
    manifest.risk?.regulated ? 'high' : 'low'
  );
  const effectiveRisk = maxRisk(manifest.risk?.class, profiles.minimumRisk, derived);
  const requiredGates = unique([
    'security',
    ...(RISK_GATES[effectiveRisk] || []),
    ...(profiles.requiredGates || []),
    ...(manifest.quality?.requiredGates || []),
  ]);
  const available = new Set();
  for (const component of detection.components || []) {
    available.add(component.family);
    for (const framework of component.frameworks || []) available.add(framework);
    for (const capability of component.capabilities || []) available.add(capability);
  }
  for (const capability of detection.capabilities || []) available.add(capability);
  const gaps = [...(detection.gaps || [])];
  for (const name of profiles.unknown) gaps.push({ code: 'unknown-profile', subject: name, message: `Unknown profile: ${name}` });
  for (const capability of manifest.capabilities?.required || []) {
    if (!available.has(capability)) gaps.push({ code: 'missing-capability', subject: capability, message: `Required capability is unavailable: ${capability}` });
  }
  gaps.sort((a, b) => `${a.code}:${a.subject || ''}`.localeCompare(`${b.code}:${b.subject || ''}`));
  return { status: gaps.length ? 'blocked' : 'ready', effectiveRisk, requiredGates, capabilities: unique([...profiles.capabilities, ...(manifest.capabilities?.required || [])]), gaps };
}

module.exports = { loadCatalogs, composeProfiles, evaluatePolicy, maxRisk };
