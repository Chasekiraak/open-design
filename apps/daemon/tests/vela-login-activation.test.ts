import { describe, expect, it } from 'vitest';
import {
  createVelaAuthStageStreamState,
  parseVelaAuthAttemptId,
  parseVelaLoginActivation,
  pushVelaAuthStageChunk,
} from '../src/integrations/vela.js';

// `vela login` is a device-authorization flow: it prints the activation URL and
// user code to stdout BEFORE it best-effort opens the browser, and warns on
// stderr when the auto-open failed (see apps/cli/internal/commands/login.go in
// the vela repo). The daemon spawns vela login headless (piped stdio) and the
// UI only ever showed a spinner, so when the browser failed to open the user
// had no URL to fall back to and stared at a 5-minute dead spinner. This parser
// recovers the URL/code/warning so the host can surface them. The expected
// stdout matches vela's exact `Fprintf` format strings.
describe('parseVelaLoginActivation', () => {
  const stdout =
    'Open this URL to continue:\n' +
    'https://app.openalternative.ai/device?user_code=AB12-CD34\n' +
    '\n' +
    'Code: AB12-CD34\n';

  it('extracts the activation URL and user code from vela login stdout', () => {
    const activation = parseVelaLoginActivation(stdout, '');
    expect(activation.activationUrl).toBe(
      'https://app.openalternative.ai/device?user_code=AB12-CD34',
    );
    expect(activation.userCode).toBe('AB12-CD34');
    expect(activation.browserOpenFailed).toBe(false);
  });

  it('flags browserOpenFailed when vela warns it could not open the browser', () => {
    const stderr =
      'Warning: could not open browser automatically: exec: "open": executable file not found in $PATH\n';
    const activation = parseVelaLoginActivation(stdout, stderr);
    expect(activation.activationUrl).toBe(
      'https://app.openalternative.ai/device?user_code=AB12-CD34',
    );
    expect(activation.browserOpenFailed).toBe(true);
  });

  it('does not mistake the user_code query param inside the URL for the Code line', () => {
    const activation = parseVelaLoginActivation(stdout, '');
    // The URL itself contains `user_code=AB12-CD34`; the parser must read the
    // code from the dedicated `Code:` line, not from the URL.
    expect(activation.userCode).toBe('AB12-CD34');
    expect(activation.activationUrl).not.toContain(' ');
  });

  it('returns nulls before vela has printed anything (slow CreateDeviceAuthorization)', () => {
    const activation = parseVelaLoginActivation('', '');
    expect(activation.activationUrl).toBeNull();
    expect(activation.userCode).toBeNull();
    expect(activation.browserOpenFailed).toBe(false);
  });
});

describe('pushVelaAuthStageChunk', () => {
  it('decodes split, multi-line, and CRLF protocol frames incrementally', () => {
    const attemptId = '936da01f-9abd-4d9d-80c7-02af85c822a8';
    const state = createVelaAuthStageStreamState();
    const first = pushVelaAuthStageChunk(
      state,
      'Open this URL to continue:\r\nOPEN_DESIGN_AMR_AUTH_STA',
      attemptId,
    );
    const second = pushVelaAuthStageChunk(
      state,
      `GE\t${JSON.stringify({
        schema_version: 1,
        auth_attempt_id: attemptId,
        stage: 'attempt_started',
        result: 'started',
      })}\r\nignored human text\nOPEN_DESIGN_AMR_AUTH_STAGE\t${JSON.stringify({
        schema_version: 1,
        auth_attempt_id: attemptId,
        stage: 'browser_open_result',
        result: 'failed',
        error_kind: 'browser_open_error',
        activation_url: 'must-not-project',
      })}\n`,
      attemptId,
    );

    expect(first).toEqual([]);
    expect(second).toEqual([
      {
        authAttemptId: attemptId,
        stage: 'attempt_started',
        result: 'started',
      },
      {
        authAttemptId: attemptId,
        stage: 'browser_open_result',
        result: 'failed',
        errorKind: 'browser_open_error',
      },
    ]);
  });

  it('rejects invalid protocol fields and recovers after an oversized line', () => {
    const attemptId = '936da01f-9abd-4d9d-80c7-02af85c822a8';
    const otherAttemptId = '936da01f-9abd-4d9d-90c7-02af85c822a8';
    const state = createVelaAuthStageStreamState();
    const frame = (value: Record<string, unknown>) =>
      `OPEN_DESIGN_AMR_AUTH_STAGE\t${JSON.stringify(value)}\n`;
    const base = {
      schema_version: 1,
      auth_attempt_id: attemptId,
      stage: 'device_auth_create_result',
      result: 'failed',
    };

    const signals = pushVelaAuthStageChunk(
      state,
      [
        frame({ ...base, schema_version: 2 }),
        frame({ ...base, auth_attempt_id: otherAttemptId }),
        frame({ ...base, stage: 'raw_token_dump' }),
        frame({ ...base, result: 'cancelled' }),
        frame({ ...base, stage: 'attempt_started', result: 'success' }),
        `OPEN_DESIGN_AMR_AUTH_STAGE ${JSON.stringify(base)}\n`,
        `${'x'.repeat(4_097)}\n`,
        frame({ ...base, error_kind: 'unbounded-upstream-message' }),
      ].join(''),
      attemptId,
    );

    expect(signals).toEqual([{
      authAttemptId: attemptId,
      stage: 'device_auth_create_result',
      result: 'failed',
      errorKind: 'unknown',
    }]);
    expect(pushVelaAuthStageChunk(
      createVelaAuthStageStreamState(),
      frame(base),
      'not-a-uuid',
    )).toEqual([]);
  });

  it('normalizes every failed frame without an allowlisted error kind to unknown', () => {
    const attemptId = '936da01f-9abd-4d9d-80c7-02af85c822a8';
    const frame = (value: Record<string, unknown>) =>
      `OPEN_DESIGN_AMR_AUTH_STAGE\t${JSON.stringify(value)}\n`;
    const base = {
      schema_version: 1,
      auth_attempt_id: attemptId,
      stage: 'device_auth_create_result',
    };

    const missing = pushVelaAuthStageChunk(
      createVelaAuthStageStreamState(),
      frame({ ...base, result: 'failed' }),
      attemptId,
    );
    const invalid = pushVelaAuthStageChunk(
      createVelaAuthStageStreamState(),
      frame({ ...base, result: 'failed', error_kind: 'raw upstream secret' }),
      attemptId,
    );
    const ignoredOnSuccess = pushVelaAuthStageChunk(
      createVelaAuthStageStreamState(),
      frame({ ...base, result: 'success', error_kind: 'network_error' }),
      attemptId,
    );

    expect(missing[0]?.errorKind).toBe('unknown');
    expect(invalid[0]?.errorKind).toBe('unknown');
    expect(ignoredOnSuccess[0]).not.toHaveProperty('errorKind');
  });
});

describe('parseVelaAuthAttemptId', () => {
  it('accepts only lowercase canonical UUIDv4 values', () => {
    expect(parseVelaAuthAttemptId({
      authAttemptId: '936da01f-9abd-4d9d-80c7-02af85c822a8',
    })).toBe('936da01f-9abd-4d9d-80c7-02af85c822a8');
    expect(parseVelaAuthAttemptId({
      authAttemptId: '936DA01F-9ABD-4D9D-80C7-02AF85C822A8',
    })).toBeNull();
  });
});
