/* global acquireVsCodeApi */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /* ------------------------------------------------------------------ *
   * DOM 참조
   * ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);
  const el = {
    query: $('query'),
    optCase: $('optCase'),
    optWord: $('optWord'),
    optRegex: $('optRegex'),
    optReplace: $('optReplace'),
    replacement: $('replacement'),
    btnReplaceOne: $('btnReplaceOne'),
    btnReplaceAll: $('btnReplaceAll'),
    btnClear: $('btnClear'),
    btnHistory: $('btnHistory'),
    btnMaskHistory: $('btnMaskHistory'),
    btnReplaceHistory: $('btnReplaceHistory'),
    historyPopup: $('historyPopup'),
    optDirectory: $('optDirectory'),
    dirGroup: $('dirGroup'),
    scopePath: $('scopePath'),
    btnPickFolder: $('btnPickFolder'),
    recursive: $('recursive'),
    fileMask: $('fileMask'),
    status: $('status'),
    content: $('content'),
    results: $('results'),
    splitter: $('splitter'),
    replaceRow: $('replaceRow'),
    previewPath: $('previewPath'),
    previewDirty: $('previewDirty'),
    btnFind: $('btnFind'),
    btnOpenEditor: $('btnOpenEditor'),
    editorWrap: $('editorWrap'),
    previewMessage: $('previewMessage')
  };

  /* ------------------------------------------------------------------ *
   * 상태
   * ------------------------------------------------------------------ */
  const state = {
    query: '',
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    scopeKind: 'workspace',
    scopePath: '',
    recursive: true,
    fileMask: '',
    replaceOpen: false,
    replacement: '',
    /** 최근 검색어 / 파일 마스크 / 바꿀 내용 (최신순, 최대 HISTORY_MAX 개) */
    queryHistory: [],
    maskHistory: [],
    replaceHistory: [],
    /** 0 이면 "자동" — 창 높이의 일정 비율을 쓴다. 스플리터를 드래그하면 실제 px 이 들어간다. */
    resultsHeight: 0
  };

  const HISTORY_MAX = 15;

  let config = { autoSearch: true };
  let searchSeq = 0;
  let activeSearchId = -1;
  let searching = false;

  /** @type {any[]} */
  let files = [];
  /** @type {{fileIndex:number, matchIndex:number}[]} */
  let rows = [];
  /** @type {HTMLElement[]} */
  let rowEls = [];
  /** 마지막으로 고른 행(미리보기 기준이자 범위 선택의 기준점) */
  let selected = -1;
  /** 다중 선택된 행 번호 */
  let selectedSet = new Set();

  const MAX_ROW_ELEMENTS = 20000;
  let rowLimitReached = false;

  const preview = {
    uri: null,
    /** 검색어와 일치하는 위치들 (Monaco Range) */
    matches: [],
    current: -1,
    dirty: false,
    readonly: false,
    /** 모델을 붙인 뒤 이동할 위치 */
    pendingTarget: null
  };

  /** 바꾸기 직후 한 번만 상태줄에 덧붙일 안내 */
  let replaceNote = '';

  let searchTimer = null;
  let persistTimer = null;
  let previewTimer = null;

  /* ------------------------------------------------------------------ *
   * 유틸
   * ------------------------------------------------------------------ */
  function escapeHtml(text) {
    return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function setStatus(text, isError) {
    el.status.textContent = text;
    el.status.classList.toggle('error', Boolean(isError));
  }

  /* ------------------------------------------------------------------ *
   * UI ↔ 상태 동기화
   * ------------------------------------------------------------------ */
  function readUi() {
    state.query = el.query.value;
    state.replacement = el.replacement.value;
    state.scopePath = el.scopePath.value;
    state.recursive = el.recursive.checked;
    state.fileMask = el.fileMask.value;
  }

  function writeUi() {
    el.query.value = state.query;
    el.replacement.value = state.replacement;
    el.scopePath.value = state.scopePath;
    el.recursive.checked = state.recursive;
    el.fileMask.value = state.fileMask;
    el.optCase.classList.toggle('active', state.caseSensitive);
    el.optWord.classList.toggle('active', state.wholeWord);
    el.optRegex.classList.toggle('active', state.regex);
    el.optReplace.classList.toggle('active', state.replaceOpen);
    el.optDirectory.classList.toggle('active', state.scopeKind === 'directory');
    applyResultsHeight();
    updateEnabledState();
  }

  const MIN_RESULTS_HEIGHT = 60;
  const MIN_PREVIEW_HEIGHT = 80;

  /**
   * 결과 목록 높이를 적용한다. 사용자가 직접 조절하지 않았으면(resultsHeight === 0)
   * 결과/미리보기 영역의 실제 높이를 기준으로 비율을 잡는다.
   */
  function applyResultsHeight() {
    const available = el.content.clientHeight;
    if (available <= 0) {
      return; // 아직 레이아웃이 잡히기 전
    }
    const splitter = el.splitter.offsetHeight || 7;
    const max = Math.max(MIN_RESULTS_HEIGHT, available - splitter - MIN_PREVIEW_HEIGHT);
    const wanted = state.resultsHeight > 0 ? state.resultsHeight : Math.round(available * 0.45);
    el.results.style.height = Math.round(Math.max(MIN_RESULTS_HEIGHT, Math.min(wanted, max))) + 'px';
  }

  window.addEventListener('resize', applyResultsHeight);

  function updateEnabledState() {
    // 디렉터리 범위를 골랐을 때만 경로 행이 보인다.
    el.dirGroup.hidden = state.scopeKind !== 'directory';
    // 바꾸기 버튼을 켰을 때만 바꾸기 행이 펼쳐진다. (hidden 이 아니라 클래스로 여닫아야 전환이 걸린다)
    el.replaceRow.classList.toggle('open', state.replaceOpen);
    el.btnClear.hidden = el.query.value.length === 0;

    el.btnReplaceAll.disabled = !state.query;
    el.btnReplaceOne.disabled = !state.query || selected < 0 || !rows[selected];

    el.btnOpenEditor.disabled = !preview.uri && selectedSet.size === 0;
    el.btnOpenEditor.textContent =
      selectedSet.size > 1 ? '열기 (' + selectedSet.size + ')' : '열기';
  }

  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => post({ type: 'persist', state: state }), 400);
  }

  /* ------------------------------------------------------------------ *
   * 검색
   * ------------------------------------------------------------------ */
  function buildQuery(id) {
    return {
      id: id,
      query: state.query,
      caseSensitive: state.caseSensitive,
      wholeWord: state.wholeWord,
      regex: state.regex,
      scopeKind: state.scopeKind,
      scopePath: state.scopePath,
      recursive: state.recursive,
      fileMask: state.fileMask
    };
  }

  function currentQuery() {
    return buildQuery(activeSearchId);
  }

  function clearResults() {
    files = [];
    rows = [];
    rowEls = [];
    selected = -1;
    selectedSet = new Set();
    rowLimitReached = false;
    el.results.textContent = '';
  }

  function startSearch() {
    readUi();
    persist();
    if (!state.query) {
      clearResults();
      setStatus('검색어를 입력하세요.');
      searching = false;
      updateEnabledState();
      return;
    }
    activeSearchId = ++searchSeq;
    clearResults();
    searching = true;
    setStatus('검색 중…');
    updateEnabledState();
    post({ type: 'search', query: buildQuery(activeSearchId) });
  }

  function scheduleSearch() {
    readUi();
    persist();
    updateEnabledState();
    if (!config.autoSearch) {
      return;
    }
    clearTimeout(searchTimer);
    searchTimer = setTimeout(startSearch, 300);
  }

  /* ------------------------------------------------------------------ *
   * 결과 렌더링
   * ------------------------------------------------------------------ */
  function highlightedText(text, column, length) {
    if (column < 0 || length <= 0) {
      return escapeHtml(text);
    }
    return (
      escapeHtml(text.slice(0, column)) +
      '<mark>' +
      escapeHtml(text.slice(column, column + length)) +
      '</mark>' +
      escapeHtml(text.slice(column + length))
    );
  }

  /**
   * 결과를 평면 목록으로 그린다. (IntelliJ 와 같은 방식)
   * 한 줄 = 일치 한 건. 왼쪽에 해당 줄 내용, 오른쪽 끝에 파일명과 줄 번호.
   */
  function appendFiles(newFiles) {
    const frag = document.createDocumentFragment();
    for (const file of newFiles) {
      const fileIndex = files.length;
      files.push(file);

      for (let mi = 0; mi < file.matches.length; mi++) {
        if (rowEls.length >= MAX_ROW_ELEMENTS) {
          rowLimitReached = true;
          break;
        }
        const m = file.matches[mi];
        const rowEl = document.createElement('div');
        rowEl.className = 'match-row';
        rowEl.dataset.row = String(rows.length);
        rows.push({ fileIndex: fileIndex, matchIndex: mi });
        rowEls.push(rowEl);

        const lineText = document.createElement('span');
        lineText.className = 'line-text';
        lineText.innerHTML = highlightedText(m.preview, m.previewColumn, m.length);

        const fileName = document.createElement('span');
        fileName.className = 'file-name';
        fileName.textContent = file.name;
        fileName.title = file.relPath;

        const lineNo = document.createElement('span');
        lineNo.className = 'line-no';
        lineNo.textContent = String(m.line + 1);

        rowEl.appendChild(lineText);
        rowEl.appendChild(fileName);
        rowEl.appendChild(lineNo);
        frag.appendChild(rowEl);
      }
    }
    el.results.appendChild(frag);
  }

  /** 선택 표시를 갱신한다. 바뀐 행만 건드려서 결과가 많아도 느려지지 않게 한다. */
  function applySelection(next) {
    selectedSet.forEach((i) => {
      if (!next.has(i) && rowEls[i]) {
        rowEls[i].classList.remove('selected');
      }
    });
    next.forEach((i) => {
      if (rowEls[i]) {
        rowEls[i].classList.add('selected');
      }
    });
    selectedSet = next;
  }

  /**
   * 행을 고른다.
   * options.additive  : Ctrl+클릭 — 개별 토글
   * options.range     : Shift+클릭 — 기준점부터 범위 선택
   */
  function selectRow(index, options) {
    options = options || {};
    if (index < 0 || index >= rows.length) {
      return;
    }

    if (options.range && selected >= 0) {
      const from = Math.min(selected, index);
      const to = Math.max(selected, index);
      const next = new Set(selectedSet);
      for (let i = from; i <= to; i++) {
        next.add(i);
      }
      applySelection(next);
    } else if (options.additive) {
      const next = new Set(selectedSet);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      applySelection(next);
    } else {
      applySelection(new Set([index]));
    }

    selected = index;
    const rowEl = rowEls[selected];
    if (rowEl && !options.noScroll) {
      rowEl.scrollIntoView({ block: 'nearest' });
    }
    updateEnabledState();

    const row = rows[selected];
    const file = files[row.fileIndex];
    openPreview(file, file.matches[row.matchIndex]);
  }

  function moveSelection(delta, extend) {
    if (rows.length === 0) {
      return;
    }
    let next = selected + delta;
    if (next < 0) {
      next = 0;
    }
    if (next >= rows.length) {
      next = rows.length - 1;
    }
    if (extend) {
      // Shift+방향키 — 기준점을 유지한 채 범위를 넓힌다.
      const anchor = selected;
      selectRow(next, { range: true });
      selected = anchor;
      const rowEl = rowEls[next];
      if (rowEl) {
        rowEl.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    selectRow(next);
  }

  /* ------------------------------------------------------------------ *
   * 미리보기 (Monaco 에디터)
   *
   * VS Code 가 쓰는 것과 같은 편집기라 문법 강조·괄호 매칭·미니맵·내장 찾기(Ctrl+F)를
   * 그대로 얻는다. 파일마다 모델을 만들어 두므로 다른 파일을 봤다 돌아와도 편집 내용이 남는다.
   * ------------------------------------------------------------------ */
  const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

  let monacoApi = null;
  let editor = null;
  let monacoReady = false;
  let matchDecorations = null;
  /** uri -> ITextModel (최근 사용 순서를 유지해 오래된 것부터 정리한다) */
  const models = new Map();
  /** uri -> 마지막으로 저장한 시점의 버전 (수정 여부 판단용) */
  const savedVersions = new Map();
  /** uri -> 미리보기를 열 때의 원본 내용 (저장 시 외부 변경을 감지하는 데 쓴다) */
  const baseTexts = new Map();
  /** 메모리를 위해 유지할 최대 모델 수. 넘으면 수정하지 않은 것부터 버린다. */
  const MAX_MODELS = 30;
  /** Monaco 로드가 끝나기 전에 고른 파일 */
  let pendingPreview = null;

  function monacoTheme() {
    const cls = document.body.className || '';
    if (cls.indexOf('vscode-high-contrast-light') >= 0) {
      return 'hc-light';
    }
    if (cls.indexOf('vscode-high-contrast') >= 0) {
      return 'hc-black';
    }
    return cls.indexOf('vscode-light') >= 0 ? 'vs' : 'vs-dark';
  }

  /** 파일 확장자로 언어를 고른다. 모르면 일반 텍스트. */
  function languageFor(filePath) {
    const name = String(filePath).split(/[\\/]/).pop() || '';
    const dot = name.lastIndexOf('.');
    if (dot <= 0) {
      return 'plaintext';
    }
    const ext = name.slice(dot).toLowerCase();
    const languages = monacoApi.languages.getLanguages();
    for (const language of languages) {
      if (language.extensions && language.extensions.some((e) => String(e).toLowerCase() === ext)) {
        return language.id;
      }
    }
    return 'plaintext';
  }

  function initMonaco() {
    const styles = getComputedStyle(document.body);
    const fontFamily = styles.getPropertyValue('--vscode-editor-font-family').trim();
    const fontSize = parseInt(styles.getPropertyValue('--vscode-editor-font-size'), 10);

    /* global require */
    require.config({ paths: { vs: window.__vsearchMonacoBase } });
    require(['vs/editor/editor.main'], function () {
      monacoApi = window.monaco;
      editor = monacoApi.editor.create(el.editorWrap, {
        value: '',
        language: 'plaintext',
        theme: monacoTheme(),
        automaticLayout: true,
        scrollBeyondLastLine: false,
        fontFamily: fontFamily || undefined,
        fontSize: isNaN(fontSize) ? undefined : fontSize,
        minimap: { enabled: false },
        renderWhitespace: 'selection',
        renderLineHighlight: 'line',
        smoothScrolling: true,
        fixedOverflowWidgets: true
      });
      matchDecorations = editor.createDecorationsCollection();
      monacoReady = true;

      // Ctrl+S 는 에디터가 키를 먼저 먹으므로 Monaco 명령으로 등록한다.
      editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, savePreviewFile);

      // VS Code 테마가 바뀌면 body 클래스가 바뀐다.
      new MutationObserver(() => monacoApi.editor.setTheme(monacoTheme())).observe(document.body, {
        attributes: true,
        attributeFilter: ['class']
      });

      if (pendingPreview) {
        const next = pendingPreview;
        pendingPreview = null;
        openPreview(next.file, next.match);
      }
    });
  }

  /** 전체 검색어 기준으로 강조할 문자열 (미리보기 강조는 전체 검색 조건을 따른다) */
  function highlightQuery() {
    return state.query || '';
  }

  function refreshDecorations() {
    if (!matchDecorations) {
      return;
    }
    matchDecorations.set(
      preview.matches.map((range, index) => ({
        range: range,
        options: {
          className: index === preview.current ? 'vs-match-current' : 'vs-match',
          stickiness: 1
        }
      }))
    );
  }

  /** 현재 모델에서 검색어와 일치하는 곳을 찾아 강조한다. */
  function highlightMatches() {
    if (!monacoReady || !editor) {
      return;
    }
    const model = editor.getModel();
    const query = highlightQuery();
    preview.matches = [];
    preview.current = -1;
    if (model && query) {
      const found = model.findMatches(
        query,
        null,
        state.regex,
        state.caseSensitive,
        state.wholeWord ? WORD_SEPARATORS : null,
        false,
        5000
      );
      preview.matches = found.map((item) => item.range);
      if (preview.matches.length > 0) {
        preview.current = 0;
      }
    }
    refreshDecorations();
  }

  function revealAt(line, column) {
    if (!editor) {
      return;
    }
    const position = { lineNumber: Math.max(1, line), column: Math.max(1, column) };
    editor.setPosition(position);
    editor.revealPositionInCenterIfOutsideViewport(position);
    // 그 위치와 가장 가까운 일치 항목을 현재 항목으로 삼는다.
    let best = -1;
    let bestDelta = Infinity;
    preview.matches.forEach((range, index) => {
      const delta = Math.abs(range.startLineNumber - position.lineNumber);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = index;
      }
    });
    preview.current = best;
    refreshDecorations();
  }

  function updateDirty() {
    const model = preview.uri ? models.get(preview.uri) : null;
    const dirty = Boolean(model) && savedVersions.get(preview.uri) !== model.getAlternativeVersionId();
    preview.dirty = dirty;
    el.previewDirty.hidden = !dirty;
    updateEnabledState();
  }

  function hasUnsavedPreview() {
    for (const [uri, model] of models) {
      if (savedVersions.get(uri) !== model.getAlternativeVersionId()) {
        return true;
      }
    }
    return false;
  }

  function disposeModels() {
    models.forEach((model) => model.dispose());
    models.clear();
    savedVersions.clear();
    baseTexts.clear();
    if (editor) {
      editor.setModel(null);
    }
    preview.uri = null;
    preview.matches = [];
    preview.current = -1;
    el.previewDirty.hidden = true;
  }

  /**
   * 파일별 모델을 만들어 둔다.
   * 이미 있으면 그대로 쓴다 — 다른 파일을 봤다 돌아와도 편집하던 내용이 남는다.
   */
  function ensureModel(uri, content) {
    let model = models.get(uri);
    if (!model) {
      model = monacoApi.editor.createModel(content, languageFor(uri));
      models.set(uri, model);
      savedVersions.set(uri, model.getAlternativeVersionId());
      baseTexts.set(uri, content);
      model.onDidChangeContent(() => {
        if (preview.uri === uri) {
          updateDirty();
        }
      });
      pruneModels();
    } else {
      // 최근 사용으로 올린다 (Map 은 넣은 순서를 유지한다)
      models.delete(uri);
      models.set(uri, model);
    }
    return model;
  }

  /** 오래 안 쓴 모델부터 버린다. 수정 중이거나 지금 보고 있는 파일은 남긴다. */
  function pruneModels() {
    if (models.size <= MAX_MODELS) {
      return;
    }
    for (const [uri, model] of models) {
      if (models.size <= MAX_MODELS) {
        break;
      }
      const unsaved = savedVersions.get(uri) !== model.getAlternativeVersionId();
      if (uri === preview.uri || unsaved) {
        continue;
      }
      model.dispose();
      models.delete(uri);
      savedVersions.delete(uri);
      baseTexts.delete(uri);
    }
  }

  function attachModel(uri, model) {
    editor.setModel(model);
    editor.updateOptions({ readOnly: preview.readonly });
    highlightMatches();
    if (preview.pendingTarget) {
      revealAt(preview.pendingTarget.line, preview.pendingTarget.column);
      preview.pendingTarget = null;
    }
    updateDirty();
  }

  function openPreview(file, match) {
    if (!file) {
      return;
    }
    el.previewPath.textContent = file.relPath;
    el.previewPath.title = file.fsPath;

    // Monaco 는 1부터 세고, 검색 결과는 0부터 센다.
    const target = { line: (match ? match.line : 0) + 1, column: (match ? match.column : 0) + 1 };

    if (!monacoReady) {
      pendingPreview = { file: file, match: match };
      return;
    }

    if (preview.uri === file.uri) {
      revealAt(target.line, target.column);
      return;
    }

    preview.uri = file.uri;
    preview.readonly = false;
    preview.pendingTarget = target;
    el.previewMessage.hidden = true;

    const cached = models.get(file.uri);
    if (cached) {
      attachModel(file.uri, cached);
      return;
    }

    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      post({ type: 'requestPreview', uri: file.uri, query: currentQuery() });
    }, 40);
    updateEnabledState();
  }

  function savePreviewFile() {
    if (!preview.uri || preview.readonly) {
      return;
    }
    const model = models.get(preview.uri);
    if (!model || savedVersions.get(preview.uri) === model.getAlternativeVersionId()) {
      return;
    }
    // Monaco 모델은 원본 줄바꿈(CRLF/LF)을 그대로 유지하므로 따로 되돌릴 필요가 없다.
    post({
      type: 'savePreview',
      uri: preview.uri,
      content: model.getValue(),
      baseText: baseTexts.get(preview.uri),
      query: currentQuery()
    });
  }

  /**
   * 선택한 항목을 실제 편집기에서 연다.
   * 여러 행을 골랐으면 전부 열되, 같은 파일은 한 번만 연다.
   */
  function openInEditor() {
    const items = [];
    const seen = new Set();

    if (selectedSet.size > 1) {
      const indices = [...selectedSet].sort((a, b) => a - b);
      for (const index of indices) {
        const row = rows[index];
        if (!row) {
          continue;
        }
        const file = files[row.fileIndex];
        if (seen.has(file.uri)) {
          continue;
        }
        seen.add(file.uri);
        const match = file.matches[row.matchIndex];
        items.push({
          uri: file.uri,
          line: match ? match.line : 0,
          column: match ? match.column : 0,
          length: match ? match.length : 0
        });
      }
    } else if (preview.uri) {
      const range = preview.matches[preview.current];
      items.push({
        uri: preview.uri,
        line: range ? range.startLineNumber - 1 : 0,
        column: range ? range.startColumn - 1 : 0,
        length: range ? range.endColumn - range.startColumn : 0
      });
    }

    if (items.length > 0) {
      post({ type: 'openInEditor', items: items });
    }
  }

  /* ------------------------------------------------------------------ *
   * 이벤트 바인딩
   * ------------------------------------------------------------------ */
  /** 폴더 버튼 — 프로젝트 전체 ↔ 지정 디렉터리 전환 */
  function toggleDirectoryScope() {
    state.scopeKind = state.scopeKind === 'directory' ? 'workspace' : 'directory';
    writeUi();
    applyResultsHeight();
    if (state.scopeKind === 'directory' && !state.scopePath) {
      // 경로가 비어 있으면 바로 폴더 선택 창을 띄운다.
      post({ type: 'pickFolder' });
      return;
    }
    scheduleSearch();
  }

  el.optDirectory.addEventListener('click', toggleDirectoryScope);

  el.btnClear.addEventListener('click', () => {
    el.query.value = '';
    el.query.focus();
    startSearch();
  });

  /* ------------------------------------------------------------------ *
   * 최근 검색어 / 최근 파일 마스크
   * ------------------------------------------------------------------ */
  let historyTarget = null;
  let historyAnchor = null;

  function pushHistory(list, value) {
    const text = (value || '').trim();
    if (!text) {
      return;
    }
    const at = list.indexOf(text);
    if (at >= 0) {
      list.splice(at, 1);
    }
    list.unshift(text);
    if (list.length > HISTORY_MAX) {
      list.length = HISTORY_MAX;
    }
    persist();
  }

  function closeHistory() {
    historyTarget = null;
    historyAnchor = null;
    el.historyPopup.hidden = true;
    el.historyPopup.textContent = '';
  }

  function historyList(target) {
    if (target === 'mask') {
      return state.maskHistory;
    }
    if (target === 'replace') {
      return state.replaceHistory;
    }
    return state.queryHistory;
  }

  function historyLabel(target) {
    if (target === 'mask') {
      return '최근 사용한 파일 마스크가';
    }
    if (target === 'replace') {
      return '최근 바꿀 내용이';
    }
    return '최근 검색어가';
  }

  function applyHistory(value) {
    const target = historyTarget;
    closeHistory();
    if (target === 'mask') {
      el.fileMask.value = value;
      startSearch();
    } else if (target === 'replace') {
      el.replacement.value = value;
      readUi();
      updateEnabledState();
      el.replacement.focus();
    } else {
      el.query.value = value;
      startSearch();
    }
  }

  /** 기록에서 항목 하나를 지우고 목록을 다시 그린다. */
  function removeHistory(value) {
    const target = historyTarget;
    const anchor = historyAnchor;
    const list = historyList(target);
    const at = list.indexOf(value);
    if (at >= 0) {
      list.splice(at, 1);
      persist();
    }
    closeHistory();
    if (list.length > 0 && anchor) {
      openHistory(target, anchor);
    }
  }

  function openHistory(target, anchor) {
    const list = historyList(target);
    if (!list || list.length === 0) {
      closeHistory();
      setStatus(historyLabel(target) + ' 없습니다.');
      return;
    }
    historyTarget = target;
    historyAnchor = anchor;
    el.historyPopup.textContent = '';
    list.forEach((value) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.title = value;

      const text = document.createElement('span');
      text.className = 'history-text';
      text.textContent = value;

      const del = document.createElement('button');
      del.className = 'history-del';
      del.textContent = '✕';
      del.title = '기록에서 지우기';
      del.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeHistory(value);
      });

      item.appendChild(text);
      item.appendChild(del);
      // mousedown 으로 처리해야 입력창의 blur 보다 먼저 반응한다.
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        applyHistory(value);
      });
      el.historyPopup.appendChild(item);
    });
    const rect = anchor.getBoundingClientRect();
    el.historyPopup.hidden = false;
    el.historyPopup.style.top = rect.bottom + 2 + 'px';
    // 팝업이 창 오른쪽 밖으로 나가지 않게 맞춘다.
    const width = el.historyPopup.offsetWidth;
    el.historyPopup.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';
  }

  el.btnHistory.addEventListener('click', (event) => {
    event.stopPropagation();
    if (historyTarget === 'query') {
      closeHistory();
    } else {
      openHistory('query', el.btnHistory);
    }
  });

  el.btnMaskHistory.addEventListener('click', (event) => {
    event.stopPropagation();
    if (historyTarget === 'mask') {
      closeHistory();
    } else {
      openHistory('mask', el.btnMaskHistory);
    }
  });

  el.btnReplaceHistory.addEventListener('click', (event) => {
    event.stopPropagation();
    if (historyTarget === 'replace') {
      closeHistory();
    } else {
      openHistory('replace', el.btnReplaceHistory);
    }
  });

  document.addEventListener('click', () => {
    if (historyTarget) {
      closeHistory();
    }
  });

  // 입력이 확정되는 시점(포커스가 빠질 때)에 기록한다. 타이핑 중간값은 남기지 않는다.
  el.query.addEventListener('blur', () => pushHistory(state.queryHistory, el.query.value));
  el.fileMask.addEventListener('blur', () => pushHistory(state.maskHistory, el.fileMask.value));
  el.replacement.addEventListener('blur', () => pushHistory(state.replaceHistory, el.replacement.value));

  function toggleOption(key, button) {
    state[key] = !state[key];
    button.classList.toggle('active', state[key]);
    scheduleSearch();
  }

  el.optCase.addEventListener('click', () => toggleOption('caseSensitive', el.optCase));
  el.optWord.addEventListener('click', () => toggleOption('wholeWord', el.optWord));
  el.optRegex.addEventListener('click', () => toggleOption('regex', el.optRegex));

  [el.query, el.fileMask].forEach((input) => {
    input.addEventListener('input', scheduleSearch);
  });
  el.scopePath.addEventListener('input', scheduleSearch);
  el.recursive.addEventListener('change', () => {
    readUi();
    startSearch();
  });
  el.replacement.addEventListener('input', () => {
    readUi();
    persist();
    updateEnabledState();
  });

  /** 바꾸기 행을 열고 닫는다. (정규식 등 다른 옵션 버튼과 같은 방식) */
  function toggleReplaceRow() {
    state.replaceOpen = !state.replaceOpen;
    el.optReplace.classList.toggle('active', state.replaceOpen);
    updateEnabledState();
    // 바꾸기 행이 생기거나 사라지면 아래 영역 높이가 달라지므로 다시 계산한다.
    applyResultsHeight();
    if (state.replaceOpen) {
      el.replacement.focus();
    }
    persist();
  }

  el.optReplace.addEventListener('click', toggleReplaceRow);

  /** Esc 로 검색 창을 닫는다. */
  function closePanel() {
    if (hasUnsavedPreview()) {
      setStatus('저장하지 않은 미리보기 편집이 있습니다. Ctrl+S 로 저장하거나 다시 Esc 를 눌러 닫으세요.', true);
      savedVersions.forEach((_v, uri) => {
        const model = models.get(uri);
        if (model) {
          savedVersions.set(uri, model.getAlternativeVersionId());
        }
      });
      return;
    }
    post({ type: 'close' });
  }

  el.btnPickFolder.addEventListener('click', () => post({ type: 'pickFolder' }));

  el.btnReplaceAll.addEventListener('click', () => {
    readUi();
    if (!state.query) {
      return;
    }
    post({ type: 'replaceAll', replacement: state.replacement, query: buildQuery(activeSearchId) });
  });

  el.btnReplaceOne.addEventListener('click', () => {
    readUi();
    const row = rows[selected];
    if (!row) {
      return;
    }
    const file = files[row.fileIndex];
    const match = file.matches[row.matchIndex];
    post({
      type: 'replaceOne',
      uri: file.uri,
      line: match.line,
      column: match.column,
      replacement: state.replacement,
      query: buildQuery(activeSearchId)
    });
  });

  /* 미리보기 찾기는 Monaco 내장 찾기 위젯(Ctrl+F)을 그대로 쓴다. */
  function openFind() {
    if (editor) {
      editor.focus();
      editor.getAction('actions.find').run();
    }
  }

  el.btnFind.addEventListener('click', openFind);


  el.btnOpenEditor.addEventListener('click', openInEditor);

  el.results.addEventListener('click', (event) => {
    const target = event.target.closest('[data-row]');
    if (target) {
      selectRow(parseInt(target.dataset.row, 10), {
        additive: event.ctrlKey || event.metaKey,
        range: event.shiftKey
      });
      el.results.focus();
    }
  });

  el.results.addEventListener('dblclick', (event) => {
    const target = event.target.closest('[data-row]');
    if (target) {
      selectRow(parseInt(target.dataset.row, 10));
      openInEditor();
    }
  });

  el.results.addEventListener('keydown', (event) => {
    if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const all = new Set();
      for (let i = 0; i < rows.length; i++) {
        all.add(i);
      }
      applySelection(all);
      updateEnabledState();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1, event.shiftKey);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1, event.shiftKey);
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      moveSelection(10, event.shiftKey);
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      moveSelection(-10, event.shiftKey);
    } else if (event.key === 'Home') {
      event.preventDefault();
      selectRow(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      selectRow(rows.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openInEditor();
    }
  });

  el.query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      pushHistory(state.queryHistory, el.query.value);
      startSearch();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      el.results.focus();
      if (selected < 0) {
        selectRow(0);
      } else {
        moveSelection(1);
      }
    }
  });

  el.replacement.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      pushHistory(state.replaceHistory, el.replacement.value);
      el.btnReplaceAll.click();
    }
  });

  document.addEventListener('keydown', (event) => {
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === 's') {
      event.preventDefault();
      savePreviewFile();
      return;
    }
    if (ctrl && event.key === 'Enter') {
      event.preventDefault();
      openInEditor();
      return;
    }
    if (ctrl && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      // 미리보기 안에 있으면 Monaco 내장 찾기, 그 외에는 전체 검색어 입력칸으로.
      if (editor && el.editorWrap.contains(document.activeElement)) {
        openFind();
      } else {
        el.query.focus();
        el.query.select();
      }
      return;
    }
    if (event.altKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      toggleOption('caseSensitive', el.optCase);
      return;
    }
    if (event.altKey && event.key.toLowerCase() === 'w') {
      event.preventDefault();
      toggleOption('wholeWord', el.optWord);
      return;
    }
    if (event.altKey && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      toggleOption('regex', el.optRegex);
      return;
    }
    if (event.altKey && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      toggleReplaceRow();
      return;
    }
    if (event.altKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      toggleDirectoryScope();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (historyTarget) {
        closeHistory();
      } else if (searching) {
        post({ type: 'cancel' });
      } else {
        closePanel();
      }
    }
  });

  /* 결과 / 미리보기 크기 조절
   *
   * 포인터를 캡처해서 드래그하는 동안 커서가 미리보기나 창 밖으로 나가도 이벤트를 계속 받는다.
   * 높이는 "드래그 시작 시점의 높이 + 이동한 거리"로 계산한다.
   * (마우스 위치를 그대로 높이로 쓰면 스플리터를 잡은 지점만큼 화면이 튄다) */
  let dragState = null;

  el.splitter.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragState = { startY: event.clientY, startHeight: el.results.offsetHeight };
    document.body.classList.add('dragging');
    try {
      el.splitter.setPointerCapture(event.pointerId);
    } catch (e) {
      /* 캡처를 못 해도 드래그 자체는 동작한다 */
    }
  });

  // 포인터를 캡처하면 이벤트 타깃이 스플리터로 고정되지만, document 까지 버블링되므로
  // document 에서 받으면 캡처가 실패한 경우까지 함께 커버된다.
  document.addEventListener('pointermove', (event) => {
    if (!dragState) {
      return;
    }
    event.preventDefault();
    state.resultsHeight = dragState.startHeight + (event.clientY - dragState.startY);
    applyResultsHeight();
  });

  function endDrag(event) {
    if (!dragState) {
      return;
    }
    dragState = null;
    document.body.classList.remove('dragging');
    try {
      el.splitter.releasePointerCapture(event.pointerId);
    } catch (e) {
      /* 이미 해제된 경우 무시 */
    }
    // 상·하한에 걸려 잘린 경우 실제 적용된 높이를 저장한다.
    state.resultsHeight = el.results.offsetHeight;
    persist();
  }

  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  el.splitter.addEventListener('lostpointercapture', endDrag);

  /* ------------------------------------------------------------------ *
   * 확장에서 오는 메시지 처리
   * ------------------------------------------------------------------ */
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'init': {
        config = message.config || config;
        // 창을 열 때는 깨끗한 상태로 시작한다. 저장된 값 중 "최근 기록"만 되살린다.
        {
          const saved = message.state && typeof message.state === 'object' ? message.state : {};
          ['queryHistory', 'maskHistory', 'replaceHistory'].forEach((key) => {
            state[key] = Array.isArray(saved[key]) ? saved[key].slice(0, HISTORY_MAX) : [];
          });
        }
        writeUi();
        setStatus(
          message.workspaceFolders.length > 0
            ? '검색어를 입력하세요. (' + message.workspaceFolders.map((f) => f.name).join(', ') + ')'
            : '열려 있는 폴더가 없습니다. 폴더를 열거나 디렉터리 범위를 지정하세요.'
        );
        if (state.query) {
          startSearch();
        }
        el.query.focus();
        break;
      }

      case 'searchStarted':
        if (message.id === activeSearchId) {
          searching = true;
          updateEnabledState();
        }
        break;

      case 'results':
        if (message.id !== activeSearchId) {
          break;
        }
        appendFiles(message.files);
        setStatus('검색 중… ' + files.length + '개 파일');
        break;

      case 'searchDone': {
        if (message.id !== activeSearchId) {
          break;
        }
        searching = false;
        const seconds = (message.elapsedMs / 1000).toFixed(2);
        let text;
        if (files.length === 0) {
          text = '일치하는 항목이 없습니다. (' + seconds + '초)';
        } else {
          text =
            files.length +
            '개 파일에서 ' +
            message.matchCount +
            '건 (' +
            seconds +
            '초)' +
            (message.truncated ? ' — 결과 수 상한에 도달했습니다.' : '') +
            (rowLimitReached ? ' — 화면 표시 항목이 일부 생략되었습니다.' : '') +
            (message.cancelled ? ' — 중지됨' : '');
        }
        setStatus(replaceNote + text);
        replaceNote = '';
        highlightMatches();
        if (files.length === 0) {
          el.results.innerHTML = '<div class="empty">일치하는 항목이 없습니다.</div>';
        } else if (selected < 0) {
          selectRow(0, { noScroll: true });
        }
        updateEnabledState();
        break;
      }

      case 'searchError':
        searching = false;
        setStatus('검색 오류: ' + message.message, true);
        updateEnabledState();
        break;

      case 'preview': {
        if (message.uri !== preview.uri) {
          break;
        }
        preview.readonly = message.readonly;
        el.previewMessage.hidden = !message.message;
        el.previewMessage.textContent = message.message || '';
        attachModel(message.uri, ensureModel(message.uri, message.content));
        updateEnabledState();
        break;
      }

      case 'previewSaved': {
        const savedModel = models.get(message.uri);
        if (savedModel) {
          savedVersions.set(message.uri, savedModel.getAlternativeVersionId());
          baseTexts.set(message.uri, savedModel.getValue());
        }
        if (message.uri === preview.uri) {
          updateDirty();
          highlightMatches();
        }
        break;
      }

      case 'folderPicked':
        state.scopeKind = 'directory';
        state.scopePath = message.path;
        writeUi();
        startSearch();
        break;

      case 'replaceDone':
        // 파일이 디스크에서 바뀌었으니 미리보기 모델을 버리고 목록을 다시 만든다.
        replaceNote = message.fileCount + '개 파일에서 ' + message.matchCount + '건을 바꿨습니다. ';
        disposeModels();
        startSearch();
        break;

      case 'presetScope':
        state.scopeKind = 'directory';
        state.scopePath = message.scopePath;
        writeUi();
        break;

      case 'presetQuery':
        state.query = message.query;
        writeUi();
        startSearch();
        break;

      case 'focus':
        if (message.target === 'replace') {
          state.replaceOpen = true;
          writeUi();
          el.replacement.focus();
        } else {
          el.query.focus();
          el.query.select();
        }
        break;

      case 'info':
        setStatus(message.message);
        break;

      case 'error':
        setStatus(message.message, true);
        break;

      default:
        break;
    }
  });

  writeUi();
  initMonaco();
  post({ type: 'ready' });
})();
