#!/usr/bin/env node
'use strict';

// PreToolUse guard for the agent's file tools (owner rule 2026-10-22, ADR-0025): a Write, Edit or NotebookEdit whose
// target is on the system drive is denied, except the agent's own configuration and memory (~/.claude), which the
// application keeps there. The reason names where scratch goes instead. Any parse problem lets the call through: a
// guard must never block work by accident.

const path = require('node:path');

/** The system drive letter ("c") and the agent's own folder that stays allowed there. */
function context(env = process.env) {
  const drive = (env.SystemDrive || 'C:').slice(0, 1).toLowerCase();
  const home = env.USERPROFILE || env.HOME || '';
  return { drive, allowed: home ? path.win32.join(home, '.claude').toLowerCase() : null };
}

/** A drive letter with either slash, or the Git Bash form /<letter>/..., names a drive; returns a normalised Windows path or null. */
function windowsPath(target) {
  if (typeof target !== 'string' || !target) return null;
  const bash = /^\/([a-zA-Z])\/(.*)$/.exec(target);
  const raw = bash ? `${bash[1]}:/${bash[2]}` : target;
  return /^[a-zA-Z]:/.test(raw) ? path.win32.normalize(raw).toLowerCase() : null;
}

/** The deny reason for [input], or null when the call may go ahead. */
function verdict(input, env = process.env) {
  if (!input || !['Write', 'Edit', 'NotebookEdit', 'MultiEdit'].includes(input.tool_name)) return null;
  const target = windowsPath(input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path));
  const { drive, allowed } = context(env);
  if (!target || target[0] !== drive) return null;
  if (allowed && (target === allowed || target.startsWith(`${allowed}\\`))) return null;
  return `Writing to the system drive is forbidden (owner rule, ADR-0025): ${target}. Put short-lived files under `
    + `${env.DEV_TEMP || 'the Dev Drive scratch root (DEV_TEMP)'} (node scripts/junk.js new <label>) and mark them with `
    + '`junk.js done <path>` when no longer needed; long-lived files belong in the project or the runtimes folder.';
}

function main(stdin = process.stdin, stdout = process.stdout, env = process.env) {
  const chunks = [];
  stdin.on('data', chunk => chunks.push(chunk));
  stdin.on('end', () => {
    let reason = null;
    try {
      reason = verdict(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), env);
    } catch {
      reason = null;
    }
    if (reason) {
      stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    }
  });
}

if (require.main === module) main();

module.exports = { verdict, windowsPath, context, main };
