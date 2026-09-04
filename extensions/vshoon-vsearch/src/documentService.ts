import * as vscode from 'vscode';
import { MatchItem, SearchQuery } from './types';
import { EngineConfig, readTextFile, runSearch } from './searchEngine';
import { MAX_LINE_LENGTH, buildMatcher, expandReplacement, findMatches, splitLines } from './matcher';

export interface PreviewPayload {
  content: string;
  matches: MatchItem[];
  readonly: boolean;
  message?: string;
}

function contentMatcher(query: SearchQuery): RegExp | undefined {
  if (query.query.length === 0) {
    return undefined;
  }
  try {
    return buildMatcher(query.query, {
      regex: query.regex,
      caseSensitive: query.caseSensitive,
      wholeWord: query.wholeWord
    });
  } catch {
    return undefined;
  }
}

/** 미리보기 패널에 표시할 파일 내용과 일치 위치를 만든다. */
export async function loadPreview(
  uri: vscode.Uri,
  query: SearchQuery,
  config: EngineConfig
): Promise<PreviewPayload> {
  const maxBytes = config.maxPreviewSizeKb * 1024;
  const text = await readTextFile(uri, maxBytes);
  if (text === null) {
    return {
      content: '',
      matches: [],
      readonly: true,
      message: `미리보기를 표시할 수 없습니다. (바이너리 파일이거나 ${config.maxPreviewSizeKb}KB 를 초과)`
    };
  }
  const matcher = contentMatcher(query);
  const matches = matcher ? findMatches(text, matcher, config.maxMatchesPerFile).matches : [];
  return { content: text, matches, readonly: false };
}

/**
 * 미리보기에서 편집한 내용을 실제 파일에 반영하고 저장한다.
 *
 * baseText(미리보기를 열 때의 내용)를 함께 받아, 그 사이 파일이 밖에서 바뀌었으면
 * 덮어쓰지 않고 예외를 던진다. (git checkout, 다른 편집기 등으로 인한 변경 손실 방지)
 */
export async function savePreview(uri: vscode.Uri, content: string, baseText?: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const current = doc.getText();
  if (baseText !== undefined && current !== baseText && current !== content) {
    throw new Error(
      '이 파일이 다른 곳에서 변경되어 저장하지 않았습니다. 결과를 다시 검색한 뒤 편집해 주세요.'
    );
  }
  if (current === content) {
    if (doc.isDirty) {
      await doc.save();
    }
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(current.length));
  edit.replace(uri, fullRange, content);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    throw new Error('파일을 수정하지 못했습니다.');
  }
  await doc.save();
}

interface PendingEdit {
  line: number;
  column: number;
  length: number;
  newText: string;
}

/**
 * 한 파일 안에서 실제로 바꿔 넣을 위치와 문자열을 계산한다.
 * target 이 주어지면 그 위치의 일치 항목 하나만 대상으로 한다.
 */
function computeEdits(
  text: string,
  matcher: RegExp,
  replacement: string,
  useRegex: boolean,
  limitPerFile: number,
  target?: { line: number; column: number }
): PendingEdit[] {
  const edits: PendingEdit[] = [];
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    if (target && target.line !== i) {
      continue;
    }
    const lineText = lines[i].text;
    if (lineText.length === 0 || lineText.length > MAX_LINE_LENGTH) {
      continue;
    }
    matcher.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = matcher.exec(lineText)) !== null) {
      // 길이 0 매치를 바꾸면 "빈 범위 치환" = 문자 삽입이 되어 버린다. 건너뛴다.
      if (m[0].length === 0) {
        matcher.lastIndex++;
        continue;
      }
      if (!target || target.column === m.index) {
        edits.push({
          line: i,
          column: m.index,
          length: m[0].length,
          newText: useRegex ? expandReplacement(replacement, m) : replacement
        });
        if (target) {
          return edits;
        }
        if (edits.length >= limitPerFile) {
          return edits;
        }
      }
    }
  }
  return edits;
}

export interface ReplaceResult {
  fileCount: number;
  matchCount: number;
}

async function applyFileEdits(
  targets: { uri: vscode.Uri; edits: PendingEdit[] }[],
  save: boolean
): Promise<ReplaceResult> {
  const result: ReplaceResult = { fileCount: 0, matchCount: 0 };
  const CHUNK = 200;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    const edit = new vscode.WorkspaceEdit();
    for (const target of chunk) {
      for (const e of target.edits) {
        edit.replace(
          target.uri,
          new vscode.Range(e.line, e.column, e.line, e.column + e.length),
          e.newText
        );
      }
    }
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      throw new Error('바꾸기를 적용하지 못했습니다.');
    }
    for (const target of chunk) {
      result.fileCount++;
      result.matchCount += target.edits.length;
      if (save) {
        const doc = await vscode.workspace.openTextDocument(target.uri);
        if (doc.isDirty) {
          await doc.save();
        }
      }
    }
  }
  return result;
}

function saveAfterReplace(): boolean {
  return vscode.workspace.getConfiguration('vsearch').get<boolean>('saveAfterReplace', true);
}

/** 일치 항목 하나만 바꾼다. */
export async function replaceOne(
  uri: vscode.Uri,
  query: SearchQuery,
  replacement: string,
  position: { line: number; column: number },
  config: EngineConfig
): Promise<ReplaceResult> {
  const matcher = contentMatcher(query);
  if (!matcher) {
    throw new Error('검색어를 입력해 주세요.');
  }
  const text = await readTextFile(uri, config.maxFileSizeKb * 1024);
  if (text === null) {
    throw new Error('파일을 읽을 수 없습니다.');
  }
  const edits = computeEdits(text, matcher, replacement, query.regex, config.maxMatchesPerFile, position);
  if (edits.length === 0) {
    throw new Error('바꿀 대상을 찾지 못했습니다. 파일이 변경되었을 수 있으니 다시 검색해 주세요.');
  }
  return applyFileEdits([{ uri, edits }], saveAfterReplace());
}

/**
 * 현재 검색 조건에 해당하는 모든 일치 항목을 바꾼다.
 * 파일 목록은 바꾸기 직전에 다시 검색해 최신 상태를 기준으로 한다.
 */
export async function replaceAll(
  query: SearchQuery,
  replacement: string,
  config: EngineConfig,
  token: vscode.CancellationToken
): Promise<ReplaceResult> {
  const matcher = contentMatcher(query);
  if (!matcher) {
    throw new Error('검색어를 입력해 주세요.');
  }

  const uris: vscode.Uri[] = [];
  await runSearch(query, config, token, (files) => {
    for (const f of files) {
      uris.push(vscode.Uri.parse(f.uri));
    }
  });

  const targets: { uri: vscode.Uri; edits: PendingEdit[] }[] = [];
  for (const uri of uris) {
    if (token.isCancellationRequested) {
      break;
    }
    const text = await readTextFile(uri, config.maxFileSizeKb * 1024);
    if (text === null) {
      continue;
    }
    const local = new RegExp(matcher.source, matcher.flags);
    const edits = computeEdits(text, local, replacement, query.regex, config.maxMatchesPerFile);
    if (edits.length > 0) {
      targets.push({ uri, edits });
    }
  }
  return applyFileEdits(targets, saveAfterReplace());
}

/** 저장 후 미리보기의 일치 위치를 다시 계산한다. */
export function recomputeMatches(text: string, query: SearchQuery, config: EngineConfig): MatchItem[] {
  const matcher = contentMatcher(query);
  return matcher ? findMatches(text, matcher, config.maxMatchesPerFile).matches : [];
}
