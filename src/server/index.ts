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
  // The single-owner gate is claimed before the app can serve release work, so release routes
  // exist only on a runtime that owns its state directory. A second process is refused here.
  let app: FastifyInstance | null = null;
  const ownership =
    releaseRuntime === null
      ? null
      : await acquireReleaseOwnership({
          stateDir: releaseRuntime.stateDir,
          onLost: (reason) => {
            const message = `release execution unavailable: ${reason}`;
            if (app === null) console.error(message);
            else app.log.error(message);
          },
        });
  try {
    app = buildApp(config, service, {
      logger: true,
      ...(opts.webDir !== undefined ? { webDir: opts.webDir } : {}),
      ...(releaseRuntime !== null && ownership !== null
        ? { releases: { runtime: releaseRuntime, gate: ownership } }
        : {}),
    });
  } catch (error) {
    await ownership?.shutdown();
    throw error;
  }
  const server: FastifyInstance = app;
  if (releaseRuntime !== null && ownership !== null) {
    // Repository ids are useful; the success path does not log the private state directory or lock paths.
    server.log.info(
      `releases enabled: ${releaseRuntime.repositories.length} repository(ies): ${releaseRuntime.repositories.map((r) => r.config.id).join(', ')}`,
    );
    server.log.info('release state ownership acquired');
    // Closing the server, by any path, releases ownership after a bounded drain.
    server.addHook('onClose', async () => {
      const report = await ownership.shutdown();
      if (!report.drained) {
        server.log.warn(
          `shutdown deadline passed with release work still running (${report.pending.join(', ')}); this process keeps release-state ownership until it exits, and the durable intent is what the next start reconciles`,
        );
      } else if (!report.lockReleased) {
        server.log.error('could not release the release-state ownership lock');
      }
    });
  }

  const { host, port } = config.server;
  try {
    await server.listen({ host, port });
  } catch (error) {
    // Do not leak the ownership lock or the helper process when listening fails.
    await server.close().catch(() => undefined);
    throw error;
  }

  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  server.log.info(`execution-view listening on http://${shownHost}:${port}`);
  for (const view of service.listViews()) {
    server.log.info(`view "${view.id}" (${view.title}): ${view.repos.join(', ')}`);
  }

  // Closing the server stops release admission and drains release work within the bound, so
  // SIGTERM never cuts an accepted publication short mid-write.
  const shutdown = (signal: string): void => {
    server.log.info(`received ${signal}, shutting down`);
    server.close().then(
      () => undefined,
      (err: unknown) => {
        server.log.error({ err }, 'error while closing the server');
        process.exitCode = 1;
      },
    );
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return server;
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
