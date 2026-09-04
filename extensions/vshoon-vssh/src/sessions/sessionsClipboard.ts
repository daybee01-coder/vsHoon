export type SessionClipboardMode = 'copy' | 'cut';

export interface SessionClipboardEntry {
  id: string;
}

export interface SessionClipboardState {
  mode: SessionClipboardMode;
  entries: SessionClipboardEntry[];
}

export class SessionsClipboard {
  private mode: SessionClipboardMode | undefined;
  private entries: SessionClipboardEntry[] = [];

  set(mode: SessionClipboardMode, entries: SessionClipboardEntry[]): void {
    this.mode = mode;
    this.entries = entries;
  }

  get(): SessionClipboardState | undefined {
    if (!this.mode || this.entries.length === 0) return undefined;
    return { mode: this.mode, entries: this.entries };
  }

  clear(): void {
    this.mode = undefined;
    this.entries = [];
  }
}
