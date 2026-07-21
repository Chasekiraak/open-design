// The workspace a Vela command acts on must travel as an explicit
// `--workspace-id` argument.
//
// It used to travel as a `VELA_WORKSPACE_ID` environment variable that nothing
// on the other side read — the name has zero references in the vela repository
// — so every workspace-scoped call silently fell through to a server-side
// "current workspace" the client cannot set. Once that happened to be a
// personal workspace, B refused the whole collab plane with
// `403 missing_principal`, and the failing command printed as a bare
// `vela collab presence list <id>` with no workspace anywhere in sight.
//
// These specs pin the two properties that fix cost us: the workspace is
// visible IN the command, and its absence fails loudly at the call site.

import { describe, expect, it } from 'vitest';

import {
  velaWorkspaceCommandOptions,
  withWorkspaceIdFlag,
} from '../src/integrations/vela-command.js';

describe('withWorkspaceIdFlag', () => {
  it('appends the workspace as a visible argument', () => {
    expect(withWorkspaceIdFlag(['collab', 'presence', 'list', 'p1'], 'ws-team')).toEqual([
      'collab',
      'presence',
      'list',
      'p1',
      '--workspace-id',
      'ws-team',
    ]);
  });

  it('refuses to build a workspace-scoped command without one', () => {
    for (const missing of [undefined, null, '', '   ']) {
      expect(() => withWorkspaceIdFlag(['collab', 'members'], missing)).toThrow(/workspace id is required/i);
    }
  });

  it('names the command in the error so the failing call site is obvious', () => {
    expect(() => withWorkspaceIdFlag(['team-projects', 'list'], null)).toThrow(/team-projects/);
  });

  it('trims, so a padded id is still an answer', () => {
    expect(withWorkspaceIdFlag(['resource', 'pull'], '  ws-team  ')).toEqual([
      'resource',
      'pull',
      '--workspace-id',
      'ws-team',
    ]);
  });

  it('does not mutate the caller’s argument array', () => {
    const args = ['collab', 'members'];
    withWorkspaceIdFlag(args, 'ws-team');
    expect(args).toEqual(['collab', 'members']);
  });
});

describe('velaWorkspaceCommandOptions', () => {
  // The env var is gone on purpose. Re-adding it would restore a second,
  // invisible channel for the same fact, and the invisible one is the one that
  // silently disagreed with reality for as long as it existed.
  it('carries only the invocation source, never a workspace', () => {
    expect(velaWorkspaceCommandOptions()).toEqual({
      configuredEnv: { VELA_INVOCATION_SOURCE: 'open-design' },
    });
    expect(velaWorkspaceCommandOptions('ws-team')).toEqual({
      configuredEnv: { VELA_INVOCATION_SOURCE: 'open-design' },
    });
  });
});
