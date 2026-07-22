const APPENDED_CAUSE_CODE = /\(([A-Z][A-Z0-9_]{2,})\)\s*$/;
const NODE_ERROR_CODE = /\b(E[A-Z]{3,}|UND_ERR_[A-Z_]+|ERR_[A-Z_]+|(?:[A-Z][A-Z0-9]*_)+[A-Z0-9]{2,})\b/;

export interface ByokErrorCodeInput {
  kind?: string | null;
  status?: number | null;
  detail?: string | null;
}

function isClassified(kind: string): boolean {
  return kind.length > 0 && kind.toLowerCase() !== 'unknown';
}

export function byokErrorCode(result: ByokErrorCodeInput): string {
  const kind = typeof result.kind === 'string' ? result.kind : '';
  if (isClassified(kind)) return kind;

  if (typeof result.status === 'number' && result.status >= 300) {
    return `HTTP_${result.status}`;
  }

  const detail = typeof result.detail === 'string' ? result.detail : '';
  const appended = APPENDED_CAUSE_CODE.exec(detail)?.[1];
  if (appended) return appended;
  const nodeCode = NODE_ERROR_CODE.exec(detail)?.[1];
  if (nodeCode) return nodeCode;
  if (/\bcertificate\b|\bTLS\b|\bSSL\b|CERT/i.test(detail)) return 'TLS_FAILED';
  if (/\bJSON\b|\bunexpected token\b/i.test(detail)) return 'INVALID_JSON_RESPONSE';
  return 'UNKNOWN_NO_SIGNAL';
}
