import { DEFAULT_PORTS, type DialectId } from '../types';

/**
 * 연결 URL 파싱과 조립.
 *
 * 팀에서 접속 정보를 주고받는 단위는 대개 URL 한 줄이다 — 위키에 적힌
 * `postgres://app@db-prod:5432/orders`, JDBC 설정 파일의 문자열, docker-compose
 * 환경 변수. 그걸 칸마다 나눠 다시 타이핑하게 만들면 옮겨 적다 틀리기 좋다.
 * 그래서 붙여 넣으면 칸이 채워지게 한다.
 *
 * 파싱은 **관대하게, 반영은 보수적으로** 한다: 알아본 값만 채우고, 모르는
 * 파라미터는 버리되 무엇을 버렸는지 알려 준다. 조용히 삼키면 "URL 에
 * sslmode 를 넣었는데 왜 평문으로 붙었지" 같은 일이 생긴다.
 *
 * vscode API 를 쓰지 않는다 — 테스트에서 그대로 부를 수 있게.
 */

export interface ParsedConnectionUrl {
  dialect: DialectId;
  host: string;
  port: number;
  /** MySQL/PostgreSQL 은 데이터베이스, Oracle 은 서비스 이름 또는 SID. */
  database: string;
  user?: string;
  /** URL 에 비밀번호가 들어 있던 경우에만. */
  password?: string;
  oracleConnectType?: 'service' | 'sid';
  /** TLS 를 켤지. URL 이 아무 말도 하지 않으면 undefined — 기존 설정을 건드리지 않는다. */
  tlsEnabled?: boolean;
  /** 인증서 검증 여부. sslmode=require 처럼 "암호화만" 요구하면 false. */
  tlsVerify?: boolean;
  /** 알아보지 못해 반영하지 않은 파라미터 이름. 화면에서 안내로 보여 준다. */
  ignoredParams: string[];
}

export type ParseResult =
  | { ok: true; value: ParsedConnectionUrl }
  | { ok: false; error: string };

/** 받아들이는 스킴 → 방언. */
const SCHEMES: Record<string, DialectId> = {
  mysql: 'mysql',
  mariadb: 'mariadb',
  postgres: 'postgres',
  postgresql: 'postgres',
  pgsql: 'postgres',
  oracle: 'oracle',
};

/** 값을 이미 반영했으므로 "무시했다"고 알리지 않을 파라미터. */
const HANDLED_PARAMS = new Set([
  'ssl',
  'usessl',
  'sslmode',
  'ssl-mode',
  'sslverify',
  'verifyservercertificate',
  'user',
  'username',
  'password',
  'connecttype',
  'oracleconnecttype',
]);

/**
 * URL 한 줄에서 접속 정보를 뽑는다.
 *
 * 받아들이는 모양:
 *  - `mysql://user:pass@host:3306/db?ssl=true`
 *  - `postgresql://user@host/db?sslmode=require`
 *  - `oracle://user:pass@host:1521/SERVICE`
 *  - `jdbc:mariadb://host:3306/db?user=app`
 *  - `jdbc:oracle:thin:@//host:1521/service` · `jdbc:oracle:thin:user/pw@host:1521:SID`
 */
