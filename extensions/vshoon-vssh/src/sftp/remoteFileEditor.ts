/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { FileSession, FileStat } from './fileSession';
import { isProbablyTextFile, remoteFileChanged, safeTemporaryFileName } from './remoteFileEditingUtils';

const TEMP_ROOT_NAME = 'vshoon-vssh-edits';
const STALE_EDIT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type OpenMode = 'text' | 'vscode' | 'external-default' | 'external-picker';

interface RemoteEdit {
  readonly session: FileSession;
  readonly remotePath: string;
  readonly temporaryDirectory: string;
  readonly temporaryPath: string;
  readonly originalHash: string;
  readonly originalStat: FileStat;
  openMode: OpenMode;
  processing: boolean;
}

/** 원격 파일을 임시 파일로 편집하고, 닫을 때 변경분을 명시적으로 서버에 반영한다. */
export class RemoteFileEditorManager implements vscode.Disposable {
  private readonly edits = new Map<string, RemoteEdit>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly temporaryRoot = path.join(os.tmpdir(), TEMP_ROOT_NAME);

  constructor(private readonly onDidUpload?: () => void | Promise<void>) {
    this.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        for (const tab of event.closed) {
          const uri = tabResource(tab);
          if (uri?.scheme !== 'file') {
            continue;
          }
          const edit = this.edits.get(fileKey(uri.fsPath));
          if (edit) {
            setTimeout(() => {
              if (!this.isOpenInVsHoon(edit.temporaryPath)) {
                void this.finishEditorEdit(edit);
              }
            }, 0);
          }
        }
      })
    );
    void this.removeStaleTemporaryDirectories();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }

  async open(session: FileSession, remotePath: string): Promise<void> {
    let edit: RemoteEdit | undefined;
    try {
      edit = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `VSsh: ${path.posix.basename(remotePath)} 다운로드 중...`,
        },
        async () => this.downloadTemporaryCopy(session, remotePath)
      );
      this.edits.set(fileKey(edit.temporaryPath), edit);

      const content = await readFileSample(edit.temporaryPath, 8192);
      if (isProbablyTextFile(content)) {
        edit.openMode = 'text';
        try {
          await this.openInVsHoon(edit);
          return;
        } catch {
          // 확장자별 편집기나 인코딩 판정이 파일 열기를 거부하면 아래 연결 프로그램 선택으로 전환한다.
        }
      }

      const picked = await vscode.window.showQuickPick(
        [
          {
            label: '$(window) vs Hoon 기본 뷰어',
            description: '등록된 이미지·미디어·사용자 편집기로 열기',
            mode: 'vscode' as const,
          },
          {
            label: '$(link-external) 시스템 기본 앱',
            description: 'Windows에 연결된 기본 프로그램으로 열기',
            mode: 'external-default' as const,
          },
          ...(process.platform === 'win32'
            ? [
                {
                  label: '$(list-selection) 다른 앱 선택…',
                  description: 'Windows 연결 프로그램 선택 창 열기',
                  mode: 'external-picker' as const,
                },
              ]
            : []),
        ],
        {
          title: `VSsh: ${path.posix.basename(remotePath)}을(를) 열 프로그램 선택`,
          placeHolder: '텍스트 편집기로 열 수 없는 파일입니다.',
          ignoreFocusOut: true,
        }
      );
      if (!picked) {
        await this.release(edit, false);
        return;
      }

      edit.openMode = picked.mode;
      if (picked.mode === 'vscode') {
        await this.openInVsHoon(edit);
      } else {
        await this.openExternally(edit);
      }
    } catch (error) {
      if (edit) {
        await this.release(edit, true);
      }
      vscode.window.showErrorMessage(`VSsh: 원격 파일을 열 수 없습니다 - ${describe(error)}`);
    }
  }

  private async downloadTemporaryCopy(session: FileSession, remotePath: string): Promise<RemoteEdit> {
    await fs.promises.mkdir(this.temporaryRoot, { recursive: true });
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(this.temporaryRoot, 'edit-'));
    const temporaryPath = path.join(temporaryDirectory, safeTemporaryFileName(path.posix.basename(remotePath)));
    try {
      const originalStat = await session.stat(remotePath);
      if (originalStat.isDirectory) {
        throw new Error('폴더는 편집기로 열 수 없습니다.');
      }
      await session.download(remotePath, temporaryPath);
      return {
        session,
        remotePath,
        temporaryDirectory,
        temporaryPath,
        originalHash: await fileHash(temporaryPath),
        originalStat,
        openMode: 'text',
        processing: false,
      };
    } catch (error) {
      await fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async openInVsHoon(edit: RemoteEdit): Promise<void> {
    const uri = vscode.Uri.file(edit.temporaryPath);
    if (edit.openMode === 'text') {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    } else {
      await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
    }
  }

  private async openExternally(edit: RemoteEdit): Promise<void> {
    if (edit.openMode === 'external-picker') {
      await openWithWindowsPicker(edit.temporaryPath);
    } else {
      const opened = await vscode.env.openExternal(vscode.Uri.file(edit.temporaryPath));
      if (!opened) {
        throw new Error('시스템 기본 앱을 시작하지 못했습니다.');
      }
    }

    const choice = await vscode.window.showInformationMessage(
      `VSsh: 외부 앱에서 "${path.basename(edit.temporaryPath)}" 편집을 마친 뒤 변경 확인을 선택하세요.`,
      { modal: false },
      '변경 확인',
      '임시 파일 유지'
    );
    if (choice === '변경 확인') {
      await this.finishEditorEdit(edit);
    } else {
      this.edits.delete(fileKey(edit.temporaryPath));
      vscode.window.showInformationMessage(`VSsh: 임시 파일을 유지했습니다 - ${edit.temporaryPath}`);
    }
  }

  private async finishEditorEdit(edit: RemoteEdit): Promise<void> {
    if (edit.processing || !this.edits.has(fileKey(edit.temporaryPath))) {
      return;
    }
    edit.processing = true;
    try {
      if (!(await fileExists(edit.temporaryPath))) {
        await this.release(edit, false);
        return;
      }
      if ((await fileHash(edit.temporaryPath)) === edit.originalHash) {
        await this.release(edit, false);
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        `VSsh: "${path.posix.basename(edit.remotePath)}"의 변경 내용을 서버에 업로드할까요?`,
        { modal: true },
        '업로드',
        '변경 버리기',
        '다시 열기'
      );
      if (choice === '변경 버리기') {
        await this.release(edit, false);
        return;
      }
      if (choice === '업로드') {
        if (!(await this.confirmRemoteOverwrite(edit))) {
          edit.processing = false;
          await this.reopen(edit);
          return;
        }
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `VSsh: ${path.posix.basename(edit.remotePath)} 업로드 중...`,
            },
            () => uploadAtomically(edit)
          );
          await this.release(edit, false);
          await this.onDidUpload?.();
          vscode.window.showInformationMessage(`VSsh: "${path.posix.basename(edit.remotePath)}"을(를) 업로드했습니다.`);
          return;
        } catch (error) {
          vscode.window.showErrorMessage(
            `VSsh: 업로드하지 못했습니다. 임시 파일을 유지합니다 - ${describe(error)} (${edit.temporaryPath})`
          );
          this.edits.delete(fileKey(edit.temporaryPath));
          return;
        }
      }

      edit.processing = false;
      await this.reopen(edit);
    } finally {
      edit.processing = false;
    }
  }

  private async confirmRemoteOverwrite(edit: RemoteEdit): Promise<boolean> {
    try {
      const current = await edit.session.stat(edit.remotePath);
      if (!remoteFileChanged(edit.originalStat, current)) {
        return true;
      }
      const choice = await vscode.window.showWarningMessage(
        `VSsh: 서버의 "${path.posix.basename(edit.remotePath)}"도 편집 중 변경되었습니다. 서버 파일을 덮어쓸까요?`,
        { modal: true },
        '서버 파일 덮어쓰기'
      );
      return choice === '서버 파일 덮어쓰기';
    } catch (error) {
      const choice = await vscode.window.showWarningMessage(
        `VSsh: 서버 파일 상태를 확인하지 못했습니다 (${describe(error)}). 그래도 업로드를 시도할까요?`,
        { modal: true },
        '업로드 시도'
      );
      return choice === '업로드 시도';
    }
  }

  private async reopen(edit: RemoteEdit): Promise<void> {
    if (edit.openMode === 'external-default' || edit.openMode === 'external-picker') {
      await this.openExternally(edit);
    } else {
      await this.openInVsHoon(edit);
    }
  }

  private async release(edit: RemoteEdit, preserveTemporaryFile: boolean): Promise<void> {
    this.edits.delete(fileKey(edit.temporaryPath));
    if (!preserveTemporaryFile) {
      await fs.promises.rm(edit.temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async removeStaleTemporaryDirectories(): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.temporaryRoot, { withFileTypes: true });
    } catch {
      return;
    }
    const cutoff = Date.now() - STALE_EDIT_AGE_MS;
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('edit-'))
        .map(async (entry) => {
          const candidate = path.join(this.temporaryRoot, entry.name);
          try {
            if ((await fs.promises.stat(candidate)).mtimeMs < cutoff) {
              await fs.promises.rm(candidate, { recursive: true, force: true });
            }
          } catch {
            // 다른 프로세스가 사용하거나 이미 정리한 임시 파일은 다음 시작 때 다시 확인한다.
          }
        })
    );
  }

  private isOpenInVsHoon(temporaryPath: string): boolean {
    const key = fileKey(temporaryPath);
    return vscode.window.tabGroups.all.some((group) =>
      group.tabs.some((tab) => {
        const uri = tabResource(tab);
        return uri?.scheme === 'file' && fileKey(uri.fsPath) === key;
      })
    );
  }
}

