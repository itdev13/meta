const fs = require('fs');
const path = require('path');

/**
 * Feature modules live in src/features/<name>/index.js and export
 *   register({ app, services, hooks, guards, workflowAction, express })
 * They mount their own routes, register pipeline hooks and workflow actions. Order matters for
 * hooks: consent runs before rules (so STOP is consumed before keyword auto-replies).
 */
const ORDER = ['consent', 'rules', 'groups', 'analytics', 'proxy', 'share', 'routing'];

function loadFeatures(ctx) {
  const loaded = [];
  for (const name of ORDER) {
    const file = path.join(__dirname, name, 'index.js');
    if (!fs.existsSync(file)) continue;
    // eslint-disable-next-line global-require, import/no-dynamic-require
    require(file).register(ctx);
    loaded.push(name);
  }
  console.log(`[features] loaded: ${loaded.join(', ') || 'none'}`);
  return loaded;
}

module.exports = { loadFeatures };
