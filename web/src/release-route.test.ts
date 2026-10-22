import { describe, expect, it } from 'vitest';
import { parseReleaseHash, releaseHash } from './release-route.js';
import { parseHash, serializeHash } from './route.js';

describe('independent release links', () => {
  it('round trips repository, job and plan identities without changing planning links', () => {
    const route = { repositoryId: 'repo / β', jobId: 'job?1&2', planId: 'plan#3' };
    expect(parseReleaseHash(releaseHash(route))).toEqual(route);
    expect(parseReleaseHash('#/releases')).toEqual({
      repositoryId: null,
      jobId: null,
      planId: null,
    });
    const planning = '#/view/team/order?q=bug&sort=updated';
    expect(parseReleaseHash(planning)).toBeNull();
    expect(serializeHash(parseHash(planning))).toBe(planning);
    expect(parseReleaseHash('#/releases-other')).toBeNull();
  });

  it('handles malformed repository encoding without crashing navigation', () => {
    expect(parseReleaseHash('#/releases/%zz')?.repositoryId).toBeNull();
  });
});
