/**
 * Shared CLI helpers used by generate.js, run.js, and edit.js.
 */

export function parseGenerateArgs(args, defaults = {}) {
  const result = { clientId: null, pillarId: null, seed: null, format: null, url: null, ...defaults };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--client' && args[i + 1]) result.clientId = args[++i];
    if (args[i] === '--pillar' && args[i + 1]) result.pillarId = args[++i];
    if (args[i] === '--seed'   && args[i + 1]) result.seed     = args[++i];
    if (args[i] === '--format' && args[i + 1]) result.format   = args[++i];
    if (args[i] === '--url'    && args[i + 1]) result.url      = args[++i];
  }
  return result;
}

export function requireApiKey() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY in .env');
    process.exit(1);
  }
}
