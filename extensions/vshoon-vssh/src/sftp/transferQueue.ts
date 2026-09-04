import * as vscode from 'vscode';
import type { FileSession } from './fileSession';

export type TransferDirection = 'upload' | 'download';
export type TransferStatus = 'queued' | 'active' | 'done' | 'error' | 'canceled';

export interface TransferItem {
  id: string;
  direction: TransferDirection;
  /** 화면 표시용 상대 경로/이름 */
  label: string;
  localPath: string;
  remotePath: string;
  /** 큐에 추가할 당시의 원격 세션. 활성 터미널이 바뀌어도 이 세션에서 실행한다. */
  remoteSession: FileSession;
  size: number;
  transferred: number;
  status: TransferStatus;
  error?: string;
  /** 권한/시각 보존용. upload=로컬 원본 값, download=원격 원본 값. */
  mode?: number;
  mtime?: number;
  /** 대상에 같은 파일이 이미 있어 덮어쓰는 항목인지. 취소 시 부분 파일 삭제 여부 판단에 쓴다. */
  overwrite?: boolean;
  controller?: AbortController;
}

export type TransferRunner = (
  item: TransferItem,
  onProgress: (transferred: number, total: number) => void,
  signal: AbortSignal
) => Promise<void>;

/**
 * 파일 단위 전송을 최대 concurrency개까지 동시에 처리하는 큐.
 * 폴더는 호출자가 미리 파일 목록으로 펼쳐서 add 한다.
 * 각 항목은 AbortController를 가져서 진행 중이어도 개별 취소가 가능하다.
 */
export class TransferQueue {
  private readonly items: TransferItem[] = [];
  private active = 0;
  private concurrency: number;
  private readonly updateEmitter = new vscode.EventEmitter<void>();
  readonly onDidUpdate = this.updateEmitter.event;

  constructor(private readonly runner: TransferRunner, concurrency = 5) {
    this.concurrency = Math.max(1, concurrency);
  }

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.floor(n) || 1);
    this.pump();
  }

  add(newItems: TransferItem[]): void {
    if (newItems.length === 0) return;
    this.items.push(...newItems);
    this.updateEmitter.fire();
    this.pump();
  }

  list(): readonly TransferItem[] {
    return this.items;
  }

  isIdle(): boolean {
    return !this.items.some((i) => i.status === 'queued' || i.status === 'active');
  }

  cancelItem(id: string): void {
    const it = this.items.find((i) => i.id === id);
    if (!it) return;
    if (it.status === 'queued') it.status = 'canceled';
    else if (it.status === 'active') it.controller?.abort();
    this.updateEmitter.fire();
  }

  cancelAll(): void {
    for (const it of this.items) {
      if (it.status === 'queued') it.status = 'canceled';
      else if (it.status === 'active') it.controller?.abort();
    }
    this.updateEmitter.fire();
  }

  clearFinished(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const s = this.items[i].status;
      if (s === 'done' || s === 'error' || s === 'canceled') this.items.splice(i, 1);
    }
    this.updateEmitter.fire();
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const next = this.items.find((i) => i.status === 'queued');
      if (!next) break;
      next.status = 'active';
      next.controller = new AbortController();
      this.active++;
      void this.runOne(next);
    }
    this.updateEmitter.fire();
  }

  private async runOne(item: TransferItem): Promise<void> {
    let lastFire = 0;
    try {
      await this.runner(
        item,
        (transferred, total) => {
          item.transferred = transferred;
          if (total > 0) item.size = total;
          const now = Date.now();
          if (now - lastFire > 200) {
            lastFire = now;
            this.updateEmitter.fire();
          }
        },
        item.controller!.signal
      );
      if (item.controller!.signal.aborted) {
        item.status = 'canceled';
      } else {
        item.status = 'done';
        item.transferred = item.size;
      }
    } catch (err) {
      item.status = item.controller?.signal.aborted ? 'canceled' : 'error';
      if (item.status === 'error') item.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.active--;
      this.updateEmitter.fire();
      this.pump();
    }
  }
}
