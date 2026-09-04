/**
 * 확장(Extension Host)과 웹뷰(Webview) 사이에서 주고받는 데이터 형식 정의.
 * 양쪽에서 동일한 형태를 사용하기 위해 이 파일 하나로 관리한다.
 */

/** 검색 범위: 워크스페이스 전체 / 지정 디렉터리 */
export type ScopeKind = 'workspace' | 'directory';

export interface SearchQuery {
  /** 검색 요청 식별자(취소/경합 처리에 사용) */
  id: number;
  /** 검색어 */
  query: string;
  /** 대소문자 구분 */
  caseSensitive: boolean;
  /** 단어 단위 일치 */
  wholeWord: boolean;
  /** 정규식 사용 */
  regex: boolean;
  /** 검색 범위 종류 */
  scopeKind: ScopeKind;
  /** scopeKind 가 directory 일 때의 디렉터리 절대 경로 */
  scopePath: string;
  /** 지정 디렉터리의 하위 디렉터리까지 포함할지 여부 */
  recursive: boolean;
  /** 파일 마스크 (예: "*.ts, *.java") */
  fileMask: string;
}

/** 한 줄에서 발견된 일치 항목 */
export interface MatchItem {
  /** 0-based 라인 번호 */
  line: number;
  /** 0-based 컬럼(문자 인덱스) */
  column: number;
  /** 일치한 문자열 길이 */
  length: number;
  /** 결과 목록에 표시할 라인 텍스트(길면 잘라낸다) */
  preview: string;
  /** preview 문자열 안에서의 일치 시작 위치 */
  previewColumn: number;
}

/** 파일 단위 검색 결과 */
export interface FileResult {
  /** vscode.Uri.toString() 결과 */
  uri: string;
  /** OS 경로 */
  fsPath: string;
  /** 워크스페이스 기준 상대 경로 */
  relPath: string;
  /** 상대 경로의 디렉터리 부분 */
  dir: string;
  /** 파일 이름 */
  name: string;
  matches: MatchItem[];
  /** maxMatchesPerFile 로 잘렸는지 여부 */
  truncated: boolean;
}

/** 웹뷰 → 확장 메시지 */
export type ToExtensionMessage =
  | { type: 'ready' }
  | { type: 'search'; query: SearchQuery }
  | { type: 'cancel' }
  | { type: 'pickFolder' }
  | { type: 'requestPreview'; uri: string; query: SearchQuery }
  | { type: 'savePreview'; uri: string; content: string; baseText?: string; query: SearchQuery }
  | { type: 'openInEditor'; items: { uri: string; line: number; column: number; length: number }[] }
  | { type: 'replaceOne'; uri: string; line: number; column: number; replacement: string; query: SearchQuery }
  | { type: 'replaceAll'; replacement: string; query: SearchQuery }
  | { type: 'persist'; state: unknown }
  | { type: 'close' }
  | { type: 'log'; message: string };

/** 확장 → 웹뷰 메시지 */
export type ToWebviewMessage =
  | { type: 'init'; workspaceFolders: { name: string; path: string }[]; state: unknown; config: WebviewConfig }
  | { type: 'searchStarted'; id: number }
  | { type: 'results'; id: number; files: FileResult[] }
  | {
      type: 'searchDone';
      id: number;
      fileCount: number;
      matchCount: number;
      elapsedMs: number;
      cancelled: boolean;
      truncated: boolean;
    }
  | { type: 'searchError'; id: number; message: string }
  | { type: 'preview'; uri: string; content: string; matches: MatchItem[]; readonly: boolean; message?: string }
  | { type: 'previewSaved'; uri: string; matches: MatchItem[] }
  | { type: 'folderPicked'; path: string }
  | { type: 'replaceDone'; fileCount: number; matchCount: number }
  | { type: 'focus'; target: 'search' | 'replace' }
  | { type: 'presetScope'; scopePath: string }
  | { type: 'presetQuery'; query: string }
  | { type: 'info'; message: string }
  | { type: 'error'; message: string };

export interface WebviewConfig {
  autoSearch: boolean;
}
