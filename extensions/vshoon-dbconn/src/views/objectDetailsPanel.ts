import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../db/connectionManager';
import type { CatalogCache } from '../metadata/catalog';
import { loadObjectDetail } from '../metadata/objectDetails';
import { quoteIfNeeded } from '../sql/identifier';
import {
  DIALECT_LABELS,
  type ForeignKeyInfo,
  type ObjectDetail,
  type ObjectRef,
} from '../types';
import { log } from '../util/logger';

/**
 * 객체 상세 정보 패널.
 *
 * 트리에서 테이블·뷰·시퀀스 등을 더블클릭하면 열린다. 패널은 **하나만** 두고
 * 내용을 갈아 끼운다 — 객체마다 탭을 만들면 스키마를 훑는 동안 편집기가
 * 순식간에 탭으로 뒤덮인다.
 *
 * 결과 패널과 같은 보안 규칙을 따른다: 값은 postMessage 로만 보내고
 * 웹뷰에서 textContent 로 넣는다. DDL 텍스트도 예외가 아니다 —
 * 서버가 준 문자열이라고 해서 HTML 로 조립하면 그 순간 스크립트 주입이 된다.
 */
export class ObjectDetailsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private current: { profileId: string; ref: ObjectRef } | undefined;
  /** 마지막으로 보여준 상세 — 복사·내보내기 요청에 다시 조회하지 않으려고 들고 있는다. */
  private detail: ObjectDetail | undefined;
  /**
   * 요청 일련번호. 불러오는 동안 사용자가 다른 객체를 더블클릭하면 두 조회가
   * 겹치는데, 늦게 끝난 쪽이 화면을 덮어쓰면 방금 연 객체가 사라진다.
   */
  private requestToken = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connections: ConnectionManager,
    private readonly catalog: CatalogCache,
  ) {}

  async show(profileId: string, ref: ObjectRef): Promise<void> {
    this.current = { profileId, ref };
    const panel = this.ensurePanel();
    panel.title = `${ref.name}`;
    panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active, /* preserveFocus */ true);
    await this.load();
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel(
      'dbconn.objectDetails',
      '객체 상세',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    );
    panel.webview.html = this.buildHtml(panel.webview);
    panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.detail = undefined;
      this.current = undefined;
    });
    this.panel = panel;
    return panel;
  }

  private async load(): Promise<void> {
    const target = this.current;
    const panel = this.panel;
    if (!target || !panel) {
      return;
    }
    const token = ++this.requestToken;

    const session = this.connections.get(target.profileId);
    if (!session) {
      void panel.webview.postMessage({
        type: 'error',
        message: '연결이 해제되어 상세 정보를 읽을 수 없습니다.',
        ref: target.ref,
      });
      return;
    }

    void panel.webview.postMessage({ type: 'loading', ref: target.ref });
    try {
      const detail = await loadObjectDetail(session, this.catalog, target.ref);
      // 기다리는 동안 다른 객체를 열었으면 늦게 온 결과는 버린다.
      if (token !== this.requestToken || !this.panel) {
        return;
      }
      this.detail = detail;
      void this.panel.webview.postMessage({ type: 'detail', detail: serialize(detail) });
    } catch (error) {
      if (token !== this.requestToken) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.warn('객체 상세 정보를 읽지 못했습니다.', error);
      void panel.webview.postMessage({ type: 'error', message, ref: target.ref });
    }
  }

  // ── 웹뷰 → 확장 ───────────────────────────────────────────────────────────

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }
    const type = (message as { type?: unknown }).type;
    if (typeof type !== 'string') {
      return;
    }

    switch (type) {
      case 'refresh':
        await this.load();
        return;

      case 'copy': {
        const text = (message as { text?: unknown }).text;
        if (typeof text === 'string' && text.length <= 5_000_000) {
          await vscode.env.clipboard.writeText(text);
          void vscode.window.setStatusBarMessage('$(check) 클립보드에 복사했습니다.', 2000);
        }
        return;
      }

      case 'openDefinition': {
        const definition = this.detail?.definition;
        if (!definition) {
          return;
        }
        const document = await vscode.workspace.openTextDocument({
          language: 'sql',
          content: definition,
        });
        await vscode.window.showTextDocument(document, { preview: true });
        return;
      }

      case 'openObject': {
        // 외래 키를 눌러 상대 테이블로 이동한다.
        const target = this.current;
        const schema = (message as { schema?: unknown }).schema;
        const name = (message as { name?: unknown }).name;
        if (!target || typeof schema !== 'string' || typeof name !== 'string') {
          return;
        }
        if (schema.length === 0 || name.length === 0) {
          return;
        }
        await this.show(target.profileId, { schema, name, kind: 'table' });
        return;
      }

      case 'preview': {
        const target = this.current;
        if (!target) {
          return;
        }
        await vscode.commands.executeCommand('dbconn.selectTop', {
          kind: 'table',
          profileId: target.profileId,
          table: { schema: target.ref.schema, name: target.ref.name, kind: target.ref.kind },
        });
        return;
      }

      case 'generateSelect': {
        const detail = this.detail;
        if (!detail) {
          return;
        }
        const document = await vscode.workspace.openTextDocument({
          language: 'sql',
          content: buildSelectTemplate(detail),
        });
        await vscode.window.showTextDocument(document, { preview: false });
        return;
      }

      default:
        log.debug(`알 수 없는 상세 패널 메시지: ${type}`);
    }
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'details.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'details.css'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>객체 상세</title>
</head>
<body>
  <header id="head">
    <div id="identity">
      <span id="kind" class="badge"></span>
      <h1 id="name"></h1>
    </div>
    <div id="source"></div>
    <div id="actions">
      <button id="btn-preview" type="button" title="상위 200건 조회">데이터 보기</button>
      <button id="btn-select" type="button" title="컬럼을 나열한 SELECT 문을 새 편집기로">SELECT 생성</button>
      <button id="btn-ddl" type="button" title="정의를 새 편집기로">DDL 열기</button>
      <button id="btn-refresh" type="button" title="다시 읽기">새로고침</button>
    </div>
  </header>
  <main id="content">
    <div class="placeholder">객체를 선택하면 상세 정보가 표시됩니다.</div>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.detail = undefined;
  }
}

