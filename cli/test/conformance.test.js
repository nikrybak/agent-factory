// cli/test/conformance.test.js
// CONF-4: structural conformance validators for every generated output format.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncTargets } = require('../lib/sync');
const { MARKER } = require('../lib/header');

/** Build a minimal fixture and sync all five targets to a temp dir. */
function buildFixture() {
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-from-'));
  const out  = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-out-'));

  fs.writeFileSync(path.join(from, 'AGENTS.md'), '# Contract\nProject rules here.');
  const config = {
    version: '1.0',
    canon: { agents: 'AGENTS.md', skills: 'skills' },
    targets: ['claude', 'gemini', 'codex', 'bundle', 'cursor'],
    mcpServers: {
      sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
      context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    },
  };
  fs.writeFileSync(path.join(from, 'agents.json'), JSON.stringify(config));

  const skills = [
    { name: 'my-skill', description: 'A conformance test skill' },
  ];

  const canon = {
    agentsMd: '# Contract\nProject rules here.',
    config,
  };
  syncTargets(canon, skills, out);
  return { out };
}

// ---------------------------------------------------------------------------
// CLAUDE.md
// ---------------------------------------------------------------------------

test('CONF-4: CLAUDE.md contains DO-NOT-EDIT marker', () => {
  const { out } = buildFixture();
  const content = fs.readFileSync(path.join(out, 'CLAUDE.md'), 'utf8');
  assert.ok(content.includes(MARKER),
    `CLAUDE.md must contain the generated marker. Got:\n${content}`);
});

test('CONF-4: CLAUDE.md contains @AGENTS.md import', () => {
  const { out } = buildFixture();
  const content = fs.readFileSync(path.join(out, 'CLAUDE.md'), 'utf8');
  assert.match(content, /@AGENTS\.md/,
    'CLAUDE.md must reference @AGENTS.md');
});

// ---------------------------------------------------------------------------
// GEMINI.md
// ---------------------------------------------------------------------------

test('CONF-4: GEMINI.md contains @./AGENTS.md import', () => {
  const { out } = buildFixture();
  const content = fs.readFileSync(path.join(out, 'GEMINI.md'), 'utf8');
  assert.match(content, /@\.\/AGENTS\.md/,
    'GEMINI.md must reference @./AGENTS.md');
});

// ---------------------------------------------------------------------------
// .codex/config.toml
// ---------------------------------------------------------------------------

test('CONF-4: config.toml contains persistent_instructions', () => {
  const { out } = buildFixture();
  const content = fs.readFileSync(path.join(out, '.codex', 'config.toml'), 'utf8');
  assert.match(content, /persistent_instructions\s*=/,
    'config.toml must have a persistent_instructions key');
});

test('CONF-4: config.toml contains at least one [mcp_servers.] table', () => {
  const { out } = buildFixture();
  const content = fs.readFileSync(path.join(out, '.codex', 'config.toml'), 'utf8');
  assert.match(content, /\[mcp_servers\./,
    'config.toml must have at least one [mcp_servers.<name>] section');
});

test('CONF-4: every [mcp_servers.] table has at least one key=value line', () => {
  const { out } = buildFixture();
  const content = fs.readFileSync(path.join(out, '.codex', 'config.toml'), 'utf8');
  const lines = content.split('\n');
  let inTable = false;
  let tableHasKv = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^\[mcp_servers\./.test(line)) {
      if (inTable) {
        assert.ok(tableHasKv,
          `mcp_servers table before line ${i} has no key=value entries`);
      }
      inTable = true;
      tableHasKv = false;
    } else if (inTable && /\S+\s*=\s*\S/.test(line)) {
      tableHasKv = true;
    }
  }
  if (inTable) {
    assert.ok(tableHasKv, 'last mcp_servers table has no key=value entries');
  }
});

// ---------------------------------------------------------------------------
// context-bundle.md
// ---------------------------------------------------------------------------

test('CONF-4: context-bundle.md contains ## Skills section', () => {
  const { out } = buildFixture();
  const content = fs.readFileSync(path.join(out, 'context-bundle.md'), 'utf8');
  assert.match(content, /^## Skills/m,
    'context-bundle.md must contain a ## Skills heading');
});
