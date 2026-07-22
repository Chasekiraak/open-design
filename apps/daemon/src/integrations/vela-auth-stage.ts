import type {
  AmrAuthErrorKind,
  AmrAuthStage,
  AmrAuthStageResult,
} from '@open-design/contracts/analytics';

type VelaWireAuthStage = Exclude<AmrAuthStage, 'spawn_result'>;

export interface VelaAuthStageSignal {
  authAttemptId: string;
  stage: VelaWireAuthStage;
  result: AmrAuthStageResult;
  errorKind?: AmrAuthErrorKind;
}

export interface VelaAuthStageStreamState {
  buffer: string;
  discardingOversizeLine: boolean;
}

export const VELA_AUTH_STAGE_PREFIX = 'OPEN_DESIGN_AMR_AUTH_STAGE\t';
export const VELA_AUTH_STAGE_LINE_MAX_BYTES = 4 * 1024;

const VELA_AUTH_STAGE_RESULTS: Readonly<
  Record<VelaWireAuthStage, readonly AmrAuthStageResult[]>
> = {
  attempt_started: ['started'],
  device_auth_create_result: ['success', 'failed'],
  activation_ready: ['success'],
  browser_open_result: ['success', 'failed'],
  device_authorization_result: ['success', 'failed'],
  token_exchange_result: ['success', 'failed'],
  credential_persist_result: ['success', 'failed'],
};

const VELA_AUTH_ERROR_KINDS: ReadonlySet<AmrAuthErrorKind> = new Set([
  'network_error',
  'browser_open_error',
  'oauth_timeout',
  'oauth_denied',
  'invalid_state',
  'credential_persist_error',
  'internal_error',
  'unknown',
]);

export function isCanonicalAmrAuthAttemptId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function createVelaAuthStageStreamState(): VelaAuthStageStreamState {
  return { buffer: '', discardingOversizeLine: false };
}

function parseVelaAuthStageLine(
  line: string,
  expectedAttemptId: string,
): VelaAuthStageSignal | null {
  if (
    !isCanonicalAmrAuthAttemptId(expectedAttemptId)
    || !line.startsWith(VELA_AUTH_STAGE_PREFIX)
  ) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(VELA_AUTH_STAGE_PREFIX.length));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.schema_version !== 1 || value.auth_attempt_id !== expectedAttemptId) {
    return null;
  }
  if (typeof value.stage !== 'string' || typeof value.result !== 'string') {
    return null;
  }
  const stage = value.stage as VelaWireAuthStage;
  const result = value.result as AmrAuthStageResult;
  const allowedResults = VELA_AUTH_STAGE_RESULTS[stage];
  if (!allowedResults?.includes(result)) return null;
  const suppliedErrorKind = value.error_kind;
  const errorKind = result === 'failed'
    ? (typeof suppliedErrorKind === 'string'
        && VELA_AUTH_ERROR_KINDS.has(suppliedErrorKind as AmrAuthErrorKind)
      ? suppliedErrorKind as AmrAuthErrorKind
      : 'unknown')
    : null;
  // Project only allowlisted fields. Unknown keys — including accidental URL,
  // code, token, email, or raw-error fields — never enter daemon state.
  return {
    authAttemptId: expectedAttemptId,
    stage,
    result,
    ...(errorKind ? { errorKind } : {}),
  };
}

export function pushVelaAuthStageChunk(
  state: VelaAuthStageStreamState,
  chunk: string,
  expectedAttemptId: string,
): VelaAuthStageSignal[] {
  const signals: VelaAuthStageSignal[] = [];
  let input = chunk;
  if (state.discardingOversizeLine) {
    const newline = input.indexOf('\n');
    if (newline < 0) return signals;
    input = input.slice(newline + 1);
    state.discardingOversizeLine = false;
  }
  input = state.buffer + input;
  state.buffer = '';
  let offset = 0;
  for (;;) {
    const newline = input.indexOf('\n', offset);
    if (newline < 0) break;
    const rawLine = input.slice(offset, newline);
    offset = newline + 1;
    if (Buffer.byteLength(rawLine, 'utf8') > VELA_AUTH_STAGE_LINE_MAX_BYTES) {
      continue;
    }
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const signal = parseVelaAuthStageLine(line, expectedAttemptId);
    if (signal) signals.push(signal);
  }
  const remainder = input.slice(offset);
  if (Buffer.byteLength(remainder, 'utf8') > VELA_AUTH_STAGE_LINE_MAX_BYTES) {
    state.discardingOversizeLine = true;
  } else {
    state.buffer = remainder;
  }
  return signals;
}
