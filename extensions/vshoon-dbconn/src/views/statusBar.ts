import * as vscode from 'vscode';
import type { ConnectionManager } from '../db/connectionManager';
import {
  environmentBadge,
  environmentLabel,
  environmentStatusBackground,
} from '../config/environment';
import { DIALECT_LABELS } from '../types';

/**
 * 상태바 표시.
 *
 * 두 항목을 둔다:
 *  - 활성 연결 (클릭하면 전환)
 *  - 트랜잭션 상태 (열려 있을 때만 나타나며, 클릭하면 커밋/롤백)
 *
 * 트랜잭션이 열린 채로 잊히는 것이 이 종류의 도구에서 가장 흔한 사고다.
 * 그래서 열려 있는 동안은 눈에 띄게(경고 색으로) 항상 보이게 한다.
 */
export class StatusBar implements vscode.Disposable {
  private readonly connectionItem: vscode.StatusBarItem;
  private readonly transactionItem: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly connections: ConnectionManager) {
    this.connectionItem = vscode.window.createStatusBarItem(
      'dbconn.connection',
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.connectionItem.name = 'DBConn 활성 연결';
    this.connectionItem.command = 'dbconn.setActiveConnection';

    this.transactionItem = vscode.window.createStatusBarItem(
      'dbconn.transaction',
      vscode.StatusBarAlignment.Left,
      99,
    );
    this.transactionItem.name = 'DBConn 트랜잭션';
    this.transactionItem.command = 'dbconn.commit';

    this.subscriptions.push(
      connections.onDidChange(() => this.update()),
      // 편집기를 옮기면 그 편집기에 지정된 연결로 표시가 바뀌어야 한다.
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
    );
    this.update();
  }

  update(): void {
    const session = this.connections.activeSession();
    // 이 편집기에 연결이 지정돼 있는지 — 표시가 달라진다.
    const boundId = this.connections.boundProfileId(this.connections.currentEditorKey());

    if (!session) {
      // 지정은 있는데 아직 접속 전인 경우와, 아무것도 없는 경우를 구분해 준다.
      this.connectionItem.text = boundId
        ? '$(plug) DB: 지정된 연결 (연결 안 됨)'
        : '$(plug) DB: 연결 없음';
      this.connectionItem.tooltip = boundId
        ? '이 편집기에 지정된 연결이 아직 열려 있지 않습니다. 실행하면 연결하거나, 클릭해서 다른 연결을 고르세요.'
        : '클릭해서 연결을 선택합니다.';
      this.connectionItem.backgroundColor = undefined;
      this.connectionItem.show();
      this.transactionItem.hide();
      return;
    }

    const profile = session.profile;
    const icon = session.isRunning ? '$(sync~spin)' : '$(database)';
    const readOnly = profile.readOnly ? ' $(lock)' : '';
    // 편집기에 고정된 연결은 압정으로 표시한다 — 전역 기본을 바꿔도 이 파일은
    // 이 연결로 실행된다는 뜻이므로, 눈에 보이지 않으면 오히려 헷갈린다.
    const pinned = boundId === profile.id ? ' $(pin)' : '';
    const badge = environmentBadge(profile.environment);
    this.connectionItem.text =
      `${icon} ${badge ? `[${badge}] ` : ''}${profile.name}${readOnly}${pinned}`;
    this.connectionItem.tooltip = new vscode.MarkdownString(
      [
        `**${profile.name}**`,
        '',
        `- 환경: ${environmentLabel(profile.environment)}`,
        `- ${DIALECT_LABELS[profile.dialect]} · \`${profile.host}:${profile.port}\``,
        `- 커밋 모드: ${session.autoCommit ? '자동' : '수동'}`,
        profile.readOnly ? '- 읽기 전용' : '',
        boundId === profile.id
          ? '- $(pin) 이 편집기 전용 연결'
          : '- 전역 기본 연결 (이 편집기에는 지정 없음)',
        '',
        '클릭하면 이 편집기에서 쓸 연결을 고릅니다.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    // 운영/스테이징에 붙어 있으면 상태바 자체를 물들인다 — 눈에 거슬리는 것이 목적이다.
    const background = environmentStatusBackground(profile.environment);
    this.connectionItem.backgroundColor = background
      ? new vscode.ThemeColor(background)
      : undefined;
    this.connectionItem.show();

    // ── 트랜잭션 ──
    const state = session.transactionState;
    if (session.autoCommit && state === 'none') {
      this.transactionItem.hide();
      return;
    }

    if (state === 'active') {
      this.transactionItem.text = '$(git-commit) 트랜잭션 열림';
      this.transactionItem.tooltip = '커밋되지 않은 변경이 있습니다. 클릭하면 커밋합니다.';
      this.transactionItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground',
      );
    } else if (state === 'failed') {
      this.transactionItem.text = '$(error) 트랜잭션 오류 — 롤백 필요';
      this.transactionItem.tooltip =
        '오류로 트랜잭션이 중단됐습니다. 롤백해야 이후 구문이 실행됩니다.';
      this.transactionItem.command = 'dbconn.rollback';
      this.transactionItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.errorBackground',
      );
    } else {
      this.transactionItem.text = '$(circle-outline) 수동 커밋';
      this.transactionItem.tooltip = '수동 커밋 모드입니다. 클릭하면 자동 커밋으로 되돌립니다.';
      this.transactionItem.command = 'dbconn.toggleAutoCommit';
      this.transactionItem.backgroundColor = undefined;
    }
    this.transactionItem.show();
  }

  dispose(): void {
    this.connectionItem.dispose();
    this.transactionItem.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}
