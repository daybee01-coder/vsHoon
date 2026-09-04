import * as vscode from 'vscode';

export interface BroadcastTarget {
  writeRaw(data: string): void;
}

/**
 * 켜져 있는 동안, 등록된 SSH 터미널 중 하나에 입력하면 나머지 모든 터미널에도 같은 입력을 전달한다.
 * WSL 터미널은 vscode.Pseudoterminal이 아니라 일반 셸 터미널이라 확장이 입력을 가로챌 방법이 없어
 * 이 브로드캐스트 대상에 포함되지 않는다.
 */
export class BroadcastManager {
  private enabled = false;
  private readonly targets = new Set<BroadcastTarget>();

  private readonly onDidChangeEnabledEmitter = new vscode.EventEmitter<boolean>();
  readonly onDidChangeEnabled = this.onDidChangeEnabledEmitter.event;

  register(target: BroadcastTarget): void {
    this.targets.add(target);
  }

  unregister(target: BroadcastTarget): void {
    this.targets.delete(target);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    this.onDidChangeEnabledEmitter.fire(this.enabled);
    return this.enabled;
  }

  broadcastFrom(source: BroadcastTarget, data: string): void {
    if (!this.enabled) return;
    for (const target of this.targets) {
      if (target !== source) {
        target.writeRaw(data);
      }
    }
  }
}
