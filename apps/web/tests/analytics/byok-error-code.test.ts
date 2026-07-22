import { describe, expect, it } from 'vitest';

import { byokErrorCode } from '../../src/analytics/byok-error-code';

/**
 * `settings_byok_test_result` used to report `result.kind` verbatim, so every
 * response the daemon's status→kind map had no case for collapsed into the
 * union's `unknown` member. In the field that is 801 tests across 201 devices
 * in 24h — 10% of ALL connection tests — where the user is told "connection
 * failed" and we cannot say why.
 *
 * Nothing upstream was missing: `ConnectionTestResponse` already carries
 * `status` for HTTP-shaped failures and a secret-redacted `detail` for
 * transport ones. Only the emission site threw both away.
 */
describe('byokErrorCode', () => {
  it('keeps a kind the daemon actually classified', () => {
    expect(byokErrorCode({ kind: 'auth_failed', status: 401 })).toBe('auth_failed');
  });

  it('recovers the HTTP status the kind map has no case for', () => {
    // 402 = provider out of credits. Previously indistinguishable from a TLS
    // failure or an HTML login portal behind the base URL.
    expect(byokErrorCode({ kind: 'unknown', status: 402 })).toBe('HTTP_402');
    expect(byokErrorCode({ kind: 'unknown', status: 409 })).toBe('HTTP_409');
  });

  it('recovers a Node error code out of the transport detail', () => {
    expect(byokErrorCode({ kind: 'unknown', detail: 'connect ECONNREFUSED 127.0.0.1:11434' })).toBe(
      'ECONNREFUSED',
    );
    expect(byokErrorCode({ kind: 'unknown', detail: 'getaddrinfo ENOTFOUND api.example.com' })).toBe(
      'ENOTFOUND',
    );
    expect(byokErrorCode({ kind: 'unknown', detail: 'UND_ERR_CONNECT_TIMEOUT' })).toBe(
      'UND_ERR_CONNECT_TIMEOUT',
    );
  });

  it('names a self-signed / TLS rejection', () => {
    expect(
      byokErrorCode({ kind: 'unknown', detail: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    ).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    expect(
      byokErrorCode({ kind: 'unknown', detail: 'unable to verify the first certificate' }),
    ).toBe('TLS_FAILED');
  });

  it('names a base URL that answered with something that is not JSON', () => {
    // The classic "base URL points at an HTML login portal" case.
    expect(
      byokErrorCode({ kind: 'unknown', detail: 'Unexpected token < in JSON at position 0' }),
    ).toBe('INVALID_JSON_RESPONSE');
  });

  it('marks a genuinely signal-free failure as its own countable bucket', () => {
    // Distinct from `unknown` on purpose: the residue must be measurable
    // instead of being mixed back in with failures we CAN classify.
    expect(byokErrorCode({ kind: 'unknown' })).toBe('UNKNOWN_NO_SIGNAL');
    expect(byokErrorCode({})).toBe('UNKNOWN_NO_SIGNAL');
  });

  it('treats a missing kind the same as an unclassified one', () => {
    expect(byokErrorCode({ kind: '', status: 429 })).toBe('HTTP_429');
    expect(byokErrorCode({ kind: null, status: 500 })).toBe('HTTP_500');
  });
});
