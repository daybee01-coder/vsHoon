import * as vscode from 'vscode';
import type { CatalogSnapshot, ObjectKind } from '../types';

/**
 * Ctrl+Space 반복 입력에 따른 분류 순환.
 *
 * 같은 자리에서 Ctrl+Space 를 다시 누르면 다음 분류로 넘어간다.
 * 테이블 → 뷰 → 시퀀스 → 함수/프로시저 → … → 다시 처음.
 *
 * VS Code 는 "몇 번째 호출인지"를 알려 주지 않으므로 직접 센다.
 * 판단 기준은 **문서 + 오프셋 + 입력 중인 접두사가 모두 같은지**다.
 * 한 글자라도 치면 오프셋이 달라져 자동으로 처음으로 돌아간다 —
 * 사용자가 "타이핑을 이어 가는 중"과 "같은 자리를 다시 누른 것"을
 * 이 조건만으로 정확히 구분할 수 있다.
 */

export type CategoryId = ObjectKind | 'smart' | 'column' | 'keyword';

export interface Category {
  id: CategoryId;
  label: string;
}

/** 순환에서 항상 맨 앞에 오는 기본 분류 — 문맥에 맞춘 스마트 혼합. */
const SMART: Category = { id: 'smart', label: '문맥 추천' };

const CATEGORY_LABELS: Record<CategoryId, string> = {
  smart: '문맥 추천',
  column: '컬럼',
  table: '테이블',
  view: '뷰',
  'materialized-view': '구체화 뷰',
  sequence: '시퀀스',
  function: '함수',
  procedure: '프로시저',
  package: '패키지',
  synonym: '동의어',
  type: '타입',
  keyword: '키워드',
};

/**
 * 같은 위치의 재호출로 인정하는 시간 한계.
 * 이 시간이 지나면 "새로 부른 것"으로 보고 처음 분류로 되돌린다 —
 * 한참 뒤에 같은 자리를 눌렀는데 엉뚱한 분류가 나오면 혼란스럽다.
 */
const CYCLE_WINDOW_MS = 15_000;

/**
 * 연달아 들어온 중복 호출을 한 번으로 묶는 시간.
 * VS Code 가 한 번의 Ctrl+Space 에 provider 를 두 번 부르는 경우가 있어,
 * 그때 분류가 두 칸씩 건너뛰는 것을 막는다.
 */
const DEBOUNCE_MS = 120;

interface CycleState {
  uri: string;
  offset: number;
  prefix: string;
  index: number;
  at: number;
}

export class CompletionCycle {
  private state: CycleState | undefined;

  /**
   * 이번 호출에서 보여 줄 분류를 정한다.
   *
   * @param categories 이번 문맥에서 실제로 항목이 있는 분류들 (SMART 포함)
   */
  advance(
    document: vscode.TextDocument,
    offset: number,
    prefix: string,
    triggerKind: vscode.CompletionTriggerKind,
    categories: Category[],
  ): { category: Category; index: number; total: number } {
    const uri = document.uri.toString();
    const now = Date.now();
    const previous = this.state;

    const sameSpot =
      previous !== undefined &&
      previous.uri === uri &&
      previous.offset === offset &&
      previous.prefix === prefix &&
      now - previous.at < CYCLE_WINDOW_MS;

    let index: number;
    if (
      sameSpot &&
      // 트리거 문자(`.`)로 열린 목록은 순환 대상이 아니다 —
      // 점을 찍은 직후엔 컬럼만 보고 싶지 분류를 돌리고 싶지 않다.
      triggerKind === vscode.CompletionTriggerKind.Invoke &&
      now - previous.at > DEBOUNCE_MS
    ) {
      index = (previous.index + 1) % Math.max(1, categories.length);
    } else if (sameSpot) {
      index = previous.index;
    } else {
      index = 0;
    }

    // 분류 목록은 문맥에 따라 바뀔 수 있으니 범위를 다시 맞춘다.
    index = categories.length === 0 ? 0 : index % categories.length;

    this.state = { uri, offset, prefix, index, at: now };

    return {
      category: categories[index] ?? SMART,
      index,
      total: categories.length,
    };
  }

  reset(): void {
    this.state = undefined;
  }
}

/**
 * 현재 연결에서 실제로 제안할 것이 있는 분류만 추린다.
 *
 * 시퀀스가 없는 MySQL 연결에서 "시퀀스" 칸이 순환에 끼어 있으면
 * 빈 목록이 한 번 나왔다가 넘어가야 해서 성가시다.
 */
export function availableCategories(snapshot: CatalogSnapshot | undefined): Category[] {
  const categories: Category[] = [SMART];
  if (!snapshot) {
    return [...categories, category('keyword')];
  }

  const relationKinds = new Set(snapshot.tables.map((t) => t.kind));
  const objectKinds = new Set(snapshot.objects.map((o) => o.kind));

  // 순환 순서 — 자주 쓰는 것부터.
  const order: ObjectKind[] = [
    'table',
    'view',
    'materialized-view',
    'sequence',
    'function',
    'procedure',
    'package',
    'synonym',
    'type',
  ];

  for (const kind of order) {
    if (relationKinds.has(kind as never) || objectKinds.has(kind as never)) {
      categories.push(category(kind));
    }
  }

  categories.push(category('column'));
  categories.push(category('keyword'));
  return categories;
}

function category(id: CategoryId): Category {
  return { id, label: CATEGORY_LABELS[id] };
}
