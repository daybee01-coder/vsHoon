// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  function post(m) {
    vscode.postMessage(m);
  }

  // ---- 포맷터 ----------------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtSize(n) {
    if (n === undefined || n === null) return '';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
  }
  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtMode(mode) {
    if (mode === undefined || mode === null) return '';
    const bits = ['r', 'w', 'x'];
    let s = '';
    for (let g = 2; g >= 0; g--) {
      const v = (mode >> (g * 3)) & 7;
      for (let b = 0; b < 3; b++) s += v & (4 >> b) ? bits[b] : '-';
    }
    return s + ' ' + mode.toString(8).padStart(3, '0');
  }

  // ---- 상태 ---------------------------------------------------------------
  function paneState() {
    return { path: '', entries: [], error: null, selected: new Set(), sortKey: 'name', sortAsc: true, anchor: -1 };
  }
  const persisted = vscode.getState() || {};
  const state = {
    local: paneState(),
    remote: paneState(),
    connected: false,
    sessionLabel: '',
    showHidden: !!persisted.showHidden,
    syncNav: !!persisted.syncNav,
    queueVisible: !!persisted.queueVisible,
    queueHeight: Math.max(60, persisted.queueHeight || 160),
    splitPercent: Math.min(85, Math.max(15, persisted.splitPercent || 50)),
  };
  function savePrefs() {
    vscode.setState({
      showHidden: state.showHidden,
      syncNav: state.syncNav,
      queueVisible: state.queueVisible,
      queueHeight: state.queueHeight,
      splitPercent: state.splitPercent,
    });
  }

  // ---- 로컬/원격 패널 너비 -------------------------------------------------
  const panesEl = document.getElementById('panes');
  const localPaneEl = document.querySelector('.pane[data-pane="local"]');
  const splitterEl = document.getElementById('paneSplitter');

  function applySplitPercent() {
    const available = Math.max(0, panesEl.clientWidth - splitterEl.offsetWidth);
    localPaneEl.style.flex = `0 0 ${Math.round((available * state.splitPercent) / 100)}px`;
  }

  splitterEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    splitterEl.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (event) => {
      const rect = panesEl.getBoundingClientRect();
      const available = Math.max(1, rect.width - splitterEl.offsetWidth);
      const localWidth = event.clientX - rect.left;
      state.splitPercent = Math.min(85, Math.max(15, (localWidth / available) * 100));
      applySplitPercent();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      splitterEl.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      savePrefs();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  applySplitPercent();
  window.addEventListener('resize', applySplitPercent);

  // ---- 우클릭 메뉴 ----------------------------------------------------------
  let menuEl = null;
  function hideMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }
  function showMenu(x, y, items) {
    hideMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'ctx-menu';
    for (const it of items) {
      if (it[0] === '__sep__') {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menuEl.appendChild(sep);
        continue;
      }
      const b = document.createElement('div');
      b.className = 'ctx-item';
      b.textContent = it[0];
      b.addEventListener('click', () => {
        hideMenu();
        it[1]();
      });
      menuEl.appendChild(b);
    }
    document.body.appendChild(menuEl);
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.max(2, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    menuEl.style.top = Math.max(2, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  }
  document.addEventListener('click', hideMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });

  // dataTransfer의 사용자 MIME 데이터가 비는 Chromium/WebView 환경을 위한 보조 상태.
  // 같은 webview 안의 두 패널 사이에서만 사용하며 dragend에서 즉시 폐기한다.
  let activeDragPayload = null;

  // ---- 패널 ------------------------------------------------------------------
  function makePane(name) {
    const root = document.querySelector('.pane[data-pane="' + name + '"]');
    const listEl = root.querySelector('.pane-list');
    const pathEl = root.querySelector('.pane-path');
    const footEl = root.querySelector('.pane-foot');
    const titleEl = root.querySelector('.pane-title');
    const st = state[name];
    let selectionMarquee = null;

    pathEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = pathEl.value.trim();
        if (v) post({ type: 'navigate', pane: name, path: v });
      }
    });

    root.querySelectorAll('.pane-tools button').forEach((b) => {
      b.addEventListener('click', () => {
        switch (b.dataset.act) {
          case 'up':
            post({ type: 'up', pane: name, sync: state.syncNav });
            break;
          case 'refresh':
            post({ type: 'refresh', pane: name });
            break;
          case 'mkdir':
            post({ type: 'mkdirRequest', pane: name });
            break;
          case 'pick':
            post({ type: 'pickLocalFolder' });
            break;
          case 'terminal':
            post({ type: 'openTerminalHere' });
            break;
        }
      });
    });

    root.querySelectorAll('.pane-cols span').forEach((c) => {
      c.addEventListener('click', () => {
        const key = c.dataset.sort;
        if (st.sortKey === key) st.sortAsc = !st.sortAsc;
        else {
          st.sortKey = key;
          st.sortAsc = true;
        }
        render(true);
      });
    });

    listEl.addEventListener('keydown', onListKey);
    listEl.addEventListener('contextmenu', (e) => {
      if (e.target !== listEl) return; // 빈 영역에서만
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        ['새 폴더', () => post({ type: 'mkdirRequest', pane: name })],
        ['새로고침', () => post({ type: 'refresh', pane: name })],
      ]);
    });
    listEl.addEventListener('dragover', (e) => {
      if (dragHasPayload(e)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        listEl.classList.add('drop-hover');
      }
    });
    listEl.addEventListener('dragleave', (e) => {
      if (!listEl.contains(e.relatedTarget)) listEl.classList.remove('drop-hover');
    });
    listEl.addEventListener('drop', (e) => {
      listEl.classList.remove('drop-hover');
      e.preventDefault();
      const payload = readPayload(e);
      if (!payload || payload.pane === name) return;
      e.stopPropagation();
      post({ type: 'transfer', from: payload.pane, names: payload.names });
    });

    function dragHasPayload(e) {
      return !!activeDragPayload || Array.from(e.dataTransfer.types || []).includes('application/x-vssh');
    }
    function readPayload(e) {
      let raw = e.dataTransfer.getData('application/x-vssh');
      if (!raw) {
        const plain = e.dataTransfer.getData('text/plain');
        if (plain && plain.startsWith('vssh:')) raw = plain.slice(5);
      }
      if (!raw) return activeDragPayload;
      try {
        const p = JSON.parse(raw);
        return p && (p.pane === 'local' || p.pane === 'remote') && Array.isArray(p.names) && p.names.length ? p : null;
      } catch (_) {
        return activeDragPayload;
      }
    }

    function beginSelectionMarquee(e) {
      if (e.button !== 0 || e.target !== listEl) return;
      e.preventDefault();
      listEl.focus();

      const rect = listEl.getBoundingClientRect();
      const box = document.createElement('div');
      box.className = 'selection-marquee';
      listEl.appendChild(box);
      selectionMarquee = {
        startX: e.clientX - rect.left + listEl.scrollLeft,
        startY: e.clientY - rect.top + listEl.scrollTop,
        base: e.ctrlKey || e.metaKey ? new Set(st.selected) : new Set(),
        box,
      };
      st.selected = new Set(selectionMarquee.base);
      st.anchor = -1;
      applySelectionClasses();
      document.body.style.userSelect = 'none';
    }

    function updateSelectionMarquee(e) {
      if (!selectionMarquee) return;
      if (!(e.buttons & 1)) {
        finishSelectionMarquee();
        return;
      }

      const rect = listEl.getBoundingClientRect();
      if (e.clientY < rect.top + 24) listEl.scrollTop -= 12;
      else if (e.clientY > rect.bottom - 24) listEl.scrollTop += 12;

      const viewX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const viewY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
      const currentX = viewX + listEl.scrollLeft;
      const currentY = viewY + listEl.scrollTop;
      const left = Math.min(selectionMarquee.startX, currentX);
      const top = Math.min(selectionMarquee.startY, currentY);
      const right = Math.max(selectionMarquee.startX, currentX);
      const bottom = Math.max(selectionMarquee.startY, currentY);

      Object.assign(selectionMarquee.box.style, {
        left: left + 'px',
        top: top + 'px',
        width: right - left + 'px',
        height: bottom - top + 'px',
      });

      st.selected = new Set(selectionMarquee.base);
      listEl.querySelectorAll('.row[data-name]').forEach((row) => {
        const rowLeft = row.offsetLeft;
        const rowTop = row.offsetTop;
        const intersects = rowLeft < right && rowLeft + row.offsetWidth > left && rowTop < bottom && rowTop + row.offsetHeight > top;
        if (intersects) st.selected.add(row.dataset.name);
      });
      applySelectionClasses();
    }

    function finishSelectionMarquee() {
      if (!selectionMarquee) return;
      selectionMarquee.box.remove();
      selectionMarquee = null;
      document.body.style.userSelect = '';
    }

    listEl.addEventListener('mousedown', beginSelectionMarquee);
    document.addEventListener('mousemove', updateSelectionMarquee);
    document.addEventListener('mouseup', finishSelectionMarquee);

    function visibleEntries() {
      let arr = st.entries;
      if (!state.showHidden) arr = arr.filter((e) => !e.name.startsWith('.'));
      arr = arr.slice();
      const dir = st.sortAsc ? 1 : -1;
      arr.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        if (st.sortKey === 'size') return dir * ((a.size || 0) - (b.size || 0));
        if (st.sortKey === 'mtime') return dir * ((a.mtime || 0) - (b.mtime || 0));
        if (st.sortKey === 'mode') return dir * ((a.mode || 0) - (b.mode || 0));
        return dir * a.name.localeCompare(b.name, 'ko');
      });
      return arr;
    }

    function renderFoot() {
      const n = st.selected.size;
      const total = visibleEntries().length;
      footEl.textContent = n ? n + '개 선택 · ' + total + '개 표시' : total + '개 항목';
    }

    function applySelectionClasses() {
      listEl.querySelectorAll('.row[data-name]').forEach((r) => {
        r.classList.toggle('selected', st.selected.has(r.dataset.name));
      });
      renderFoot();
    }

    function onRowClick(e, rows, idx) {
      listEl.focus();
      const nm = rows[idx].name;
      if (e.ctrlKey || e.metaKey) {
        if (st.selected.has(nm)) st.selected.delete(nm);
        else st.selected.add(nm);
        st.anchor = idx;
      } else if (e.shiftKey && st.anchor >= 0) {
        const lo = Math.min(st.anchor, idx);
        const hi = Math.max(st.anchor, idx);
        st.selected = new Set(rows.slice(lo, hi + 1).map((r) => r.name));
      } else {
        st.selected = new Set([nm]);
        st.anchor = idx;
      }
      applySelectionClasses();
    }

    function onListKey(e) {
      if (e.key === 'Backspace') {
        e.preventDefault();
        post({ type: 'up', pane: name, sync: state.syncNav });
      } else if (e.key === 'Delete' && st.selected.size) {
        e.preventDefault();
        post({ type: 'deleteRequest', pane: name, names: Array.from(st.selected) });
      } else if (e.key === 'F2' && st.selected.size === 1) {
        e.preventDefault();
        post({ type: 'renameRequest', pane: name, name: Array.from(st.selected)[0] });
      } else if (e.key === 'Enter' && st.selected.size === 1) {
        e.preventDefault();
        openByName(Array.from(st.selected)[0]);
      }
    }

    function openByName(nm) {
      const entry = st.entries.find((x) => x.name === nm);
      if (!entry) return;
      if (entry.isSymbolicLink && !entry.isDirectory) post({ type: 'openSymlink', pane: name, name: nm });
      else if (entry.isDirectory) post({ type: 'enter', pane: name, name: nm, sync: state.syncNav });
      else post({ type: 'open', pane: name, name: nm });
    }

    function onRowContext(e, rows, idx) {
      e.preventDefault();
      e.stopPropagation();
      const entry = rows[idx];
      if (!st.selected.has(entry.name)) {
        st.selected = new Set([entry.name]);
        st.anchor = idx;
        applySelectionClasses();
      }
      const sel = Array.from(st.selected);
      const items = [];
      if (name === 'local') {
        items.push(['원격으로 업로드', () => post({ type: 'transfer', from: 'local', names: sel })]);
        if (!entry.isDirectory) items.push(['열기', () => post({ type: 'open', pane: name, name: entry.name })]);
      } else {
        items.push(['로컬로 다운로드', () => post({ type: 'transfer', from: 'remote', names: sel })]);
        if (!entry.isDirectory) items.push(['편집기로 열기', () => post({ type: 'open', pane: name, name: entry.name })]);
      }
      items.push(['__sep__']);
      if (sel.length === 1) items.push(['이름 변경', () => post({ type: 'renameRequest', pane: name, name: entry.name })]);
      items.push(['삭제', () => post({ type: 'deleteRequest', pane: name, names: sel })]);
      items.push(['새 폴더', () => post({ type: 'mkdirRequest', pane: name })]);
      if (name === 'remote') items.push(['여기로 터미널 이동', () => post({ type: 'openTerminalHere' })]);
      showMenu(e.clientX, e.clientY, items);
    }

    function render(preserveScroll) {
      const scroll = preserveScroll ? listEl.scrollTop : 0;
      titleEl.textContent =
        name === 'local' ? '로컬' : state.connected ? '원격 · ' + (state.sessionLabel || '') : '원격 (연결 안 됨)';
      if (document.activeElement !== pathEl) pathEl.value = st.path;

      root.querySelectorAll('.pane-cols span').forEach((c) => {
        const on = c.dataset.sort === st.sortKey;
        c.classList.toggle('sorted', on);
        c.dataset.dir = on ? (st.sortAsc ? '▲' : '▼') : '';
      });

      listEl.innerHTML = '';

      if (st.error) {
        const d = document.createElement('div');
        d.className = 'pane-error';
        d.textContent = st.error;
        listEl.appendChild(d);
        footEl.textContent = '';
        return;
      }

      const up = document.createElement('div');
      up.className = 'row up';
      up.innerHTML = '<span class="c-name">📁 ..</span><span class="c-size"></span><span class="c-mtime"></span><span class="c-mode"></span>';
      up.addEventListener('dblclick', () => post({ type: 'up', pane: name, sync: state.syncNav }));
      listEl.appendChild(up);

      const rows = visibleEntries();
      rows.forEach((entry, idx) => {
        const row = document.createElement('div');
        row.className = 'row' + (st.selected.has(entry.name) ? ' selected' : '');
        row.dataset.name = entry.name;
        row.draggable = true;
        const icon = entry.isDirectory ? '📁' : entry.isSymbolicLink ? '🔗' : '📄';
        row.innerHTML =
          '<span class="c-name">' + icon + ' ' + escapeHtml(entry.name) + '</span>' +
          '<span class="c-size">' + (entry.isDirectory ? '' : fmtSize(entry.size)) + '</span>' +
          '<span class="c-mtime">' + fmtTime(entry.mtime) + '</span>' +
          '<span class="c-mode">' + fmtMode(entry.mode) + '</span>';
        row.addEventListener('click', (e) => onRowClick(e, rows, idx));
        row.addEventListener('dblclick', () => openByName(entry.name));
        row.addEventListener('contextmenu', (e) => onRowContext(e, rows, idx));
        row.addEventListener('dragstart', (e) => {
          if (!st.selected.has(entry.name)) {
            st.selected = new Set([entry.name]);
            st.anchor = idx;
            applySelectionClasses();
          }
          activeDragPayload = { pane: name, names: Array.from(st.selected) };
          const serialized = JSON.stringify(activeDragPayload);
          e.dataTransfer.effectAllowed = 'copy';
          e.dataTransfer.setData('application/x-vssh', serialized);
          e.dataTransfer.setData('text/plain', 'vssh:' + serialized);
        });
        row.addEventListener('dragend', () => {
          activeDragPayload = null;
          listEl.classList.remove('drop-hover');
          document.querySelectorAll('.row.drop-target').forEach((r) => r.classList.remove('drop-target'));
        });
        if (entry.isDirectory) {
          row.addEventListener('dragover', (e) => {
            if (dragHasPayload(e)) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'copy';
              row.classList.add('drop-target');
            }
          });
          row.addEventListener('dragleave', (e) => {
            if (!row.contains(e.relatedTarget)) row.classList.remove('drop-target');
          });
          row.addEventListener('drop', (e) => {
            row.classList.remove('drop-target');
            e.preventDefault();
            e.stopPropagation();
            const payload = readPayload(e);
            if (!payload || payload.pane === name) return;
            post({ type: 'transfer', from: payload.pane, names: payload.names, intoDir: entry.name });
          });
        }
        listEl.appendChild(row);
      });

      listEl.scrollTop = scroll;
      renderFoot();
    }

    return {
      render,
      update(msg) {
        if (msg.path) st.path = msg.path;
        st.error = msg.error || null;
        st.entries = msg.entries || [];
        st.selected = new Set();
        st.anchor = -1;
        render(false);
      },
    };
  }

  const panes = { local: makePane('local'), remote: makePane('remote') };

  // ---- 파일 전송 및 동기 탐색 ------------------------------------------------
  document.getElementById('toRemote').addEventListener('click', () => {
    const names = Array.from(state.local.selected);
    if (names.length) post({ type: 'transfer', from: 'local', names });
  });
  document.getElementById('toLocal').addEventListener('click', () => {
    const names = Array.from(state.remote.selected);
    if (names.length) post({ type: 'transfer', from: 'remote', names });
  });
  function toggleSynchronizedNavigation() {
    state.syncNav = !state.syncNav;
    savePrefs();
  }
  function toggleHiddenFiles() {
    state.showHidden = !state.showHidden;
    savePrefs();
    panes.local.render(true);
    panes.remote.render(true);
  }
  // ---- 전송 큐 -------------------------------------------------------------
  const queueEl = document.getElementById('queue');
  const queueListEl = document.getElementById('queueList');
  const queueSummaryEl = document.getElementById('queueSummary');
  const queueHandleEl = document.getElementById('queueHandle');
  let lastQueueItems = [];

  function queueMax() {
    return Math.max(80, Math.floor(window.innerHeight * 0.85));
  }
  function applyQueueHeight() {
    state.queueHeight = Math.min(queueMax(), Math.max(60, state.queueHeight));
    queueEl.style.height = state.queueHeight + 'px';
  }
  function applyQueueVisibility() {
    queueEl.classList.toggle('hidden', !state.queueVisible);
    if (state.queueVisible) applyQueueHeight();
  }
  function setQueueVisible(v) {
    state.queueVisible = v;
    savePrefs();
    applyQueueVisibility();
    if (v) renderQueue(lastQueueItems);
  }
  applyQueueVisibility();

  document.getElementById('queueToggle').addEventListener('click', () => setQueueVisible(false));
  document.getElementById('queueClear').addEventListener('click', () => post({ type: 'queueClear' }));
  document.getElementById('queueCancel').addEventListener('click', () => post({ type: 'queueCancel' }));

  // 상단 손잡이를 드래그해서 전송 목록 높이 조절
  queueHandleEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = queueEl.getBoundingClientRect().height;
    queueHandleEl.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
      state.queueHeight = Math.min(queueMax(), Math.max(60, startH + (startY - ev.clientY)));
      queueEl.style.height = state.queueHeight + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      queueHandleEl.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      savePrefs();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  window.addEventListener('resize', () => {
    if (state.queueVisible) applyQueueHeight();
  });

  function qStat(i) {
    if (i.status === 'error') return '실패';
    if (i.status === 'done') return '완료';
    if (i.status === 'canceled') return '취소';
    if (i.status === 'active') return fmtSize(i.transferred) + ' / ' + fmtSize(i.size);
    return '대기';
  }

  function renderQueue(items) {
    const active = items.filter((i) => i.status === 'active' || i.status === 'queued').length;
    const done = items.filter((i) => i.status === 'done').length;
    const failed = items.filter((i) => i.status === 'error').length;
    let total = 0;
    let moved = 0;
    for (const i of items) {
      total += i.size || 0;
      moved += (i.status === 'done' ? i.size : i.transferred) || 0;
    }
    const pct = total ? Math.floor((moved / total) * 100) : 0;
    queueSummaryEl.textContent = !items.length
      ? '전송 없음'
      : active
      ? '전송 중 ' + active + '개 · ' + pct + '%'
      : '완료 ' + done + '개' + (failed ? ' · 실패 ' + failed + '개' : '');

    queueListEl.innerHTML = '';
    for (const i of items.slice().reverse()) {
      const row = document.createElement('div');
      row.className = 'q-row q-' + i.status;
      const p = i.size ? Math.min(100, Math.floor((i.transferred / i.size) * 100)) : i.status === 'done' ? 100 : 0;
      const cancelable = i.status === 'active' || i.status === 'queued';
      row.innerHTML =
        '<span class="q-dir">' + (i.direction === 'upload' ? '▲' : '▼') + '</span>' +
        '<span class="q-label">' + escapeHtml(i.label) + '</span>' +
        '<span class="q-bar"><span class="q-fill" style="width:' + p + '%"></span></span>' +
        '<span class="q-stat">' + qStat(i) + '</span>' +
        '<span class="q-cancel">' + (cancelable ? '✕' : '') + '</span>';
      if (i.error) row.title = i.error;
      if (cancelable) {
        row.querySelector('.q-cancel').addEventListener('click', () => post({ type: 'queueCancelItem', id: i.id }));
      }
      queueListEl.appendChild(row);
    }
  }

  // ---- 확장 -> 웹뷰 메시지 --------------------------------------------------
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'state':
        state.connected = !!msg.connected;
        state.sessionLabel = msg.sessionLabel || '';
        state.canEditRemote = !!msg.canEditRemote;
        if (msg.localPath) state.local.path = msg.localPath;
        if (msg.remotePath) state.remote.path = msg.remotePath;
        panes.local.render(true);
        panes.remote.render(true);
        break;
      case 'list':
        if (panes[msg.pane]) panes[msg.pane].update(msg);
        break;
      case 'queue':
        lastQueueItems = msg.items || [];
        // 숨겨진 전송 목록의 전체 DOM을 진행 이벤트마다 다시 만들지 않는다.
        if (state.queueVisible) renderQueue(lastQueueItems);
        break;
      case 'toggleHidden':
        toggleHiddenFiles();
        break;
      case 'toggleSync':
        toggleSynchronizedNavigation();
        break;
      case 'toggleQueue':
        setQueueVisible(!state.queueVisible);
        break;
    }
  });

  post({ type: 'ready' });
})();
