import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { ConfigError, loadConfig } from '../config/load.js';
import { loadReleaseRuntime } from '../config/releaseRuntime.js';
import { PlanService } from '../service/planService.js';
import { acquireReleaseOwnership } from '../service/releaseOwnership.js';
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
  // Fail closed on unsafe local release prerequisites before serving; no forge call happens here,
  // so a temporary forge outage cannot keep Planning down.
  const releaseRuntime = loadReleaseRuntime(config.releases, config.sources, env);

  const service = new PlanService(config);
  const app = buildApp(config, service, {
    logger: true,
    ...(opts.webDir !== undefined ? { webDir: opts.webDir } : {}),
  });
  if (releaseRuntime !== null) {
    app.log.info(
      `releases enabled: ${releaseRuntime.repositories.length} repository(ies), state dir ${releaseRuntime.stateDir}`,
    );
    // One process owns release state for its lifetime; a second one is refused here, before it
    // can serve release work or touch the records. Closing the server, by any path, releases it.
    const ownership = await acquireReleaseOwnership({
      stateDir: releaseRuntime.stateDir,
      onLost: (reason) => app.log.error(`release execution unavailable: ${reason}`),
    });
    app.log.info(`release state owned: ${ownership.lockFile}`);
    app.addHook('onClose', async () => {
      const report = await ownership.shutdown();
      if (!report.drained) {
        app.log.warn(
          `shutdown deadline passed with release work still running (${report.pending.join(', ')}); this process keeps release-state ownership until it exits, and the durable intent is what the next start reconciles`,
        );
      } else if (!report.lockReleased) {
        app.log.error(`could not release the release-state ownership lock ${ownership.lockFile}`);
      }
    });
  }

  const { host, port } = config.server;
  try {
    await app.listen({ host, port });
  } catch (error) {
    // Do not leak the ownership lock or the helper process when listening fails.
    await app.close().catch(() => undefined);
    throw error;
  }

  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  app.log.info(`execution-view listening on http://${shownHost}:${port}`);
  for (const view of service.listViews()) {
    app.log.info(`view "${view.id}" (${view.title}): ${view.repos.join(', ')}`);
  }

  // Closing the server stops release admission and drains release work within the bound, so
  // SIGTERM never cuts an accepted publication short mid-write.
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
