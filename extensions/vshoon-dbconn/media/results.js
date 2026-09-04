// @ts-check
'use strict';

/**
 * 쿼리 결과 그리드.
 *
 * 규칙 하나: DB 에서 온 값은 절대 innerHTML 로 넣지 않는다.
 * 전부 textContent 로만 넣는다 — 셀에 `<script>` 가 들어 있어도 글자로 보일 뿐이다.
 *
 * 렌더링은 가상 스크롤이다. 1000행 × 50컬럼이면 DOM 노드가 5만 개가 되는데,
 * 그걸 다 만들면 패널이 눈에 띄게 버벅인다. 보이는 만큼만 만든다.
 *
 * 선택은 브라우저의 텍스트 선택이 아니라 **셀 블록** 모델이다. 그래야
 * 행 번호 클릭 → 그 행 전체, Ctrl+A → 결과 행 전체처럼 표 도구다운 동작이
 * 가능하고, 복사한 내용이 행·열 구조를 유지한 채(TSV) 붙여넣어진다.
 *
 * 편집은 확장이 편집 가능하다고 알려준 컬럼에서만 열린다. 웹뷰의 판단은
 * 확장 쪽에서 한 번 더 검증되므로, 여기 UI 는 편의를 위한 1차 필터일 뿐이다.
 */
