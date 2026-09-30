import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { ConfigError, loadConfig } from '../config/load.js';
import { PlanService } from '../service/planService.js';
import { buildApp } from './app.js';

export interface StartServerOptions {
  configPath?: string;
  env?: Record<string, string | undefined>;
  webDir?: string;
}

export async function startServer(opts: StartServerOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? process.env;
  const config = loadConfig({
    ...(opts.configPath !== undefined ? { path: opts.configPath } : {}),
    env,
  });
  for (const warning of config.warnings ?? []) console.warn(`warning: ${warning}`);

  const service = new PlanService(config);
  const app = buildApp(config, service, {
    logger: true,
    ...(opts.webDir !== undefined ? { webDir: opts.webDir } : {}),
  });

  const { host, port } = config.server;
  await app.listen({ host, port });

  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  app.log.info(`execution-view listening on http://${shownHost}:${port}`);
  for (const view of service.listViews()) {
    app.log.info(`view "${view.id}" (${view.title}): ${view.repos.join(', ')}`);
  }

  const shutdown = (signal: string): void => {
    app.log.info(`received ${signal}, shutting down`);
    app.close().then(
      () => undefined,
      (err: unknown) => {
        app.log.error({ err }, 'error while closing the server');
        process.exitCode = 1;
      },
    );
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return app;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  startServer().catch((err: unknown) => {
    if (err instanceof ConfigError) console.error(err.message);
    else console.error(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
