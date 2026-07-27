import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openDesignAmrTraceEnv } from '../../src/runtimes/env.js';

test('openDesignAmrTraceEnv builds Open Design trace identity env for AMR only', () => {
  const amrEnv = openDesignAmrTraceEnv({
    agentId: 'amr',
    runId: ' run_trace_123 ',
    runAttempt: 2,
    conversationId: ' conversation_trace_456 ',
  });

  assert.equal(amrEnv.OPEN_DESIGN_RUN_ID, 'run_trace_123');
  assert.equal(amrEnv.OPEN_DESIGN_RUN_ATTEMPT, '2');
  assert.equal(amrEnv.OPEN_DESIGN_SESSION_ID, 'conversation_trace_456');

  const claudeEnv = openDesignAmrTraceEnv({
    agentId: 'claude',
    runId: 'run_trace_123',
    runAttempt: 2,
    conversationId: 'conversation_trace_456',
  });

  assert.deepEqual(claudeEnv, {});
});

test('openDesignAmrTraceEnv omits optional AMR session trace env when no conversation exists', () => {
  const env = openDesignAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_no_session',
    runAttempt: 0,
  });

  assert.equal(env.OPEN_DESIGN_RUN_ID, 'run_trace_no_session');
  assert.equal(env.OPEN_DESIGN_RUN_ATTEMPT, '0');
  assert.equal(env.OPEN_DESIGN_SESSION_ID, undefined);
});

test('openDesignAmrTraceEnv fails fast on invalid AMR trace inputs', () => {
  assert.throws(
    () => openDesignAmrTraceEnv({ agentId: 'amr', runId: ' ', runAttempt: 0 }),
    /OPEN_DESIGN_RUN_ID/,
  );
  assert.throws(
    () => openDesignAmrTraceEnv({ agentId: 'amr', runId: 'run_trace', runAttempt: -1 }),
    /OPEN_DESIGN_RUN_ATTEMPT/,
  );
});

// Vela's workspace-credit isolation (spec: workspace-scoped wallet and
// credit isolation) attributes an AMR spend by the OPEN_DESIGN_WORKSPACE_ID
// env the daemon forwards to the vela CLI, which the CLI turns into
// `X-Open-Design-Workspace-Id` + `x-vela-workspace-id` request headers.
test('openDesignAmrTraceEnv forwards a team project workspace id for AMR runs', () => {
  const env = openDesignAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_team',
    runAttempt: 0,
    workspaceId: ' workspace_team_123 ',
  });

  assert.equal(env.OPEN_DESIGN_WORKSPACE_ID, 'workspace_team_123');
});

// Personal (non-team) projects resolve no team workspace pin, so the caller
// passes workspaceId: null/undefined. Vela must see NO env var at all in
// that case — not an invented personal-workspace id — so its own
// `sponsor_workspace_id IS NULL` fallback rule attributes the spend to the
// caller's personal wallet exactly as it already does for pre-fix clients.
test('openDesignAmrTraceEnv omits OPEN_DESIGN_WORKSPACE_ID for personal projects', () => {
  const withNull = openDesignAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_personal',
    runAttempt: 0,
    workspaceId: null,
  });
  assert.equal('OPEN_DESIGN_WORKSPACE_ID' in withNull, false);

  const withUndefined = openDesignAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_personal_2',
    runAttempt: 0,
  });
  assert.equal('OPEN_DESIGN_WORKSPACE_ID' in withUndefined, false);

  const withBlank = openDesignAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_personal_3',
    runAttempt: 0,
    workspaceId: '   ',
  });
  assert.equal('OPEN_DESIGN_WORKSPACE_ID' in withBlank, false);
});

test('openDesignAmrTraceEnv never forwards workspaceId for non-AMR agents', () => {
  const env = openDesignAmrTraceEnv({
    agentId: 'claude',
    runId: 'run_trace_123',
    runAttempt: 0,
    workspaceId: 'workspace_team_123',
  });
  assert.deepEqual(env, {});
});