(function () {
  const vscode = acquireVsCodeApi();

  const ROW_HEIGHT = 22;
  /** 화면 위아래로 미리 그려 둘 여유 행 수 — 스크롤 시 빈 칸이 보이지 않게. */
  const OVERSCAN = 8;
  const MIN_COL_WIDTH = 60;
  const MAX_COL_WIDTH = 420;
  /** 손으로 줄일 수 있는 최소 너비 — 자동 측정 하한보다 좁아도 된다. */
  const MIN_MANUAL_WIDTH = 28;
  /** 손으로 늘릴 수 있는 상한. 자동 측정 상한(420)에 묶이면 긴 값을 볼 수 없다. */
  const MAX_MANUAL_WIDTH = 1600;
  /** 같은 셀을 두 번 누른 것으로 볼 간격 — 운영체제의 더블클릭 간격에 맞춘 값. */
  const DOUBLE_CLICK_MS = 450;
  /** 선택이 없을 때 눌리면 첫 셀에서 시작하는 키들. */
  const NAVIGATION_KEYS = new Set([
    'ArrowDown',
    'ArrowUp',
    'ArrowLeft',
    'ArrowRight',
    'PageDown',
    'PageUp',
    'Home',
    'End',
  ]);

  const tabbarEl = /** @type {HTMLElement} */ (document.getElementById('tabbar'));
  const toolbarEl = /** @type {HTMLElement} */ (document.getElementById('toolbar'));
  const summaryEl = /** @type {HTMLElement} */ (document.getElementById('summary'));
  const selectionEl = /** @type {HTMLElement} */ (document.getElementById('selection'));
  const contentEl = /** @type {HTMLElement} */ (document.getElementById('content'));
  const btnSql = /** @type {HTMLButtonElement} */ (document.getElementById('btn-sql'));
  const btnCsv = /** @type {HTMLButtonElement} */ (document.getElementById('btn-csv'));
  const btnJson = /** @type {HTMLButtonElement} */ (document.getElementById('btn-json'));
  const btnInsert = /** @type {HTMLButtonElement} */ (document.getElementById('btn-insert'));
  const btnDelete = /** @type {HTMLButtonElement} */ (document.getElementById('btn-delete'));
  const btnPrev = /** @type {HTMLButtonElement} */ (document.getElementById('btn-prev'));
  const btnNext = /** @type {HTMLButtonElement} */ (document.getElementById('btn-next'));
  const btnMore = /** @type {HTMLButtonElement} */ (document.getElementById('btn-more'));
  const pageInfoEl = /** @type {HTMLElement} */ (document.getElementById('pageinfo'));
  const rowLimitEl = /** @type {HTMLSelectElement} */ (document.getElementById('rowlimit'));
  const rowLimitLabel = /** @type {HTMLElement} */ (document.getElementById('rowlimit-label'));

  /** 행 제한 선택 상자에 늘 있는 값들. 지금 설정이 여기 없으면 그 값도 끼워 넣는다. */
  const ROW_LIMIT_CHOICES = [100, 200, 500, 1000, 5000, 10000, 50000];
  /** 바닥에서 이만큼(px) 안에 들어오면 다음 묶음을 미리 부른다. */
  const LOAD_MORE_MARGIN = 200;

  /** @type {any[]} */
  let tabs = [];
  /** @type {string | undefined} */
  let activeId;
  /** 현재 렌더된 그리드의 핸들 (정리 + 선택 상태 조회). */
  let grid = null;
  /** 확장이 알려 준 현재 행 제한과 자동 이어 조회 여부. */
  let rowLimit = 1000;
  let autoLoadMore = true;

  /**
   * 탭별 화면 상태(정렬·선택). 결과가 다시 전달돼도 유지되어야 한다 —
   * 셀 하나를 고쳤다고 정렬이 풀리거나 선택이 사라지면 작업 흐름이 끊긴다.
   * @type {Map<string, {sort: {col: number, dir: 'asc'|'desc'} | null, ranges: any[], anchor: any, focus: any, widths: number[] | null}>}
   */
  const viewState = new Map();

  function stateFor(id) {
    let state = viewState.get(id);
    if (!state) {
      state = {
        sort: null,
        ranges: [],
        anchor: null,
        focus: null,
        widths: null,
        // 스크롤 위치는 결과가 다시 전달돼도 유지한다 — 이어 조회로 행이 늘어날
        // 때마다 맨 위로 튕기면 스크롤 자체를 이어갈 수 없다.
        scrollTop: 0,
        lastOffset: -1,
      };
      viewState.set(id, state);
    }
    return state;
  }

  // ── 메시지 수신 ──────────────────────────────────────────────────────────

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'tabs') {
      return;
    }
    tabs = Array.isArray(message.tabs) ? message.tabs : [];
    if (typeof message.rowLimit === 'number' && message.rowLimit > 0) {
      rowLimit = message.rowLimit;
    }
    autoLoadMore = message.autoLoadMore !== false;
    if (message.activeId && tabs.some((t) => t.id === message.activeId)) {
      activeId = message.activeId;
    } else if (!tabs.some((t) => t.id === activeId)) {
      activeId = tabs.length > 0 ? tabs[0].id : undefined;
    }
    // 닫힌 탭의 상태는 버린다 — 없으면 Map 이 계속 자란다.
    const alive = new Set(tabs.map((t) => t.id));
    for (const id of [...viewState.keys()]) {
      if (!alive.has(id)) {
        viewState.delete(id);
      }
    }
    render();
  });

  // ── 툴바 ─────────────────────────────────────────────────────────────────

  btnSql.addEventListener('click', () => post('openSql'));
  btnCsv.addEventListener('click', () => post('exportCsv'));
  btnJson.addEventListener('click', () => post('exportJson'));
  btnInsert.addEventListener('click', () => {
    if (grid) {
      grid.toggleDraft();
    }
  });
  btnDelete.addEventListener('click', () => {
    if (grid) {
      grid.deleteSelectedRow();
    }
  });
  btnPrev.addEventListener('click', () => turnPage('prev'));
  btnNext.addEventListener('click', () => turnPage('next'));
  // 직접 누른 이어 조회는 자동 한도에 걸리지 않는다 (auto 를 붙이지 않는다).
  btnMore.addEventListener('click', () => post('page', { direction: 'more' }));

  rowLimitEl.addEventListener('change', () => {
    if (rowLimitEl.value === 'custom') {
      // 웹뷰에서는 prompt 를 쓸 수 없다 — 확장의 입력 상자를 빌린다.
      rowLimitEl.value = String(rowLimit);
      vscode.postMessage({ type: 'promptRowLimit' });
      return;
    }
    const value = Number(rowLimitEl.value);
    if (Number.isFinite(value) && value > 0 && value !== rowLimit) {
      vscode.postMessage({ type: 'setRowLimit', value });
    }
  });

  /** 쪽을 옮길 때는 스크롤을 맨 위로 되돌린다 — 다른 행 묶음이기 때문이다. */
  function turnPage(direction) {
    if (activeId) {
      stateFor(activeId).scrollTop = 0;
    }
    post('page', { direction });
  }

  function post(type, extra) {
    if (activeId) {
      vscode.postMessage(Object.assign({ type, id: activeId }, extra || {}));
    }
  }

  // ── 렌더링 ───────────────────────────────────────────────────────────────

  function render() {
    renderTabbar();
    const tab = tabs.find((t) => t.id === activeId);
    renderToolbar(tab);
    renderContent(tab);
  }

  function renderTabbar() {
    tabbarEl.textContent = '';
    for (const tab of tabs) {
      const button = document.createElement('button');
      button.className = 'tab' + (tab.id === activeId ? ' active' : '');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.title = tab.sql;

      const dot = document.createElement('span');
      dot.className = 'tab-state ' + tab.state;
      button.appendChild(dot);

      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = tab.title;
      button.appendChild(title);

      // 고정: 켜 두면 다음 실행 때 이 탭이 대체되지 않는다.
      const pin = document.createElement('span');
      pin.className = 'tab-pin' + (tab.pinned ? ' pinned' : '');
      pin.textContent = tab.pinned ? '📌' : '📍';
      pin.title = tab.pinned ? '고정 해제 — 다음 실행 때 대체됩니다' : '고정 — 다음 실행 때 유지합니다';
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'togglePin', id: tab.id });
      });
      button.appendChild(pin);

      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = '닫기';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'closeTab', id: tab.id });
      });
      button.appendChild(close);

      button.addEventListener('click', () => {
        activeId = tab.id;
        vscode.postMessage({ type: 'selectTab', id: tab.id });
        render();
      });

      tabbarEl.appendChild(button);
    }
  }

  function renderToolbar(tab) {
    if (!tab) {
      toolbarEl.classList.add('hidden');
      return;
    }
    toolbarEl.classList.remove('hidden');
    summaryEl.textContent = '';
    selectionEl.textContent = '';

    const hasRows =
      tab.state === 'done' && Array.isArray(tab.rows) && (tab.columns || []).length > 0;
    btnCsv.disabled = !hasRows;
    btnJson.disabled = !hasRows;
    btnDelete.disabled = !hasRows || !tab.edit;
    btnDelete.style.display = tab.edit ? '' : 'none';
    btnInsert.disabled = !hasRows || !tab.edit;
    btnInsert.style.display = tab.edit ? '' : 'none';

    // 운영/스테이징이면 연결 이름 앞에 꼬리표를 붙인다.
    if (tab.environmentBadge) {
      const badge = document.createElement('span');
      badge.className =
        'env-badge' + (tab.environmentBadge === '운영' ? ' production' : ' staging');
      badge.textContent = tab.environmentBadge;
      summaryEl.appendChild(badge);
    }

    const parts = [tab.connectionName];
    if (tab.state === 'running') {
      parts.push('실행 중…');
    } else if (tab.state === 'error') {
      parts.push('오류');
    } else if (hasRows) {
      parts.push(`${tab.rowCount.toLocaleString()}행`);
      parts.push(`${tab.durationMs.toLocaleString()}ms`);
    } else if (tab.plan) {
      parts.push('실행 계획');
      parts.push(`${(tab.durationMs ?? 0).toLocaleString()}ms`);
    } else if (tab.state === 'done') {
      parts.push(`${(tab.affectedRows ?? 0).toLocaleString()}행 영향`);
      parts.push(`${tab.durationMs.toLocaleString()}ms`);
    }
    // textContent 로 덮어쓰면 위에서 붙인 배지가 지워지므로 노드로 추가한다.
    const summaryText = document.createElement('span');
    summaryText.textContent = parts.join(' · ');
    summaryEl.appendChild(summaryText);

    if (tab.edit) {
      const badge = document.createElement('span');
      badge.className = 'editable';
      badge.textContent = ` · ${tab.edit.table} 편집 가능`;
      badge.title = '셀을 더블클릭하거나 Enter 로 수정, Ctrl+Delete 로 NULL 설정';
      summaryEl.appendChild(badge);
    }

    // 페이징이 켜진 결과에서는 "잘렸다"는 경고 대신 쪽 정보를 보여준다 —
    // 다음 쪽으로 넘어갈 수 있으므로 잘린 것이 아니다.
    if (tab.truncated && !tab.page) {
      const warn = document.createElement('span');
      warn.className = 'warn';
      warn.textContent = ' · 결과가 잘렸습니다 (dbconn.execution.maxRows)';
      summaryEl.appendChild(warn);
    }

    renderPager(tab);
  }

  /** 쪽 이동 버튼과 현재 구간 표시. 페이징 대상이 아니면 감춘다. */
  function renderPager(tab) {
    const page = tab && tab.page;
    // 오류 상태에서도 버튼은 남긴다 — 이전 쪽으로 돌아갈 길이 있어야 한다.
    const isPaged = !!page;
    btnPrev.style.display = isPaged ? '' : 'none';
    btnNext.style.display = isPaged ? '' : 'none';
    btnMore.style.display = isPaged && page.hasMore ? '' : 'none';
    pageInfoEl.textContent = '';
    renderRowLimit();

    if (!isPaged) {
      return;
    }

    const loaded = Array.isArray(tab.rows) ? tab.rows.length : 0;
    const start = loaded === 0 ? page.offset : page.offset + 1;
    const end = page.offset + loaded;
    const busy = tab.state === 'running' || page.loadingMore;

    btnPrev.disabled = page.offset === 0 || busy;
    btnNext.disabled = !page.hasMore || busy;
    btnMore.disabled = busy;
    btnMore.textContent = page.loadingMore ? '불러오는 중…' : '더 불러오기';

    const parts = [
      loaded === 0 && page.offset > 0
        ? '이 쪽에는 행이 없습니다'
        : `${start.toLocaleString()}–${end.toLocaleString()}행`,
    ];
    if (page.loadingMore) {
      parts.push('이어서 불러오는 중…');
    } else if (page.hasMore) {
      parts.push(page.autoPaused ? '이후 더 있음 (자동 조회 멈춤)' : '이후 더 있음');
    }
    if (page.sort) {
      parts.push(`서버 정렬 ${page.sort.dir === 'desc' ? '내림차순' : '오름차순'}`);
    }
    pageInfoEl.textContent = parts.join(' · ');
    pageInfoEl.title =
      '서버에서 한 쪽씩 가져옵니다. 아래로 끝까지 스크롤하면 다음 묶음을 이어서 불러옵니다.\n' +
      '원본 쿼리에 ORDER BY 가 없으면 쪽 사이 행 순서는 보장되지 않습니다.';
  }

  /** 행 제한 선택 상자를 현재 설정에 맞춘다. */
  function renderRowLimit() {
    const values = ROW_LIMIT_CHOICES.includes(rowLimit)
      ? ROW_LIMIT_CHOICES
      : ROW_LIMIT_CHOICES.concat([rowLimit]).sort((a, b) => a - b);

    rowLimitEl.textContent = '';
    for (const value of values) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = value.toLocaleString();
      rowLimitEl.appendChild(option);
    }
    const custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = '직접 입력…';
    rowLimitEl.appendChild(custom);

    rowLimitEl.value = String(rowLimit);
    rowLimitLabel.title =
      '한 번에 가져올 최대 행 수입니다. 바꾸면 설정에 저장되고 지금 결과도 다시 읽습니다.';
  }

  function renderContent(tab) {
    if (grid) {
      grid.dispose();
      grid = null;
    }
    contentEl.textContent = '';

    if (!tab) {
      contentEl.appendChild(placeholder('쿼리를 실행하면 결과가 여기 표시됩니다. (Ctrl+Enter)'));
      return;
    }

    if (tab.state === 'running') {
      contentEl.appendChild(placeholder('실행 중…  (Ctrl+Escape 로 취소)'));
      return;
    }

    if (tab.state === 'error') {
      const error = document.createElement('div');
      error.className = 'message-block error';
      error.textContent = tab.error || '알 수 없는 오류';
      contentEl.appendChild(error);
      return;
    }

    // 실행 계획은 표가 아니라 여러 줄 텍스트다.
    if (tab.plan && typeof tab.plan.text === 'string') {
      if (tab.plan.note) {
        const note = document.createElement('div');
        note.className = 'message-block note';
        note.textContent = tab.plan.note;
        contentEl.appendChild(note);
      }
      const block = document.createElement('pre');
      block.className = 'plan';
      block.textContent = tab.plan.text || '(계획이 비어 있습니다)';
      contentEl.appendChild(block);
      return;
    }

    if (!Array.isArray(tab.columns) || tab.columns.length === 0) {
      const block = document.createElement('div');
      block.className = 'message-block';
      const lines = [`${(tab.affectedRows ?? 0).toLocaleString()}행이 영향을 받았습니다.`];
      if (Array.isArray(tab.messages)) {
        lines.push(...tab.messages);
      }
      block.textContent = lines.join('\n');
      contentEl.appendChild(block);
      return;
    }

    grid = buildGrid(tab);
  }

  function placeholder(text) {
    const el = document.createElement('div');
    el.className = 'placeholder';
    el.textContent = text;
    return el;
  }

  // ── 가상 스크롤 그리드 ───────────────────────────────────────────────────

  function buildGrid(tab) {
    const columns = tab.columns;
    const rows = tab.rows || [];
    const edit = tab.edit || null;
    const editableCols = new Set(edit ? edit.columns : []);
    const keyCols = new Set(edit ? edit.keyColumns : []);
    const state = stateFor(tab.id);
    const page = tab.page || null;
    /**
     * 화면에 결과 전체가 있으면 즉시 정렬하고, 잘렸거나 다른 쪽을 보고 있으면
     * 서버에 맡긴다 — 가져온 1000행 안에서만 정렬하면 "전체가 정렬됐다"는
     * 착각을 준다.
     */
    const serverSort = !!page && (page.hasMore || page.offset > 0);
    if (serverSort) {
      state.sort = null;
    }

    if (state.sort && state.sort.col >= columns.length) {
      state.sort = null;
    }
    /** 화면 순서 → 원본 행 인덱스. 정렬은 원본 배열을 건드리지 않는다. */
    const order = computeOrder(rows, state.sort);
    clampSelection(state, rows.length, columns.length);

    // 자동 측정값이 기본이고, 손으로 조절한 적이 있으면 그 너비를 유지한다.
    const measured = measureColumns(columns, rows);
    const widths =
      state.widths && state.widths.length === columns.length ? state.widths.slice() : measured;
    const rowNumWidth = Math.max(44, String(rows.length).length * 8 + 20);
    // 행 전체 너비를 명시해야 가로 스크롤 시 오른쪽 컬럼이 잘리지 않는다.
    let totalWidth = widths.reduce((sum, w) => sum + w, rowNumWidth);

    const gridEl = document.createElement('div');
    gridEl.className = 'grid';

    // 헤더 — 본문과 가로 스크롤을 동기화한다.
    const header = document.createElement('div');
    header.className = 'grid-header';
    const headerRow = document.createElement('div');
    headerRow.className = 'grid-row';
    headerRow.style.width = totalWidth + 'px';

    const corner = makeCell('', rowNumWidth, 'header rownum corner');
    corner.title = '전체 선택 (Ctrl+A)';
    corner.addEventListener('click', () => selectAll());
    headerRow.appendChild(corner);

    columns.forEach((column, i) => {
      const sorted = serverSort
        ? page.sort && page.sort.index === i
          ? page.sort.dir
          : null
        : state.sort && state.sort.col === i
          ? state.sort.dir
          : null;
      const cell = makeCell('', widths[i], 'header sortable' + (sorted ? ' sorted' : ''));
      const name = document.createElement('span');
      name.textContent = column.name;
      cell.appendChild(name);
      if (keyCols.has(i)) {
        const key = document.createElement('span');
        key.className = 'pk';
        key.textContent = '🔑';
        key.title = '기본 키';
        cell.appendChild(key);
      }
      const type = document.createElement('span');
      type.className = 'type';
      type.textContent = column.typeName;
      cell.appendChild(type);
      if (sorted) {
        const arrow = document.createElement('span');
        arrow.className = 'sort-arrow';
        arrow.textContent = sorted === 'asc' ? '▲' : '▼';
        cell.appendChild(arrow);
      }
      cell.title =
        `${column.name} — ${column.typeName}\n` +
        (serverSort
          ? '클릭: 서버에서 전체 정렬 (오름차순 → 내림차순 → 해제)'
          : '클릭: 정렬 (오름차순 → 내림차순 → 해제)');
      cell.addEventListener('click', () => cycleSort(i));
      cell.appendChild(makeResizer(i));
      headerRow.appendChild(cell);
    });
    header.appendChild(headerRow);
    gridEl.appendChild(header);

    // 본문
    const body = document.createElement('div');
    body.className = 'grid-body';
    body.tabIndex = 0;
    const spacer = document.createElement('div');
    spacer.className = 'grid-spacer';
    spacer.style.height = rows.length * ROW_HEIGHT + 'px';
    const viewport = document.createElement('div');
    viewport.style.position = 'absolute';
    viewport.style.top = '0';
    viewport.style.left = '0';
    viewport.style.width = totalWidth + 'px';

    const inner = document.createElement('div');
    inner.style.position = 'relative';
    inner.style.width = totalWidth + 'px';
    inner.appendChild(spacer);
    inner.appendChild(viewport);
    body.appendChild(inner);
    gridEl.appendChild(body);

    // 새 행 초안. 가상 스크롤 안에 끼워 넣으면 스크롤할 때마다 입력이 사라지므로
    // 본문 아래에 고정으로 둔다. 가로 스크롤만 본문과 맞춘다.
    const draft = document.createElement('div');
    draft.className = 'grid-draft hidden';
    const draftScroll = document.createElement('div');
    draftScroll.className = 'draft-scroll';
    const draftRow = document.createElement('div');
    draftRow.className = 'grid-row';
    draftScroll.appendChild(draftRow);
    const draftActions = document.createElement('div');
    draftActions.className = 'draft-actions';
    draft.appendChild(draftScroll);
    draft.appendChild(draftActions);
    gridEl.appendChild(draft);

    // 셀 값 뷰어 — 한 줄로 잘려 보이는 긴 값(JSON·로그·본문)을 통째로 본다.
    const viewer = document.createElement('div');
    viewer.className = 'cell-viewer hidden';
    gridEl.appendChild(viewer);

    contentEl.appendChild(gridEl);

    /** 인라인 편집 중인 input. 있으면 키 처리를 넘기지 않는다. */
    let editingInput = null;
    /** 드래그 선택 중인지 — 'cell' 이면 셀 단위, 'row' 면 행 단위. */
    let dragMode = null;
    /** 너비 조절 중인 컬럼 — {index, startX, startWidth}. */
    let resizing = null;
    /** 이 시각 전의 헤더 클릭은 너비 조절의 잔상이므로 정렬하지 않는다. */
    let sortBlockedUntil = 0;
    /** 마지막으로 누른 셀 — 더블클릭 판정에 쓴다 (activateCell 주석 참고). */
    let lastPress = { row: -1, col: -1, at: 0 };
    /** 이어 조회를 이미 요청했는지. 다음 결과가 도착하면 그리드째 새로 만들어지며 풀린다. */
    let requestedMore = false;
    let lastStart = -1;
    let lastEnd = -1;

    // ── 컬럼 너비 ──────────────────────────────────────────────────────────

    /** 컬럼 경계에 놓이는 손잡이. 여기서 시작한 드래그는 정렬로 이어지지 않는다. */
    function makeResizer(index) {
      const handle = document.createElement('div');
      handle.className = 'col-resizer';
      handle.title = '드래그: 너비 조절 · 더블클릭: 내용에 맞춤';
      handle.addEventListener('mousedown', (event) => {
        if (event.button !== 0) {
          return;
        }
        // 헤더의 정렬 클릭과 본문의 블록 선택으로 새어 나가지 않게 막는다.
        event.preventDefault();
        event.stopPropagation();
        beginResize(index, event.clientX);
      });
      handle.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setColumnWidth(index, measured[index]);
        state.widths = widths.slice();
      });
      handle.addEventListener('click', (event) => event.stopPropagation());
      return handle;
    }

    function beginResize(index, clientX) {
      resizing = { index, startX: clientX, startWidth: widths[index] };
      gridEl.classList.add('resizing');
      const headerCell = headerRow.children[index + 1];
      if (headerCell instanceof HTMLElement) {
        headerCell.classList.add('resizing');
      }
    }

    function onResizeMove(event) {
      if (!resizing) {
        return;
      }
      // 웹뷰 밖에서 버튼을 놓으면 mouseup 이 오지 않는다 — 다음 이동에서 정리한다.
      if (event.buttons === 0) {
        onResizeEnd();
        return;
      }
      event.preventDefault();
      const next = resizing.startWidth + (event.clientX - resizing.startX);
      setColumnWidth(resizing.index, next);
    }

    function onResizeEnd() {
      if (!resizing) {
        return;
      }
      const headerCell = headerRow.children[resizing.index + 1];
      if (headerCell instanceof HTMLElement) {
        headerCell.classList.remove('resizing');
      }
      resizing = null;
      gridEl.classList.remove('resizing');
      // 조절한 너비는 탭에 남겨 다시 그려도 유지되게 한다.
      state.widths = widths.slice();
      // 손잡이에서 손을 뗀 직후의 click 은 정렬로 해석하지 않는다.
      sortBlockedUntil = Date.now() + 200;
    }

    /**
     * 너비를 바꾸고 화면에 반영한다.
     * 전체를 다시 그리지 않고 해당 컬럼의 셀만 손대야 드래그가 매끄럽다.
     */
    function setColumnWidth(index, width) {
      const clamped = Math.round(
        Math.min(MAX_MANUAL_WIDTH, Math.max(MIN_MANUAL_WIDTH, width)),
      );
      if (clamped === widths[index]) {
        return;
      }
      widths[index] = clamped;
      totalWidth = widths.reduce((sum, w) => sum + w, rowNumWidth);

      const px = clamped + 'px';
      const totalPx = totalWidth + 'px';
      headerRow.style.width = totalPx;
      viewport.style.width = totalPx;
      inner.style.width = totalPx;

      const headerCell = headerRow.children[index + 1];
      if (headerCell instanceof HTMLElement) {
        headerCell.style.width = px;
      }
      for (const rowEl of viewport.children) {
        if (!(rowEl instanceof HTMLElement)) {
          continue;
        }
        rowEl.style.width = totalPx;
        const cell = rowEl.children[index + 1];
        if (cell instanceof HTMLElement) {
          cell.style.width = px;
        }
      }

      // 열려 있는 초안 행도 같이 맞춘다.
      draftRow.style.width = totalPx;
      const draftCell = draftRow.children[index + 1];
      if (draftCell instanceof HTMLElement) {
        draftCell.style.width = px;
      }
    }

    // ── 정렬 ───────────────────────────────────────────────────────────────

    /** 오름차순 → 내림차순 → 해제 순으로 돈다. */
    function cycleSort(col) {
      if (resizing || Date.now() < sortBlockedUntil) {
        return; // 너비를 조절한 드래그였다.
      }

      if (serverSort) {
        const current = page.sort && page.sort.index === col ? page.sort.dir : null;
        const next = current === null ? 'asc' : current === 'asc' ? 'desc' : null;
        vscode.postMessage({
          type: 'sortServer',
          id: tab.id,
          column: next === null ? null : col,
          dir: next,
        });
        return;
      }

      if (!state.sort || state.sort.col !== col) {
        state.sort = { col, dir: 'asc' };
      } else if (state.sort.dir === 'asc') {
        state.sort = { col, dir: 'desc' };
      } else {
        state.sort = null;
      }
      // 화면 순서가 바뀌므로 선택은 의미를 잃는다.
      clearSelection();
      render();
    }

    // ── 선택 ───────────────────────────────────────────────────────────────

    function clearSelection() {
      state.ranges = [];
      state.anchor = null;
      state.focus = null;
    }

    function setSelection(anchor, focus, additive) {
      const range = rectOf(anchor, focus);
      state.ranges = additive ? [...state.ranges, range] : [range];
      state.anchor = anchor;
      state.focus = focus;
    }

    /** 마지막 블록만 갱신한다 — Shift 확장과 드래그에 쓴다. */
    function extendSelection(focus) {
      if (!state.anchor) {
        return;
      }
      const range = rectOf(state.anchor, focus);
      if (state.ranges.length === 0) {
        state.ranges = [range];
      } else {
        state.ranges[state.ranges.length - 1] = range;
      }
      state.focus = focus;
    }

    function selectCell(row, col, options) {
      const anchor = { row, col };
      if (options.shift && state.anchor) {
        extendSelection({ row, col });
      } else {
        setSelection(anchor, anchor, options.ctrl === true);
      }
      paint(true);
      updateSelectionInfo();
    }

    /** 행 번호를 눌렀을 때 — 그 행 전체를 블록으로 잡는다. */
    function selectRow(row, options) {
      const left = 0;
      const right = columns.length - 1;
      if (options.shift && state.anchor) {
        extendSelection({ row, col: right });
        // 앵커의 열을 0 으로 고정해 언제나 행 전체가 되게 한다.
        const last = state.ranges[state.ranges.length - 1];
        last.left = left;
        last.right = right;
      } else {
        const anchor = { row, col: left };
        const focus = { row, col: right };
        state.ranges = options.ctrl ? [...state.ranges, rectOf(anchor, focus)] : [rectOf(anchor, focus)];
        state.anchor = anchor;
        state.focus = focus;
      }
      paint(true);
      updateSelectionInfo();
    }

    /** Ctrl+A — 조회 결과 행만 전부. 탭 바나 툴바 글자는 잡히지 않는다. */
    function selectAll() {
      if (rows.length === 0 || columns.length === 0) {
        return;
      }
      state.ranges = [{ top: 0, left: 0, bottom: rows.length - 1, right: columns.length - 1 }];
      state.anchor = { row: 0, col: 0 };
      state.focus = state.focus ?? { row: 0, col: 0 };
      paint(true);
      updateSelectionInfo();
    }

    function isSelected(row, col) {
      for (const range of state.ranges) {
        if (row >= range.top && row <= range.bottom && col >= range.left && col <= range.right) {
          return true;
        }
      }
      return false;
    }

    /** 행 전체가 선택됐는지 — 행 번호 칸 강조에 쓴다. */
    function isRowSelected(row) {
      for (const range of state.ranges) {
        if (
          row >= range.top &&
          row <= range.bottom &&
          range.left === 0 &&
          range.right === columns.length - 1
        ) {
          return true;
        }
      }
      return false;
    }

    function selectedCellCount() {
      // 겹치는 블록을 두 번 세지 않게 실제 셀을 확인한다.
      if (state.ranges.length === 0) {
        return { cells: 0, rows: 0 };
      }
      if (state.ranges.length === 1) {
        const r = state.ranges[0];
        const height = r.bottom - r.top + 1;
        return { cells: height * (r.right - r.left + 1), rows: height };
      }
      const seen = new Set();
      const rowSet = new Set();
      for (const range of state.ranges) {
        for (let r = range.top; r <= range.bottom; r++) {
          rowSet.add(r);
          for (let c = range.left; c <= range.right; c++) {
            seen.add(r + ':' + c);
          }
        }
      }
      return { cells: seen.size, rows: rowSet.size };
    }

    function updateSelectionInfo() {
      const { cells, rows: rowCount } = selectedCellCount();
      selectionEl.textContent =
        cells === 0 ? '' : cells === 1 ? '1셀 선택' : `${rowCount}행 · ${cells}셀 선택`;
    }

    // ── 그리기 ─────────────────────────────────────────────────────────────

    function paint(force) {
      const scrollTop = body.scrollTop;
      const visible = Math.ceil(body.clientHeight / ROW_HEIGHT);
      const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
      const end = Math.min(rows.length, start + visible + OVERSCAN * 2);

      if (!force && start === lastStart && end === lastEnd) {
        return;
      }
      lastStart = start;
      lastEnd = end;

      viewport.textContent = '';
      viewport.style.transform = `translateY(${start * ROW_HEIGHT}px)`;

      const fragment = document.createDocumentFragment();
      for (let r = start; r < end; r++) {
        const rowEl = document.createElement('div');
        rowEl.className = 'grid-row';
        rowEl.style.width = totalWidth + 'px';

        const numberCell = makeCell(
          String(r + 1),
          rowNumWidth,
          'rownum' + (isRowSelected(r) ? ' sel' : ''),
        );
        numberCell.dataset.row = String(r);
        numberCell.title = '클릭: 이 행 전체 선택 (Shift/Ctrl 로 여러 행)';
        rowEl.appendChild(numberCell);

        const row = rows[order[r]];
        for (let c = 0; c < columns.length; c++) {
          const value = row ? row[c] : null;
          const isNull = value === null || value === undefined;
          let cls = isNull ? 'null' : '';
          if (editableCols.has(c)) {
            cls += ' editable-cell';
          }
          if (isSelected(r, c)) {
            cls += ' sel';
          }
          if (state.focus && state.focus.row === r && state.focus.col === c) {
            cls += ' focus';
          }
          const cell = makeCell(isNull ? 'NULL' : String(value), widths[c], cls);
          if (!isNull) {
            cell.title = String(value);
          }
          cell.dataset.row = String(r);
          cell.dataset.col = String(c);
          rowEl.appendChild(cell);
        }
        fragment.appendChild(rowEl);
      }
      viewport.appendChild(fragment);
    }

    function findCell(r, c) {
      return viewport.querySelector(`.cell[data-row="${r}"][data-col="${c}"]`);
    }

    // ── 인라인 편집 ────────────────────────────────────────────────────────

    function beginEdit() {
      if (!state.focus || !edit || editingInput) {
        return;
      }
      if (!editableCols.has(state.focus.col)) {
        return;
      }
      const cell = findCell(state.focus.row, state.focus.col);
      if (!(cell instanceof HTMLElement)) {
        return;
      }

      const displayRow = state.focus.row;
      const rowIndex = order[displayRow];
      const colIndex = state.focus.col;
      const current = rows[rowIndex] ? rows[rowIndex][colIndex] : null;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cell-editor';
      input.value = current === null || current === undefined ? '' : String(current);
      cell.textContent = '';
      cell.appendChild(input);
      input.focus();
      input.select();
      editingInput = input;

      let settled = false;
      const finish = (commit) => {
        if (settled) {
          return;
        }
        settled = true;
        editingInput = null;
        const next = input.value;
        // 화면은 곧바로 되돌린다. 확장이 성공을 알려주면 다시 그려진다.
        paint(true);
        body.focus();
        if (commit && next !== (current === null ? '' : String(current))) {
          vscode.postMessage({
            type: 'updateCell',
            id: tab.id,
            rowIndex,
            columnIndex: colIndex,
            value: next,
          });
        }
      };

      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      });
      input.addEventListener('blur', () => finish(true));
    }

    function setNull() {
      if (!state.focus || !edit || !editableCols.has(state.focus.col)) {
        return;
      }
      const rowIndex = order[state.focus.row];
      const row = rows[rowIndex];
      if (!row || row[state.focus.col] === null) {
        return;
      }
      vscode.postMessage({
        type: 'updateCell',
        id: tab.id,
        rowIndex,
        columnIndex: state.focus.col,
        value: null,
      });
    }

    function deleteSelectedRow() {
      if (!state.focus || !edit) {
        return;
      }
      vscode.postMessage({ type: 'deleteRow', id: tab.id, rowIndex: order[state.focus.row] });
    }

    // ── 새 행 추가 ─────────────────────────────────────────────────────────

    /** @type {HTMLInputElement[]} */
    let draftInputs = [];

    function draftOpen() {
      return !draft.classList.contains('hidden');
    }

    function toggleDraft() {
      if (draftOpen()) {
        closeDraft();
      } else {
        openDraft();
      }
    }

    function openDraft() {
      if (!edit) {
        return;
      }
      draftRow.textContent = '';
      draftActions.textContent = '';
      draftInputs = [];
      draftRow.style.width = totalWidth + 'px';

      const marker = makeCell('＋', rowNumWidth, 'rownum draft-marker');
      marker.title = '새 행';
      draftRow.appendChild(marker);

      for (let c = 0; c < columns.length; c++) {
        const writable = editableCols.has(c) || keyCols.has(c);
        const cell = makeCell('', widths[c], writable ? 'draft-cell' : 'draft-cell locked');
        if (writable) {
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'cell-editor';
          input.placeholder = columns[c].name;
          input.title = `${columns[c].name} — ${columns[c].typeName}`;
          input.dataset.col = String(c);
          input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              submitDraft();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeDraft();
            }
          });
          cell.appendChild(input);
          draftInputs.push(input);
        } else {
          cell.textContent = '—';
          cell.title = '이 컬럼에는 값을 넣을 수 없습니다 (기본 키·편집 대상이 아님).';
        }
        draftRow.appendChild(cell);
      }

      const hint = document.createElement('span');
      hint.className = 'draft-hint';
      hint.textContent = '빈 칸은 서버 기본값으로 채워집니다. Enter 저장 · Esc 취소';
      draftActions.appendChild(hint);

      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = '추가';
      save.addEventListener('click', () => submitDraft());
      draftActions.appendChild(save);

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = '취소';
      cancel.addEventListener('click', () => closeDraft());
      draftActions.appendChild(cancel);

      draft.classList.remove('hidden');
      draftScroll.scrollLeft = body.scrollLeft;
      draftInputs[0]?.focus();
    }

    function closeDraft() {
      draft.classList.add('hidden');
      draftRow.textContent = '';
      draftActions.textContent = '';
      draftInputs = [];
      body.focus();
    }

    /**
     * 값을 채운 칸만 보낸다.
     * 빈 칸을 NULL 로 밀어 넣으면 NOT NULL 컬럼이 있는 테이블에는
     * 아무 행도 넣을 수 없다 — 생략해야 서버 기본값·시퀀스가 채운다.
     */
    function submitDraft() {
      const cells = [];
      for (const input of draftInputs) {
        if (input.value.length === 0) {
          continue;
        }
        cells.push({ columnIndex: Number(input.dataset.col), value: input.value });
      }
      if (cells.length === 0) {
        return;
      }
      vscode.postMessage({ type: 'insertRow', id: tab.id, cells });
      closeDraft();
    }

    // ── 셀 값 뷰어 ─────────────────────────────────────────────────────────

    function viewerOpen() {
      return !viewer.classList.contains('hidden');
    }

    function closeViewer() {
      viewer.classList.add('hidden');
      viewer.textContent = '';
      body.focus();
    }

    /** 커서가 있는 셀의 값을 통째로 보여준다. */
    function openViewer() {
      if (!state.focus) {
        return;
      }
      const { row, col } = state.focus;
      const column = columns[col];
      const source = rows[order[row]];
      const value = source ? source[col] : null;
      const isNull = value === null || value === undefined;
      const text = isNull ? '' : String(value);

      viewer.textContent = '';

      const head = document.createElement('div');
      head.className = 'viewer-head';

      const title = document.createElement('span');
      title.className = 'viewer-title';
      title.textContent = `${column.name}`;
      head.appendChild(title);

      const meta = document.createElement('span');
      meta.className = 'viewer-meta';
      const lines = text.length === 0 ? 0 : text.split('\n').length;
      meta.textContent = isNull
        ? `${column.typeName} · NULL · ${row + 1}행`
        : `${column.typeName} · ${text.length.toLocaleString()}자 · ${lines.toLocaleString()}줄 · ${row + 1}행`;
      head.appendChild(meta);

      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      head.appendChild(spacer);

      const pre = document.createElement('pre');
      pre.className = 'viewer-body';

      // JSON 으로 읽히면 보기 좋게 펼칠 수 있게 한다.
      const pretty = prettyJson(text);
      let showingPretty = false;
      if (pretty !== undefined) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.textContent = 'JSON 보기';
        toggle.addEventListener('click', () => {
          showingPretty = !showingPretty;
          pre.textContent = showingPretty ? pretty : text;
          toggle.textContent = showingPretty ? '원본 보기' : 'JSON 보기';
        });
        head.appendChild(toggle);
      }

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '복사';
      copy.addEventListener('click', () => {
        vscode.postMessage({ type: 'copy', text: showingPretty && pretty ? pretty : text });
      });
      head.appendChild(copy);

      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '닫기';
      close.title = 'Esc';
      close.addEventListener('click', () => closeViewer());
      head.appendChild(close);

      viewer.appendChild(head);

      if (isNull) {
        pre.classList.add('null');
        pre.textContent = 'NULL';
      } else {
        pre.textContent = text;
      }
      viewer.appendChild(pre);

      // 확장이 셀 값을 자를 때 남기는 표시. 원본 전체가 아님을 알려야 한다.
      if (/…\s*\([\d,]+자 중 앞부분\)$/.test(text)) {
        const note = document.createElement('div');
        note.className = 'viewer-note';
        note.textContent = '값이 너무 커서 앞부분만 가져왔습니다. 전체를 보려면 쿼리로 잘라서 조회하세요.';
        viewer.appendChild(note);
      }

      viewer.classList.remove('hidden');
    }

    // ── 복사 ───────────────────────────────────────────────────────────────

    /**
     * 선택 블록을 TSV 로 만든다.
     * 행은 줄바꿈, 열은 탭으로 — 그대로 붙여 넣으면 블록 구조가 유지된다.
     * 값 안의 탭·줄바꿈은 공백으로 바꾼다. 그러지 않으면 한 셀이 여러 줄로
     * 쪼개져 표가 어긋난다.
     */
    function selectionToTsv(withHeaders) {
      if (state.ranges.length === 0) {
        return toTsv(columns, order.map((i) => rows[i]));
      }
      let top = Infinity;
      let bottom = -Infinity;
      let left = Infinity;
      let right = -Infinity;
      for (const range of state.ranges) {
        top = Math.min(top, range.top);
        bottom = Math.max(bottom, range.bottom);
        left = Math.min(left, range.left);
        right = Math.max(right, range.right);
      }

      const lines = [];
      if (withHeaders) {
        const head = [];
        for (let c = left; c <= right; c++) {
          head.push(columns[c].name);
        }
        lines.push(head.join('\t'));
      }
      for (let r = top; r <= bottom; r++) {
        const row = rows[order[r]];
        const line = [];
        for (let c = left; c <= right; c++) {
          // 떨어져 있는 블록을 함께 복사하면 사이는 빈 칸으로 채운다.
          line.push(isSelected(r, c) ? formatCell(row ? row[c] : null) : '');
        }
        lines.push(line.join('\t'));
      }
      return lines.join('\n');
    }

    function copySelection(withHeaders) {
      const text = selectionToTsv(withHeaders);
      if (text.length > 0) {
        vscode.postMessage({ type: 'copy', text });
      }
    }

    // ── 이벤트 ─────────────────────────────────────────────────────────────

    function onScroll() {
      header.scrollLeft = body.scrollLeft;
      draftScroll.scrollLeft = body.scrollLeft;
      state.scrollTop = body.scrollTop;
      paint(false);
      maybeLoadMore();
    }

    /**
     * 바닥에 닿으면 다음 묶음을 이어서 부른다.
     *
     * 처음 그릴 때는 부르지 않는다 — 행이 적어 화면을 못 채운 결과에서 스크롤도
     * 하기 전에 연쇄 조회가 시작되면, 제한을 걸어 둔 의미가 사라진다.
     * 요청은 auto 로 표시해 보낸다. 확장은 자동 요청에만 누적 행 수 한도를 건다.
     */
    function maybeLoadMore() {
      if (!autoLoadMore || requestedMore || !page || !page.hasMore) {
        return;
      }
      if (page.loadingMore || page.autoPaused || tab.state === 'running') {
        return;
      }
      const remaining = body.scrollHeight - body.scrollTop - body.clientHeight;
      if (remaining > LOAD_MORE_MARGIN) {
        return;
      }
      requestedMore = true;
      vscode.postMessage({ type: 'page', id: tab.id, direction: 'more', auto: true });
    }

    function cellAt(target) {
      const cell = target instanceof Element ? target.closest('.cell') : null;
      if (!(cell instanceof HTMLElement) || cell.dataset.row === undefined) {
        return null;
      }
      return {
        row: Number(cell.dataset.row),
        col: cell.dataset.col === undefined ? null : Number(cell.dataset.col),
      };
    }

    function onMouseDown(event) {
      if (event.button !== 0) {
        return;
      }
      const hit = cellAt(event.target);
      if (!hit) {
        return;
      }
      const options = { shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey };
      body.focus();

      // 같은 셀을 짧은 간격으로 두 번 누른 것인지 여기서 직접 본다 (아래 주석).
      const now = Date.now();
      const again =
        hit.col !== null &&
        lastPress.row === hit.row &&
        lastPress.col === hit.col &&
        now - lastPress.at < DOUBLE_CLICK_MS &&
        !options.shift &&
        !options.ctrl;
      lastPress = { row: hit.row, col: hit.col, at: now };

      if (hit.col === null) {
        dragMode = 'row';
        selectRow(hit.row, options);
      } else {
        dragMode = 'cell';
        selectCell(hit.row, hit.col, options);
      }
      // 드래그로 범위를 늘리는 동안 텍스트가 잡히지 않게 한다.
      event.preventDefault();

      if (again) {
        // 세 번째 누름이 또 열지 않도록 기록을 지운다.
        lastPress = { row: -1, col: -1, at: 0 };
        activateCell();
      }
    }

    function onMouseMove(event) {
      // 편집 중에는 선택을 늘리지 않는다 — 다시 그리면 입력 칸이 사라진다.
      if (editingInput || !dragMode || event.buttons === 0) {
        return;
      }
      const hit = cellAt(event.target);
      if (!hit || !state.focus) {
        return;
      }
      const col = dragMode === 'row' ? columns.length - 1 : hit.col === null ? 0 : hit.col;
      if (state.focus.row === hit.row && state.focus.col === col) {
        return;
      }
      extendSelection({ row: hit.row, col });
      if (dragMode === 'row') {
        const last = state.ranges[state.ranges.length - 1];
        last.left = 0;
        last.right = columns.length - 1;
      }
      paint(true);
      updateSelectionInfo();
    }

    function onMouseUp() {
      dragMode = null;
    }

    /**
     * 지금 고른 셀을 "연다" — 편집할 수 있으면 편집을, 아니면 값 전체 보기를.
     *
     * 더블클릭을 브라우저의 `dblclick` 이벤트로 받지 않는 이유가 있다.
     * 첫 번째 누름에서 선택 강조를 반영하려고 본문을 통째로 다시 그리는데,
     * 그러면 두 번 누른 자리의 DOM 노드가 서로 다른 객체가 된다. 브라우저는
     * 두 대상의 공통 조상에 이벤트를 보내므로 `dblclick` 이 셀이 아니라
     * 컨테이너에서 발생해, 셀을 찾지 못하고 아무 일도 일어나지 않았다.
     * (F2/Enter 로만 편집이 열리던 원인이 이것이다.)
     */
    function activateCell() {
      if (!state.focus) {
        return;
      }
      if (edit && editableCols.has(state.focus.col)) {
        beginEdit();
      } else {
        openViewer();
      }
    }

    function onKeyDown(event) {
      if (editingInput) {
        return; // 편집 중에는 input 이 키를 처리한다.
      }
      const ctrl = event.ctrlKey || event.metaKey;

      // Ctrl+A — 결과 행 전체 선택. 브라우저 기본 동작(문서 전체 선택)은 막는다.
      if (ctrl && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAll();
        return;
      }

      // Ctrl+C — 선택 블록을 TSV 로. Shift 를 같이 누르면 헤더도 포함한다.
      if (ctrl && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        copySelection(event.shiftKey);
        return;
      }

      // 아직 아무 셀도 고르지 않았는데 이동 키를 누르면 첫 셀에서 시작한다.
      if (!state.focus) {
        if (NAVIGATION_KEYS.has(event.key) && rows.length > 0) {
          event.preventDefault();
          const first = { row: 0, col: 0 };
          setSelection(first, first, false);
          body.scrollTop = 0;
          paint(true);
          updateSelectionInfo();
        }
        return;
      }

      // Ctrl+Delete — NULL 설정. Delete 단독은 실수 위험이 커서 쓰지 않는다.
      if (ctrl && event.key === 'Delete') {
        event.preventDefault();
        setNull();
        return;
      }

      // Alt+Enter — 셀 값 전체 보기. 한 줄로 잘린 긴 값을 확인하는 통로.
      if (event.altKey && event.key === 'Enter') {
        event.preventDefault();
        openViewer();
        return;
      }

      if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault();
        beginEdit();
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        if (viewerOpen()) {
          closeViewer();
          return;
        }
        clearSelection();
        paint(true);
        updateSelectionInfo();
        return;
      }

      let { row, col } = state.focus;
      const lastRow = rows.length - 1;
      const lastCol = columns.length - 1;

      if (event.key === 'ArrowDown') {
        row = Math.min(lastRow, row + 1);
      } else if (event.key === 'ArrowUp') {
        row = Math.max(0, row - 1);
      } else if (event.key === 'ArrowRight') {
        col = Math.min(lastCol, col + 1);
      } else if (event.key === 'ArrowLeft') {
        col = Math.max(0, col - 1);
      } else if (event.key === 'PageDown') {
        row = Math.min(lastRow, row + Math.max(1, Math.floor(body.clientHeight / ROW_HEIGHT) - 1));
      } else if (event.key === 'PageUp') {
        row = Math.max(0, row - Math.max(1, Math.floor(body.clientHeight / ROW_HEIGHT) - 1));
      } else if (event.key === 'Home') {
        col = 0;
        if (ctrl) {
          row = 0;
        }
      } else if (event.key === 'End') {
        col = lastCol;
        if (ctrl) {
          row = lastRow;
        }
      } else {
        return;
      }
      event.preventDefault();

      if (event.shiftKey && state.anchor) {
        extendSelection({ row, col });
      } else {
        const at = { row, col };
        setSelection(at, at, false);
      }
      updateSelectionInfo();

      const top = row * ROW_HEIGHT;
      if (top < body.scrollTop) {
        body.scrollTop = top;
      } else if (top + ROW_HEIGHT > body.scrollTop + body.clientHeight) {
        body.scrollTop = top + ROW_HEIGHT - body.clientHeight;
      }
      paint(true);
    }

    body.addEventListener('scroll', onScroll);
    body.addEventListener('mousedown', onMouseDown);
    body.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onResizeMove);
    window.addEventListener('mouseup', onResizeEnd);
    document.addEventListener('keydown', onKeyDown);
    const resizeObserver = new ResizeObserver(() => paint(true));
    resizeObserver.observe(body);

    // 이어 조회로 다시 그려도 보던 자리에 머문다. 쪽이 바뀌었으면 맨 위부터 —
    // 다른 행 묶음인데 스크롤만 그대로면 엉뚱한 위치를 보고 있게 된다.
    const pageOffset = page ? page.offset : 0;
    if (state.lastOffset === pageOffset) {
      body.scrollTop = state.scrollTop || 0;
    } else {
      state.scrollTop = 0;
    }
    state.lastOffset = pageOffset;

    paint(true);
    updateSelectionInfo();

    return {
      deleteSelectedRow,
      toggleDraft,
      dispose() {
        body.removeEventListener('scroll', onScroll);
        body.removeEventListener('mousedown', onMouseDown);
        body.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('mousemove', onResizeMove);
        window.removeEventListener('mouseup', onResizeEnd);
        document.removeEventListener('keydown', onKeyDown);
        resizeObserver.disconnect();
      },
    };
  }

  // ── 헬퍼 ─────────────────────────────────────────────────────────────────

  /** JSON 으로 읽히면 들여쓴 문자열을, 아니면 undefined. */
  function prettyJson(text) {
    const trimmed = text.trim();
    if (trimmed.length < 2 || !/^[[{]/.test(trimmed)) {
      return undefined;
    }
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return undefined;
    }
  }

  function rectOf(a, b) {
    return {
      top: Math.min(a.row, b.row),
      bottom: Math.max(a.row, b.row),
      left: Math.min(a.col, b.col),
      right: Math.max(a.col, b.col),
    };
  }

  /** 행이 지워졌거나 컬럼이 달라졌을 때 선택이 범위를 벗어나지 않게 자른다. */
  function clampSelection(state, rowCount, colCount) {
    if (rowCount === 0 || colCount === 0) {
      state.ranges = [];
      state.anchor = null;
      state.focus = null;
      return;
    }
    const ranges = [];
    for (const range of state.ranges) {
      const top = Math.min(range.top, rowCount - 1);
      const bottom = Math.min(range.bottom, rowCount - 1);
      const left = Math.min(range.left, colCount - 1);
      const right = Math.min(range.right, colCount - 1);
      if (top <= bottom && left <= right) {
        ranges.push({ top, bottom, left, right });
      }
    }
    state.ranges = ranges;
    state.anchor = clampPoint(state.anchor, rowCount, colCount);
    state.focus = clampPoint(state.focus, rowCount, colCount);
  }

  function clampPoint(point, rowCount, colCount) {
    if (!point) {
      return null;
    }
    return {
      row: Math.min(point.row, rowCount - 1),
      col: Math.min(point.col, colCount - 1),
    };
  }

  /**
   * 화면 순서를 만든다. 원본 rows 는 그대로 두고 인덱스만 늘어놓는다 —
   * 편집·삭제가 원본 인덱스를 기준으로 확장에 전달되어야 하기 때문이다.
   */
  function computeOrder(rows, sort) {
    const order = rows.map((_, index) => index);
    if (!sort) {
      return order;
    }
    const sign = sort.dir === 'desc' ? -1 : 1;
    return order.sort((ia, ib) => {
      const a = rows[ia] ? rows[ia][sort.col] : null;
      const b = rows[ib] ? rows[ib][sort.col] : null;
      const aNull = a === null || a === undefined;
      const bNull = b === null || b === undefined;
      // NULL 은 방향과 무관하게 항상 끝으로 — 빈 값이 위로 몰리면 읽기 어렵다.
      if (aNull || bNull) {
        return aNull && bNull ? ia - ib : aNull ? 1 : -1;
      }
      const diff = compareValues(a, b);
      // 값이 같으면 원래 순서를 지킨다 (안정 정렬).
      return diff !== 0 ? sign * diff : ia - ib;
    });
  }

  function compareValues(a, b) {
    if (typeof a === 'number' && typeof b === 'number') {
      return a - b;
    }
    if (typeof a === 'boolean' && typeof b === 'boolean') {
      return (a ? 1 : 0) - (b ? 1 : 0);
    }
    const as = String(a);
    const bs = String(b);
    // 문자열로 온 숫자(드라이버가 BIGINT/DECIMAL 을 문자열로 주는 경우)도
    // 숫자로 비교한다 — 사전순으로 두면 10 이 9 앞에 온다.
    const an = Number(as);
    const bn = Number(bs);
    if (as.trim() !== '' && bs.trim() !== '' && Number.isFinite(an) && Number.isFinite(bn)) {
      return an === bn ? 0 : an - bn;
    }
    return as.localeCompare(bs, undefined, { numeric: true, sensitivity: 'base' });
  }

  function makeCell(text, width, extraClass) {
    const cell = document.createElement('div');
    cell.className = 'cell' + (extraClass ? ' ' + extraClass : '');
    cell.style.width = width + 'px';
    if (text) {
      cell.textContent = text;
    }
    return cell;
  }

  /**
   * 컬럼 너비를 내용 길이로 추정한다.
   * 전체 행을 재면 느리므로 앞쪽 표본만 본다 — 대부분 이걸로 충분하다.
   */
  function measureColumns(columns, rows) {
    const sample = Math.min(rows.length, 200);
    return columns.map((column, index) => {
      let longest = column.name.length + column.typeName.length + 3;
      for (let r = 0; r < sample; r++) {
        const value = rows[r] ? rows[r][index] : null;
        const length = value === null || value === undefined ? 4 : String(value).length;
        if (length > longest) {
          longest = length;
        }
      }
      return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, longest * 7 + 18));
    });
  }

  function formatCell(value) {
    return value === null || value === undefined
      ? ''
      : String(value).replace(/[\t\r\n]/g, ' ');
  }

  /** 스프레드시트에 그대로 붙여 넣을 수 있는 TSV. */
  function toTsv(columns, rows) {
    const lines = [columns.map((c) => c.name).join('\t')];
    for (const row of rows) {
      lines.push((row || []).map((v) => formatCell(v)).join('\t'));
    }
    return lines.join('\n');
  }
})();
