import type { CellValue } from '../types';

/**
 * 드라이버가 돌려준 값을 웹뷰로 보낼 수 있는 형태로 정규화한다.
 *
 * 웹뷰 메시지는 structured clone 을 거치므로 Date/Buffer/BigInt 를 그대로
 * 보낼 수 없거나 보내도 표시가 깨진다. 여기서 한 번에 문자열화한다.
 * 원본 타입 정보는 컬럼 메타데이터에 따로 남는다.
 */

/** 셀 하나에 담을 최대 길이 — 거대한 CLOB/BLOB 이 UI 를 멈추지 않게 자른다. */
const MAX_CELL_CHARS = 64 * 1024;

export function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) {
    return null;
  }

  switch (typeof value) {
    case 'string':
      return truncate(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      // JSON 으로 안전하게 넘길 수 없으므로 문자열로. 정밀도를 잃지 않는다.
      return value.toString();
    case 'symbol':
    case 'function':
      return String(value);
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : formatDate(value);
  }

  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return formatBinary(value);
  }

  if (value instanceof Uint8Array) {
    return formatBinary(Buffer.from(value));
  }

  if (Array.isArray(value)) {
    return truncate(JSON.stringify(value.map(toCellValue)));
  }

  // PostgreSQL json/jsonb, Oracle 객체 타입 등
  try {
    return truncate(JSON.stringify(value, jsonReplacer));
  } catch {
    // 순환 참조 등으로 직렬화가 실패한 경우. '[object Object]' 라도 남기는 편이
    // 셀을 비워 두는 것보다 낫다 — 타입은 컬럼 메타데이터에 이미 있다.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return truncate(String(value));
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return formatBinary(value);
  }
  return value;
}

function truncate(text: string): string {
  if (text.length <= MAX_CELL_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_CELL_CHARS)}… (${text.length.toLocaleString()}자 중 앞부분)`;
}

/**
 * 로컬 시간대 기준 `YYYY-MM-DD HH:mm:ss[.SSS]`.
 * ISO 문자열을 그대로 쓰면 UTC 로 바뀌어 표시돼 값이 달라 보인다.
 */
function formatDate(value: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const base =
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  const ms = value.getMilliseconds();
  return ms === 0 ? base : `${base}.${pad(ms, 3)}`;
}

/** 이진 데이터는 앞부분만 16진수로 보여준다. */
function formatBinary(buffer: Buffer): string {
  const previewBytes = 32;
  const hex = buffer.subarray(0, previewBytes).toString('hex');
  const suffix = buffer.length > previewBytes ? '…' : '';
  return `0x${hex}${suffix} (${buffer.length.toLocaleString()} bytes)`;
}

/** 결과 그리드 CSV 내보내기용 이스케이프. */
export function toCsvField(value: CellValue): string {
  if (value === null) {
    return '';
  }
  const text = String(value);
  if (/["\n\r,]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
