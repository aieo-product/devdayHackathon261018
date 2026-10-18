import { readConfig } from './config.mjs';
import { createApp } from './server.mjs';

try {
  const config = readConfig();
  const server = createApp({ config });
  server.listen(config.port, config.host, () => {
    console.info(`Focus API listening on ${config.host}:${server.address().port}; provider=${config.provider}`);
  });
  server.on('error', () => { console.error('Focus API could not start. Check HOST and PORT.'); process.exitCode = 1; });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 12_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
