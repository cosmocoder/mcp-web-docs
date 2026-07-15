#!/usr/bin/env node

process.env.CRAWLEE_LOG_LEVEL = 'OFF';
process.env.APIFY_LOG_LEVEL = 'OFF';

const { log, Configuration } = await import('crawlee');
log.setLevel(log.LEVELS.OFF);
Configuration.getGlobalConfig().set('logLevel', 'OFF');

const [{ WebDocsServer }, { logger }] = await Promise.all([import('./server.js'), import('./util/logger.js')]);

const server = new WebDocsServer();
server.run().catch((error) => logger.error('Server failed to start:', error));

let shutdownPromise: Promise<void> | undefined;

function handleShutdown(signal: NodeJS.Signals): Promise<void> {
  return (shutdownPromise ??= (async () => {
    logger.info(`Received ${signal}, cancelling operations and shutting down...`);

    let exited = false;
    const exit = (code: number): void => {
      if (!exited) {
        exited = true;
        clearTimeout(timeout);
        process.exit(code);
      }
    };
    const timeout = setTimeout(() => {
      logger.error('Shutdown timed out after 5 seconds');
      exit(1);
    }, 5_000);

    try {
      await server.close();
      exit(0);
    }
    catch (error) {
      logger.error('Failed to shut down cleanly:', error);
      exit(1);
    }
  })());
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void handleShutdown(signal));
}
