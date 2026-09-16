# 추가 개발 11 — DeCom 읽기 전용 JAR VFS

JAR를 Explorer에서 펼칠 때 전체 내용을 디스크 캐시로 추출하던 구현을 읽기 전용 가상 파일 시스템으로
교체했다. 열람이 목적이므로 편집, JAR 재생성, 원본 백업 기능은 UI와 명령 등록에서 비활성화했다.

## 동작

- 로컬 `.jar`를 펼치면 ZIP central directory만 읽어 메모리에 가상 디렉터리 트리를 만든다.
- 각 파일의 내용은 사용자가 실제로 열 때 해당 ZIP entry의 스트림만 읽는다.
- JAR 안의 JAR는 바깥 JAR를 펼칠 때 읽지 않는다. 중첩 JAR 노드를 펼치는 순간에만 그 entry를 메모리로
  읽고 별도 인덱스를 만든다.
- `.class`를 열면 CFR가 경로 입력을 요구하므로 선택한 클래스와 같은 outer/inner class 묶음만 임시
  디렉터리에 기록한다. 디컴파일이 끝나거나 실패하면 즉시 삭제한다.
- 텍스트와 리소스는 VShoon의 일반 읽기 전용 편집기로 열린다. 가상 파일 시스템은 쓰기, 생성, 삭제,
  이름 변경을 모두 `NoPermissions`로 거부한다.
- 원본 JAR 변경을 감시하고 `Decom: JAR 새로고침` 명령으로 메모리 인덱스와 클래스 소스 캐시를 버린다.

## 구조

```text
기본 Explorer
└─ sample.jar                         file: 원본 JAR
   ├─ BOOT-INF                        vshoon-jar: 가상 디렉터리
   │  ├─ classes/example/App.class    선택 시 클래스 묶음만 임시 기록 → CFR → 삭제
   │  └─ lib/dependency.jar           펼칠 때만 entry를 읽어 별도 VFS 인덱스 생성
   └─ application.yml                 열 때 해당 entry만 스트리밍
```

`JarFileSystemProvider`가 `vshoon-jar:` 스킴의 `stat`, `readDirectory`, `readFile`을 제공한다. 로컬 JAR는
`yauzl.open`으로 파일 핸들과 인덱스만 유지한다. 중첩 JAR는 로컬 경로가 없으므로 해당 entry 바이트만
메모리에 올린 뒤 `yauzl.fromBuffer`로 인덱싱한다. Explorer core의 VSH-0016 seam은 이 URI를 그대로
자식 모델에 연결하며 ZIP 처리와 보안 검증에는 관여하지 않는다.

## 안전 제한

- 절대 경로, 드라이브 경로, `..`, NUL이 포함된 entry는 가상 트리에서 제외한다.
- JAR 하나의 entry 수는 250,000개로 제한한다.
- 한 entry의 읽기는 압축 해제 후 512MB로 제한한다.
- 파일 시스템 제공자를 `isReadonly`로 등록하고 모든 변경 API를 거부한다.
- `.class` Webview는 스크립트를 허용하지 않고 디컴파일 결과를 HTML escape한 뒤 표시한다.

## 편집 기능 보류

기존 추출·재패키징 코드는 향후 검토를 위해 소스에 남겨 두었지만 확장에서 등록하지 않는다.
`decom.saveToJar`, 마운트 해제 명령, 저장 확인 설정과 Explorer 메뉴는 노출되지 않는다. 따라서 열람 중
원본 JAR를 바꾸거나 `.decom-bak`을 만들지 않는다.

## 검증

| 항목 | 명령 | 결과 |
| --- | --- | --- |
| Decom 컴파일·단위 테스트 | `VSHOON_TEST_CFR_PATH=... npm run test:decom` | 26개 통과, 실제 CFR 포함 |
| 제품 소스 트랜스파일 | `npm run transpile` | 통과 |
| 전체 개발 빌드 | `npm run build` | 통과, Decom 포함 모든 확장 0 errors |
| 데스크톱 smoke | `npm run smoke:decom` | 통과 — VFS 계층, 중첩 JAR, 클래스 열람, 읽기 전용, 원본 불변, 전체 추출·백업 없음 |
| 제품 단위 테스트 | `npm --ignore-scripts test` | 48개 통과 |
| Explorer 모델 브라우저 테스트 | `node scripts/core-exec.mjs run test-browser-no-install -- --browser chromium --sequential --run src/vs/workbench/contrib/files/test/browser/explorerModel.test.ts` | 11개 통과 |
| 타입 검사·린트 | `npm run typecheck`, `npm run lint` | 통과 |
| 계층 검사 | `npm run layers` | DeCom 신규 위반 없음; 기존 `vshoonFileDialog.ts`의 6개 위반으로 명령은 실패 |
| 오버레이·패치 동기화 | `npm run sync:check -- --offline` | 530개 파일 동기화, 통과 |

패키징은 프로젝트 지침에 따라 실행하지 않는다.

## 남은 범위

> 후속 변경: `Development.md` 12번에서 `.class` Webview를 읽기 전용 Java 문서로 교체하고 영속
> 사전 디컴파일 캐시, VSearch 검색, 제한된 선언 이동을 추가했다. 현재 동작은
> [DeCom 고도화2 구현 기록](additional-development-12.md)을 기준으로 한다.

- 대응하는 `-sources.jar` 자동 탐색과 원본 소스 우선 표시는 아직 제공하지 않는다.
- 디컴파일 결과는 읽기 전용 Webview이므로 Java language server 기반 선언 이동, 사용처 검색, PSI 수준의
  분석은 제공하지 않는다.
- 매우 큰 중첩 JAR는 펼칠 때 해당 JAR 하나를 메모리에 읽는다. 로컬 최상위 JAR는 전체를 메모리에 읽지 않는다.
