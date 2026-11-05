import crypto from 'node:crypto';

export function canonicalJson(data: any): string {
  if (data === null || typeof data !== 'object') {
    return JSON.stringify(data);
  }
  if (data instanceof Date || typeof data?.toJSON === 'function') {
    return JSON.stringify(data);
  }
  if (Array.isArray(data)) {
    return '[' + data.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(data).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(data[k])).join(',') + '}';
}

export function sha256(data: string | object): string {
  const str = typeof data === 'string' ? data : canonicalJson(data);
  return crypto.createHash('sha256').update(str).digest('hex');
}

export function computeEventHash(params: {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  sequence: number;
  eventType: string;
  payload: any;
  previousHash: string | null;
}): string {
  const content = canonicalJson({
    tenantId: params.tenantId,
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    sequence: params.sequence,
    eventType: params.eventType,
    payload: params.payload,
    previousHash: params.previousHash,
  });
  const res = crypto.createHash('sha256').update(content).digest('hex');
  // console.log('CONTENT HASHED:', content, '->', res);
  return res;
}
