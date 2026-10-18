export function readConfig(env = process.env) {
  const provider = env.DECISION_PROVIDER || 'openai';
  if (!['openai', 'mock'].includes(provider)) throw new Error('DECISION_PROVIDER must be openai or mock.');
  if (!env.FOCUS_API_TOKEN?.trim()) throw new Error('FOCUS_API_TOKEN is required, including in mock mode.');
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const parseProbability = (name, fallback) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isFinite(value) || value < 0 || value > 1 || env[name]?.trim() === '') throw new Error(`${name} must be a probability between 0 and 1.`);
    return value;
  };
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? 'http://localhost:3000,http://localhost:5173').split(',').map((item) => item.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths or wildcards.');
  }
  return {
    apiToken: env.FOCUS_API_TOKEN.trim(), openaiApiKey: env.OPENAI_API_KEY?.trim() || '', provider,
    host: env.HOST || '127.0.0.1', port, allowedOrigins, maxImageBytes: 1024 * 1024,
    mockPhoneProbability: parseProbability('MOCK_PHONE_PROBABILITY', 0),
    mockObservableProbability: parseProbability('MOCK_OBSERVABLE_PROBABILITY', 1),
  };
}
