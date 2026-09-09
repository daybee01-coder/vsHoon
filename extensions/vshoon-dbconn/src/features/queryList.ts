/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mapWithLimit } from '../util/async';

/**
 * 보관 폴더의 SQL 목록을 만드는 규칙.
 *
 * `vscode` 를 참조하지 않는다 — 폴더 열거와 메타데이터 조회만 넘겨받아
 * 걸러내기·동시성·정렬을 여기서 정한다. 그래야 `QueryStore` 를 띄우지 않고도
 * 동시 조회 수와 목록 순서를 테스트할 수 있다.
 */

/**
 * 동시에 여는 메타데이터 조회 수.
 *
 * 목록은 파일마다 `stat` 이 필요한데(열거 결과에는 수정 시각·크기가 없다)
 * 이전에는 한 번에 하나씩 순차로 기다렸다. 이 값은 순차 대기를 없애면서도
 * 파일이 많은 폴더에서 조회를 무제한으로 열지 않기 위한 한도이며,
 * **측정으로 정한 최적값이 아니다.**
 */
export const QUERY_STAT_CONCURRENCY = 8;

/** 폴더 열거 결과 한 줄. */
export interface QueryFolderEntry {
  name: string;
  isFile: boolean;
}

/** 목록에 필요한 파일 메타데이터. */
export interface QueryFileMeta {
  /** 마지막 수정 시각(ms). */
  modifiedAt: number;
  size: number;
}

export interface QueryListItem extends QueryFileMeta {
  /** 파일 이름 (확장자 포함). */
  name: string;
}

/** 목록이 필요한 만큼의 파일 시스템 동작. */
export interface QueryListSource {
  entries(): Promise<QueryFolderEntry[]>;
  stat(name: string): Promise<QueryFileMeta>;
}

/** 목록에 넣을 파일인지 — 폴더와 SQL 이 아닌 파일은 제외한다. */
export function isQueryFile(entry: QueryFolderEntry): boolean {
  return entry.isFile && entry.name.toLowerCase().endsWith('.sql');
}

/**
 * 보관된 SQL 목록을 최신 수정순으로 만든다.
 *
 * 조회가 실패한 파일은 목록에서 빠진다 — 열거와 조회 사이에 지워졌을 수 있고,
 * 그 한 건 때문에 목록 전체를 실패로 만들 이유가 없다.
 */
export async function collectQueryFiles(
  source: QueryListSource,
  concurrency: number = QUERY_STAT_CONCURRENCY,
): Promise<QueryListItem[]> {
  const names = (await source.entries()).filter(isQueryFile).map((entry) => entry.name);
  const items = await mapWithLimit(names, concurrency, async (name) => {
    try {
      const meta = await source.stat(name);
      return { name, modifiedAt: meta.modifiedAt, size: meta.size };
    } catch {
      return undefined;
    }
  });
  // 입력 순서가 유지되므로 수정 시각이 같은 파일들의 상대 순서는 열거 순서를 따른다.
  return items.filter((item): item is QueryListItem => item !== undefined)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}
