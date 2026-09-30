import type { ResolvedSource } from '../config/schema.js';
import type { IssueProvider } from '../core/types.js';
import { createFixtureProvider } from './fixture.js';
import { createGiteaProvider } from './gitea.js';
import { createGitHubProvider } from './github.js';
import type { FetchLike } from './http.js';

export interface CreateProviderDeps {
  fetch?: FetchLike;
}

/** Build the provider that matches `source.kind`. */
export function createProvider(
  source: ResolvedSource,
  deps: CreateProviderDeps = {},
): IssueProvider {
  const fetchOpt = deps.fetch !== undefined ? { fetch: deps.fetch } : {};
  switch (source.kind) {
    case 'github':
      return createGitHubProvider({
        baseUrl: source.baseUrl,
        webUrl: source.webUrl,
        token: source.token,
        ...fetchOpt,
      });
    case 'gitea':
      return createGiteaProvider({
        baseUrl: source.baseUrl,
        webUrl: source.webUrl,
        token: source.token,
        ...fetchOpt,
      });
    case 'fixture': {
      if (source.path === null || source.path === '') {
        throw new Error(`Source "${source.id}" is a fixture source without a path`);
      }
      return createFixtureProvider({
        path: source.path,
        webUrl: source.webUrl || undefined,
      });
    }
  }
}
