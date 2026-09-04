import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { DialectId } from '../types';
import {
  appendEntry,
  clipSql,
  normalizeHistory,
  pruneHistory,
  type QueryHistoryEntry,
  type QueryOrigin,
} from './historyIndex';
import { log } from '../util/logger';

/**
 * 쿼리 실행 이력.
 *
 * 실행한 SQL 과 결과 요약만 남긴다. 결과 데이터는 담지 않는다 —
 * 저장소가 커지는 문제도 있지만, 조회한 개인정보가 이력에 오래 남는 편이
 * 훨씬 위험하다.
 *
 * 편집기 실행 · 트리 미리보기 · 그리드 편집(UPDATE/DELETE) · 실행 계획을
 * 모두 기록한다. 특히 그리드 편집은 "언제 무엇을 바꿨는지"를 나중에
 * 되짚을 수 있어야 한다.
 */

const KEY = 'dbconn.history.v1';

export interface RecordInput {
  sql: string;
  profileId: string;
  connectionName: string;
  dialect: DialectId;
  origin: QueryOrigin;
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  rowCount?: number;
  affectedRows?: number;
  error?: string;
}

export class QueryHistory implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /** 목록이 바뀔 때 발생. 사이드바 이력 뷰가 구독한다. */
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('dbconn').get<boolean>('history.enabled', true);
  }

  list(): QueryHistoryEntry[] {
    return normalizeHistory(this.context.globalState.get<unknown>(KEY, []));
  }

  /** 실행 하나를 기록한다. 실패해도 실행 흐름을 방해하지 않는다. */
  record(input: RecordInput): void {
    if (!this.enabled()) {
      return;
    }
    const sql = input.sql.trim();
    if (sql.length === 0) {
      return;
    }

    const entry: QueryHistoryEntry = {
      id: randomBytes(8).toString('hex'),
      sql: clipSql(sql),
      profileId: input.profileId,
      connectionName: input.connectionName,
      dialect: input.dialect,
      origin: input.origin,
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      status: input.status,
      rowCount: input.rowCount,
      affectedRows: input.affectedRows,
      error: input.error === undefined ? undefined : firstLine(input.error),
      runs: 1,
    };

    void this.persist(appendEntry(this.list(), entry)).catch((error: unknown) => {
      log.debug('쿼리 이력 저장 실패', error);
    });
  }

  async remove(id: string): Promise<void> {
    await this.persist(this.list().filter((entry) => entry.id !== id));
  }

  async clear(): Promise<void> {
    await this.context.globalState.update(KEY, []);
    this.onDidChangeEmitter.fire();
  }

  private async persist(entries: QueryHistoryEntry[]): Promise<void> {
    const config = vscode.workspace.getConfiguration('dbconn');
    const pruned = pruneHistory(entries, {
      maxEntries: config.get<number>('history.maxEntries', 200),
      retentionDays: config.get<number>('history.retentionDays', 30),
      now: Date.now(),
    });
    await this.context.globalState.update(KEY, pruned);
    this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? text;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
