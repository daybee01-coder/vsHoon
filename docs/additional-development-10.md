# 추가 개발 10 — 기본 Explorer에서 JAR 바로 펼치기

> 이 문서는 10차 구현 당시의 물리 캐시·편집 동작을 기록한다. 현재 동작은 11차의
> [읽기 전용 JAR VFS](additional-development-11.md)로 대체되었으며 전체 압축 해제, 편집, 재패키징,
> `.decom-bak` 백업은 비활성화되어 있다.

9차의 JAR 캐시 폴더를 `workspaceFolders`에 추가하는 방식을 없애고, IntelliJ의 External Libraries와
비슷하게 기존 JAR 파일 노드 아래에서 내용을 바로 탐색한다.

## 동작

- 로컬 `.jar` 파일은 기본 Explorer에서 펼칠 수 있는 파일로 표시된다.
- JAR 행을 더블클릭하거나 펼치기 화살표를 누르면 bundled Decom 확장이 내부 캐시를 준비하고, 그 내용을
  같은 JAR 노드 아래에 표시한다. JAR 편집기 탭은 열리지 않는다.
- 캐시는 확장의 global storage에 있으며 워크스페이스 폴더 목록에는 추가되지 않는다. 따라서 JAR를
  펼쳐도 multi-root 또는 untitled workspace로 바뀌지 않는다.
- `.class`는 기존과 같이 열람할 때 CFR로 디컴파일해 읽기 전용으로 표시한다. `.java` 파일은 생성하지 않는다.
- 텍스트, 리소스, 중첩 라이브러리는 실제 캐시 파일로 열리며 수정할 수 있다. JAR 파일의 컨텍스트 메뉴에서
  저장하면 원본을 최초 한 번 `.decom-bak`으로 백업하고 캐시 전체를 하나의 JAR로 다시 묶는다.
- `META-INF/MANIFEST.MF` 선두 배치, 원자적 교체, 중첩 JAR 무압축 저장 규칙은 그대로 유지한다.
- JAR 안의 JAR도 다시 펼칠 수 있다. 중첩 JAR를 먼저 저장한 다음 바깥 JAR를 저장하면 변경이 단계적으로 반영된다.

## 구조

```text
기본 Explorer
└─ sample.jar                 file: 원본 JAR
   ├─ META-INF                file: Decom 캐시 디렉터리
   │  └─ MANIFEST.MF          file: Decom 캐시 파일
   ├─ example
   │  └─ App.class
   └─ resource.txt
```

Explorer는 `.jar` 파일을 만났을 때 `decom.resolveExplorerJar` 내부 명령으로 캐시 루트만 요청한다.
ZIP 추출, 경로 검증, 캐시 수명주기와 저장은 `extensions/vshoon-decom`이 소유한다. upstream Explorer
패치는 반환된 캐시 루트의 직계 자식을 JAR의 시각적 자식으로 연결하고, 내부 `.decom` 메타데이터만 숨긴다.
각 자식의 실제 URI는 캐시의 `file:` URI이므로 기존 텍스트 편집기와 파일 서비스를 그대로 사용한다.

## upstream 패치

VSH-0016은 다음 구현 지점과 회귀 테스트를 수정한다.

- `explorerViewer.ts`: 로컬 JAR를 펼칠 수 있는 항목으로 판정하고 Decom에 자식을 요청한다.
- `explorerView.ts`: JAR 열기 동작을 편집기 열기 대신 트리 확장으로 전환한다.
- `explorerModel.ts`: JAR의 시각적 자식이 모델 병합 후에도 실제 캐시 URI를 유지하게 한다.
- `explorerModel.test.ts`: `JAR/BOOT-INF/classes`처럼 깊은 폴더에서도 캐시 URI가 JAR 경로로 바뀌지 않는지 검사한다.

확장 명령이 없거나 캐시 준비가 실패하면 해당 JAR의 자식 목록만 비고 오류 알림이 표시된다. 일반 파일,
폴더, Remote URI와 기존 Workbench 열기 동작에는 영향을 주지 않는다.

## 검증

| 항목 | 명령 | 결과 |
| --- | --- | --- |
| Decom 확장 컴파일·단위 테스트 | `npm run test:decom` | 25개 통과, 실제 CFR 포함 |
| Explorer 모델 브라우저 단위 테스트 | `node scripts/core-exec.mjs run test-browser-no-install -- --browser chromium --sequential --run src/vs/workbench/contrib/files/test/browser/explorerModel.test.ts` | 11개 통과 |
| 코어 타입 검사 | `npm run typecheck` | 통과 |
| 계층 검사 | `npm run layers` | VSH-0016 신규 위반 없음; 기존 `vshoonFileDialog.ts`의 6개 위반으로 명령은 실패 |
| 오버레이·패치 동기화 | `npm run sync:check -- --offline` | 529개 파일 동기화, 통과 |
| 개발 빌드 | `npm run build` | 통과 |
| 기본 Explorer 데스크톱 smoke | `npm run smoke:decom` | 통과 — `BOOT-INF/classes` 탐색, 클래스 열람, 편집·저장·백업·실행 확인 |

## 제한

- 내부 캐시의 최상위 파일을 이름 변경하거나 이동할 때 Explorer의 파일 이벤트는 워크스페이스 밖 URI를
  자동 추적하지 못할 수 있다. 내용 편집과 JAR 재저장은 지원하며 구조 변경 후에는 Explorer 새로고침으로
  다시 표시할 수 있다.
- 서명된 JAR의 내용 변경은 기존 서명을 무효화한다. 자동 삭제 또는 재서명은 수행하지 않는다.
- 패키징은 프로젝트 지침에 따라 실행하지 않는다.