async function uploadAtomically(edit: RemoteEdit): Promise<void> {
  const remote = edit.session;
  const directory = path.posix.dirname(edit.remotePath);
  const baseName = path.posix.basename(edit.remotePath);
  const temporaryRemotePath = path.posix.join(directory, `.vssh-${baseName}-${crypto.randomUUID()}.tmp`);
  const backupRemotePath = path.posix.join(directory, `.vssh-${baseName}-${crypto.randomUUID()}.backup`);
  try {
    await remote.upload(edit.temporaryPath, temporaryRemotePath);
    const localStat = await fs.promises.stat(edit.temporaryPath);
    if (edit.originalStat.mode !== undefined && remote.chmod) {
      await remote.chmod(temporaryRemotePath, edit.originalStat.mode).catch(() => undefined);
    }
    if (remote.utimes) {
      await remote.utimes(temporaryRemotePath, localStat.mtimeMs).catch(() => undefined);
    }

    let destinationExists = true;
    try {
      await remote.stat(edit.remotePath);
    } catch {
      destinationExists = false;
    }
    if (!destinationExists) {
      await remote.rename(temporaryRemotePath, edit.remotePath);
      return;
    }

    await remote.rename(edit.remotePath, backupRemotePath);
    try {
      await remote.rename(temporaryRemotePath, edit.remotePath);
    } catch (error) {
      await remote.rename(backupRemotePath, edit.remotePath).catch(() => undefined);
      throw error;
    }
    await remote.unlink(backupRemotePath).catch(() => undefined);
  } catch (error) {
    await remote.unlink(temporaryRemotePath).catch(() => undefined);
    throw error;
  }
}

function tabResource(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (
    input instanceof vscode.TabInputText ||
    input instanceof vscode.TabInputCustom ||
    input instanceof vscode.TabInputNotebook
  ) {
    return input.uri;
  }
  return undefined;
}

function fileKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function fileHash(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function readFileSample(filePath: string, length: number): Promise<Uint8Array> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const sample = Buffer.alloc(length);
    const result = await handle.read(sample, 0, sample.length, 0);
    return sample.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function openWithWindowsPicker(filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', filePath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
