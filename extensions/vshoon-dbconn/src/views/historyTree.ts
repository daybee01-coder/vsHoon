import * as vscode from 'vscode';
import type { QueryHistory } from '../features/queryHistory';
import {
  describeRun,
  groupByDay,
  historyLabel,
  type QueryHistoryEntry,
} from '../features/historyIndex';
import { DIALECT_LABELS } from '../types';

/**
 * 사이드바의 쿼리 실행 이력.
 *
 * 이미 명령 팔레트에 이력 검색(QuickPick)이 있지만, 그건 "찾을 것을 알고 있을 때"
 * 쓰는 물건이다. 방금 무엇을 돌렸는지 훑어보고, 실패한 실행을 눈으로 찾고,
 * 어제 쓰던 쿼리를 다시 꺼내는 일은 **항상 보이는 목록**이라야 한다.
 *
 * 날짜로 묶고 각 날짜는 접을 수 있다. 오늘 것만 펼쳐 두는 이유는, 열자마자
 * 수백 줄이 쏟아지면 훑어보기라는 목적 자체가 사라지기 때문이다.
 */

export type HistoryNode =
  | { kind: 'day'; key: number; label: string; count: number }
  | { kind: 'entry'; entry: QueryHistoryEntry }
  | { kind: 'message'; text: string };

/** 실행이 어디서 시작됐는지에 따른 아이콘. 실패는 종류와 무관하게 오류 표시. */
const ORIGIN_ICONS: Record<QueryHistoryEntry['origin'], string> = {
  editor: 'play',
  preview: 'table',
  'grid-edit': 'edit',
  explain: 'graph',
};

export class QueryHistoryTreeProvider
  implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<HistoryNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly history: QueryHistory) {
    this.subscriptions.push(history.onDidChange(() => this.refresh()));
  }

  refresh(): void {
    this.onDidChangeEmitter.fire(undefined);
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    switch (node.kind) {
      case 'day':
        return this.dayItem(node);
      case 'entry':
        return this.entryItem(node.entry);
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.contextValue = 'message';
        return item;
      }
    }
  }

  getChildren(node?: HistoryNode): HistoryNode[] {
    const entries = this.history.list();
    if (!node) {
      if (entries.length === 0) {
        return [{ kind: 'message', text: '실행 이력이 없습니다.' }];
      }
      return groupByDay(entries).map((group) => ({
        kind: 'day',
        key: group.key,
        label: group.label,
        count: group.entries.length,
      }));
    }
    if (node.kind !== 'day') {
      return [];
    }
    const group = groupByDay(entries).find((candidate) => candidate.key === node.key);
    return (group?.entries ?? []).map((entry) => ({ kind: 'entry', entry }));
  }

  private dayItem(node: Extract<HistoryNode, { kind: 'day' }>): vscode.TreeItem {
    // 오늘 것만 펼친 채로 연다 — 나머지는 찾아 들어가는 대상이다.
    const item = new vscode.TreeItem(
      node.label,
      node.label === '오늘'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.description = `${node.count.toLocaleString()}건`;
    item.iconPath = new vscode.ThemeIcon('calendar');
    item.contextValue = 'historyDay';
    // 같은 날짜라도 목록이 바뀌면 다시 그려지도록 개수를 id 에 넣는다.
    item.id = `day:${node.key}:${node.count}`;
    return item;
  }

  private entryItem(entry: QueryHistoryEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(historyLabel(entry.sql));
    item.description = describeRun(entry);
    item.iconPath = new vscode.ThemeIcon(
      entry.status === 'error' ? 'error' : ORIGIN_ICONS[entry.origin],
    );
    item.contextValue = 'historyEntry';
    item.id = `entry:${entry.id}:${entry.runs}`;
    item.tooltip = this.entryTooltip(entry);
    // 클릭 한 번은 편집기에 넣는 것 — 이력에서 가장 자주 하는 일이다.
    item.command = {
      command: 'dbconn.history.insert',
      title: '편집기에 넣기',
      arguments: [{ kind: 'entry', entry } satisfies HistoryNode],
    };
    return item;
  }

  private entryTooltip(entry: QueryHistoryEntry): vscode.MarkdownString {
    const lines = [
      `**${entry.connectionName}** · ${DIALECT_LABELS[entry.dialect]}`,
      '',
      `- ${new Date(entry.startedAt).toLocaleString()}`,
      `- ${describeRun(entry)}`,
    ];
    if (entry.error) {
      lines.push(`- ⚠ ${entry.error}`);
    }
    lines.push('', '```sql', entry.sql, '```');
    const tooltip = new vscode.MarkdownString(lines.join('\n'));
    // SQL 은 사용자가 쓴 글이다. 신뢰할 수 있는 마크다운으로 올리지 않는다.
    tooltip.isTrusted = false;
    tooltip.supportHtml = false;
    return tooltip;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.onDidChangeEmitter.dispose();
  }
}

/** 트리 명령이 받은 인자에서 이력 항목을 꺼낸다. */
export function historyEntryOf(arg: unknown): QueryHistoryEntry | undefined {
  const node = arg as HistoryNode | undefined;
  if (!node || typeof node !== 'object' || !('kind' in node) || node.kind !== 'entry') {
    return undefined;
  }
  return node.entry;
}