/** 웹뷰로 보낼 수 있는 평평한 형태로 바꾼다 (Map/Date 없음). */
function serialize(detail: ObjectDetail): unknown {
  return {
    schema: detail.ref.schema,
    name: detail.ref.name,
    kind: detail.ref.kind,
    connectionName: detail.connectionName,
    dialectLabel: DIALECT_LABELS[detail.dialect],
    comment: detail.comment,
    attributes: detail.attributes,
    columns: (detail.columns ?? []).map((column) => ({
      name: column.name,
      typeName: column.typeName,
      nullable: column.nullable,
      defaultValue: column.defaultValue,
      isPrimaryKey: column.isPrimaryKey,
      comment: column.comment,
    })),
    indexes: (detail.indexes ?? []).map((index) => ({
      name: index.name,
      unique: index.unique,
      columns: index.columns,
    })),
    foreignKeys: (detail.foreignKeys ?? []).map(serializeForeignKey),
    referencedBy: (detail.referencedBy ?? []).map(serializeForeignKey),
    definition: detail.definition,
    definitionIsApproximate: detail.definitionIsApproximate === true,
    notes: detail.notes,
    canPreview:
      detail.ref.kind === 'table' ||
      detail.ref.kind === 'view' ||
      detail.ref.kind === 'materialized-view',
  };
}

function serializeForeignKey(key: ForeignKeyInfo): unknown {
  return {
    name: key.name,
    schema: key.schema,
    table: key.table,
    columns: key.columns,
    referencedSchema: key.referencedSchema,
    referencedTable: key.referencedTable,
    referencedColumns: key.referencedColumns,
    onDelete: key.onDelete,
    onUpdate: key.onUpdate,
  };
}

/** 컬럼을 나열한 SELECT 문 — `SELECT *` 보다 손대기 편하다. */
function buildSelectTemplate(detail: ObjectDetail): string {
  const dialect = detail.dialect;
  const quote = (name: string): string => quoteIfNeeded(name, dialect);
  const columns = detail.columns ?? [];
  const list =
    columns.length === 0 ? '  *' : columns.map((column) => `  ${quote(column.name)}`).join(',\n');
  return `SELECT\n${list}\n  FROM ${quote(detail.ref.schema)}.${quote(detail.ref.name)}\n`;
}
