// cli/lib/to-toml.js
function tomlValue(v) {
  if (Array.isArray(v)) return '[' + v.map(x => JSON.stringify(String(x))).join(', ') + ']';
  if (v !== null && typeof v === 'object') {
    // Serialize as a TOML inline table: { key = "val", ... }
    const pairs = Object.entries(v).map(([k, w]) => `${k} = ${tomlValue(w)}`).join(', ');
    return `{ ${pairs} }`;
  }
  return JSON.stringify(String(v));
}

function mcpTable(name, def) {
  const lines = [`[mcp_servers.${name}]`];
  for (const [k, v] of Object.entries(def)) lines.push(`${k} = ${tomlValue(v)}`);
  return lines.join('\n');
}

module.exports = { tomlValue, mcpTable };
