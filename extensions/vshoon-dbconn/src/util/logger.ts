import * as vscode from 'vscode';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

/**
 * 로그에 자격 증명이 새지 않도록 하는 마스킹 규칙.
 * 드라이버 오류 메시지는 접속 문자열을 통째로 담는 경우가 있어 방어적으로 걸러낸다.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  // password=... / pwd: "..." 형태
  [/((?:password|passwd|pwd|secret|token)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;)&]+)/gi, '$1***'],
  // URL 자격 증명 scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)([^@\s]+)(@)/gi, '$1***$3'],
];

export function redact(value: string): string {
  let out = value;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

class Logger implements vscode.Disposable {
  private channel: vscode.LogOutputChannel | undefined;
  private level: LogLevel = 'info';

  init(): void {
    this.channel ??= vscode.window.createOutputChannel('DBConn', { log: true });
    this.applyConfig();
  }

  applyConfig(): void {
    const configured = vscode.workspace.getConfiguration('dbconn').get<LogLevel>('log.level', 'info');
    this.level = ORDER[configured] === undefined ? 'info' : configured;
  }

  show(): void {
    this.channel?.show(true);
  }

  private write(level: LogLevel, message: string, ...args: unknown[]): void {
    if (ORDER[level] > ORDER[this.level]) {
      return;
    }
    const text = redact(format(message, args));
    const ch = this.channel;
    if (!ch) {
      return;
    }
    switch (level) {
      case 'error':
        ch.error(text);
        break;
      case 'warn':
        ch.warn(text);
        break;
      case 'info':
        ch.info(text);
        break;
      default:
        ch.debug(text);
        break;
    }
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, ...args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, ...args);
  }
  info(message: string, ...args: unknown[]): void {
    this.write('info', message, ...args);
  }
  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, ...args);
  }
  trace(message: string, ...args: unknown[]): void {
    this.write('trace', message, ...args);
  }

  dispose(): void {
    this.channel?.dispose();
    this.channel = undefined;
  }
}

function format(message: string, args: unknown[]): string {
  if (args.length === 0) {
    return message;
  }
  const rendered = args.map((a) => {
    if (a instanceof Error) {
      return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`;
    }
    if (typeof a === 'string') {
      return a;
    }
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  });
  return `${message} ${rendered.join(' ')}`;
}

export const log = new Logger();