export function parseConnectionUrl(input: string): ParseResult {
  const raw = input.trim();
  if (raw === '') {
    return { ok: false, error: 'URL 을 입력하세요.' };
  }

  const lower = raw.toLowerCase();
  if (lower.startsWith('jdbc:oracle:')) {
    return parseOracleJdbc(raw);
  }

  // `jdbc:` 접두어는 벗겨 내고 나머지를 일반 URL 로 본다.
  const body = lower.startsWith('jdbc:') ? raw.slice(5) : raw;
  const separator = body.indexOf('://');
  const scheme = separator === -1 ? '' : body.slice(0, separator).toLowerCase();
  const dialect = SCHEMES[scheme];
  if (!dialect) {
    return {
      ok: false,
      error:
        'mysql:// · mariadb:// · postgresql:// · oracle:// · jdbc: 로 시작하는 URL 만 인식합니다.',
    };
  }

  let url: URL;
  try {
    url = new URL(body);
  } catch {
    return { ok: false, error: 'URL 형식이 올바르지 않습니다.' };
  }

  const host = decodeHost(url.hostname);
  if (!host) {
    return { ok: false, error: '호스트를 읽지 못했습니다.' };
  }

  const port = url.port === '' ? DEFAULT_PORTS[dialect] : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: '포트는 1–65535 사이의 정수여야 합니다.' };
  }

  const params = collectParams(url.searchParams);
  const parsed: ParsedConnectionUrl = {
    dialect,
    host,
    port,
    database: decodeSegment(url.pathname.replace(/^\//, '')),
    ignoredParams: params.ignored,
  };

  const user = decodeSegment(url.username) || params.user;
  if (user) {
    parsed.user = user;
  }
  const password = url.password === '' ? params.password : decodeSegment(url.password);
  if (password) {
    parsed.password = password;
  }
  applyTls(parsed, params);
  if (dialect === 'oracle') {
    parsed.oracleConnectType = params.oracleConnectType ?? 'service';
  }
  return { ok: true, value: parsed };
}

/**
 * `jdbc:oracle:thin:` 형태.
 *
 * 이 문자열만 모양이 셋이다 — 서비스 이름은 `@//host:port/service`,
 * SID 는 `@host:port:sid`, 그리고 앞에 `user/password` 가 붙기도 한다.
 * WHATWG URL 로는 어느 쪽도 읽히지 않아 직접 자른다.
 */
function parseOracleJdbc(raw: string): ParseResult {
  const at = raw.indexOf('@');
  if (at === -1) {
    return { ok: false, error: 'Oracle JDBC URL 에서 접속 대상(@ 뒤)을 찾지 못했습니다.' };
  }

  // `jdbc:oracle:thin:user/password@…` — 드라이버 이름 뒤, @ 앞의 자격 증명.
  const head = raw.slice(0, at);
  const [user, password] = splitOnce(head.split(':').pop() ?? '', '/');

  const [targetBody, query] = splitOnce(raw.slice(at + 1).trim(), '?');
  const target = targetBody.replace(/^\/\//, '');

  const parsed: ParsedConnectionUrl = {
    dialect: 'oracle',
    host: '',
    port: DEFAULT_PORTS.oracle,
    database: '',
    oracleConnectType: 'service',
    ignoredParams: [],
  };
  if (user) {
    parsed.user = user;
  }
  if (password) {
    parsed.password = password;
  }

  const slash = target.indexOf('/');
  if (slash !== -1) {
    // `host:port/service`
    const split = splitHostPort(target.slice(0, slash));
    if (!split) {
      return { ok: false, error: '호스트와 포트를 읽지 못했습니다.' };
    }
    parsed.host = split.host;
    parsed.port = split.port ?? DEFAULT_PORTS.oracle;
    parsed.database = target.slice(slash + 1);
  } else {
    // `host:port:sid` — 이 모양은 언제나 SID 다.
    const parts = target.split(':');
    if (parts.length < 2) {
      return { ok: false, error: 'Oracle JDBC URL 에서 서비스 이름 또는 SID 를 찾지 못했습니다.' };
    }
    parsed.host = parts[0]!;
    parsed.port = parts.length >= 3 ? Number(parts[1]) : DEFAULT_PORTS.oracle;
    parsed.database = parts[parts.length - 1]!;
    parsed.oracleConnectType = 'sid';
  }

  if (parsed.host === '' || parsed.database === '') {
    return { ok: false, error: 'Oracle JDBC URL 에서 호스트 또는 서비스 이름을 찾지 못했습니다.' };
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    return { ok: false, error: '포트는 1–65535 사이의 정수여야 합니다.' };
  }

  if (query) {
    const params = collectParams(new URLSearchParams(query));
    parsed.ignoredParams = params.ignored;
    parsed.user ??= params.user;
    parsed.password ??= params.password;
    if (params.oracleConnectType) {
      parsed.oracleConnectType = params.oracleConnectType;
    }
    applyTls(parsed, params);
  }
  return { ok: true, value: parsed };
}

interface UrlParams {
  user?: string;
  password?: string;
  ssl?: string;
  sslMode?: string;
  oracleConnectType?: 'service' | 'sid';
  ignored: string[];
}

function collectParams(search: URLSearchParams): UrlParams {
  const params: UrlParams = { ignored: [] };
  for (const [rawKey, value] of search) {
    const key = rawKey.toLowerCase();
    switch (key) {
      case 'user':
      case 'username':
        params.user = value;
        break;
      case 'password':
        params.password = value;
        break;
      case 'ssl':
      case 'usessl':
        params.ssl = value.toLowerCase();
        break;
      case 'sslmode':
      case 'ssl-mode':
        params.sslMode = value.toLowerCase();
        break;
      case 'sslverify':
      case 'verifyservercertificate':
        params.ssl ??= 'true';
        params.sslMode = value.toLowerCase() === 'false' ? 'require' : 'verify-full';
        break;
      case 'connecttype':
      case 'oracleconnecttype':
        params.oracleConnectType = value.toLowerCase() === 'sid' ? 'sid' : 'service';
        break;
      default:
        break;
    }
    if (!HANDLED_PARAMS.has(key)) {
      params.ignored.push(rawKey);
    }
  }
  return params;
}

/**
 * ssl / sslmode 를 TLS 설정으로 옮긴다.
 *
 * `require` 는 "암호화는 하되 인증서는 보지 않는다"는 뜻이다(PostgreSQL 정의).
 * 그대로 옮겨야 URL 이 약속한 것과 실제 연결이 어긋나지 않는다.
 */
function applyTls(parsed: ParsedConnectionUrl, params: UrlParams): void {
  const mode = params.sslMode;
  if (mode) {
    if (mode === 'disable' || mode === 'disabled' || mode === 'false') {
      parsed.tlsEnabled = false;
      return;
    }
    parsed.tlsEnabled = true;
    parsed.tlsVerify =
      mode === 'verify-ca' || mode === 'verify-full' || mode === 'verify_identity';
    return;
  }
  if (params.ssl === undefined) {
    return;
  }
  const enabled = params.ssl !== 'false' && params.ssl !== '0' && params.ssl !== 'disabled';
  parsed.tlsEnabled = enabled;
  if (enabled) {
    parsed.tlsVerify = true;
  }
}

/** 화면·복사용 URL. 비밀번호는 절대 넣지 않는다. */
export function formatConnectionUrl(profile: {
  dialect: DialectId;
  host: string;
  port: number;
  database: string;
  user: string;
  tlsEnabled?: boolean;
  tlsVerify?: boolean;
  oracleConnectType?: 'service' | 'sid';
}): string {
  const scheme = profile.dialect === 'postgres' ? 'postgresql' : profile.dialect;
  const host =
    profile.host.includes(':') && !profile.host.startsWith('[') ? `[${profile.host}]` : profile.host;
  const auth = profile.user ? `${encodeURIComponent(profile.user)}@` : '';
  const path = profile.database ? `/${encodeURIComponent(profile.database)}` : '';

  const query: string[] = [];
  if (profile.tlsEnabled) {
    query.push(`sslmode=${profile.tlsVerify === false ? 'require' : 'verify-full'}`);
  }
  if (profile.dialect === 'oracle' && profile.oracleConnectType === 'sid') {
    query.push('connectType=sid');
  }
  const search = query.length > 0 ? `?${query.join('&')}` : '';
  return `${scheme}://${auth}${host}:${profile.port}${path}${search}`;
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  return index === -1
    ? [value, undefined]
    : [value.slice(0, index), value.slice(index + separator.length)];
}

/** `host:port` — IPv6 대괄호를 살려서 나눈다. */
function splitHostPort(value: string): { host: string; port?: number } | undefined {
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) {
      return undefined;
    }
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    return rest.startsWith(':') ? { host, port: Number(rest.slice(1)) } : { host };
  }
  const colon = value.lastIndexOf(':');
  if (colon === -1) {
    return value === '' ? undefined : { host: value };
  }
  return { host: value.slice(0, colon), port: Number(value.slice(colon + 1)) };
}

/** WHATWG URL 은 IPv6 를 대괄호째 돌려준다 — 저장할 때는 벗긴다. */
function decodeHost(hostname: string): string {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return decodeSegment(host);
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // 퍼센트 기호가 그냥 들어 있는 경우 — 원문을 그대로 쓴다.
    return value;
  }
}
