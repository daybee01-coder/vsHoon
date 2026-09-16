# 추가 개발 9 — Decom 재정의: JAR를 폴더로 여는 것

> 이 문서의 워크스페이스 폴더 마운트 방식은 [추가 개발 10](additional-development-10.md)이 대체한다.
> JAR 저장, 백업, 매니페스트 보존과 `.class` 즉시 열람 규칙은 그대로 유효하다.

8차에서 만든 "열 때 JAR 전체를 CFR로 미리 디컴파일해 `.java` 스냅샷을 보여주기"를 되돌린다. 소스를
고치지 않으므로 생성할 이유가 없고, 그 대신 JAR가 폴더처럼 열리고 내부 파일을 고쳐 다시 하나의 JAR로
묶는 것이 이 확장의 일이다.

## 동작

- 탐색기에서 JAR를 열면 별도 조작 없이 추출된 내용이 워크스페이스 폴더로 붙고 탐색기에서 바로 펼쳐진다.
  JAR는 편집기로 열리지 않는다 — 더블클릭을 가로채는 커스텀 편집기는 마운트를 시작한 뒤 곧바로 닫힌다.
- `.class`는 열람할 때만 CFR로 디컴파일해 읽기 전용으로 보여준다. `.java` 파일은 어디에도 생성하지 않는다.
- 내부 파일(리소스, 중첩 라이브러리 등)을 고치고 `Decom: 변경사항을 JAR에 저장`을 실행하면 폴더 전체를
  다시 하나의 JAR로 묶는다. 원본은 최초 1회 `<이름>.jar.decom-bak`으로 백업한다.
- 저장할 때 `META-INF/MANIFEST.MF`를 항상 맨 앞에 쓴다. 매니페스트의 내용과 위치가 모두 보존된다.
- 새 설정 `decom.save.confirm`(기본 켜짐)을 끄면 저장 확인 대화상자 없이 바로 저장한다. 백업은 그대로 한다.

## 매니페스트가 깨지던 문제

저장이 만든 JAR는 `java -jar`로는 실행됐지만 `JarInputStream.getManifest()`가 `null`을 돌려줬다. 두 가지가
겹친 결과다. 파일 시스템을 훑은 순서대로 항목을 넣었고, 그마저도 adm-zip이 저장 시 이름순으로 다시
정렬해 `META-INF/`가 알파벳순으로 뒤로 밀렸다.

`java -jar`는 central directory로 항목을 찾기 때문에 이 상태에서도 동작한다. 반면 `JarInputStream`은
앞에서부터 훑으며 매니페스트가 맨 앞에 없으면 매니페스트가 없는 JAR로 취급한다. Spring Boot 로더,
`jarsigner`, java agent가 그 경로를 쓴다. 즉 "실행은 되는데 매니페스트를 못 읽는" JAR가 만들어지고 있었다.

고친 방법은 두 가지다. adm-zip을 `noSort`로 열어 우리가 정한 순서를 쓰게 하고, `rebuildEntryRank`로
`META-INF/`와 `META-INF/MANIFEST.MF`를 앞으로 보낸다.

## 되돌린 것

- `src/jarSources.ts`(전체 JAR 디컴파일, `decom-source` 읽기 전용 파일 시스템)를 삭제했다.
- `cfr.ts`의 `decompileJar`(JAR 하나를 한 번의 JVM 호출로 디컴파일)를 삭제했다. 단일 `.class`
  디컴파일(`decompileSingleClass`)은 그대로 쓴다.
- 매니페스트의 `sourceDirectory` 필드, `onFileSystem:decom-source` 활성화 이벤트, 소스 폴더 마운트를
  없앴다. JAR 하나는 폴더 루트 하나로 붙는다.
- 8차에서 넣은 취소 처리(`runJava`의 토큰 확인)와 워크스페이스 폴더 갱신 재시도(`setWorkspaceFolders`)는
  단일 클래스 디컴파일과 마운트/해제에도 그대로 필요하므로 남겼다.

## 검증

| 항목 | 명령 | 결과 |
| --- | --- | --- |
| Decom 확장 컴파일·단위 테스트 | `npm run test:decom` | 25개 통과 (`VSHOON_TEST_CFR_PATH` 지정, 실제 CFR 포함) |
| Decom 데스크톱 스모크 | `npm run smoke:decom` | 통과 |
| 코어 타입 검사 | `npm run typecheck` | 통과 |
| VShoon 소스 린트 | `npm run lint` | 통과 |
| VShoon 단위 테스트 | `npm --ignore-scripts test` | 47개 통과 |
| 오버레이·패치 동기화 | `npm run sync:check -- --offline` | 527개 파일 동기화, 통과 |
| 시작 창 데스크톱 스모크 | `npm run smoke:start-window` | 재구성 후 연속 6회 통과 |

`npm run layers`는 기존 `src/vs/vshoon/browser/fileDialog/vshoonFileDialog.ts`의
`INativeEnvironmentService` 참조를 보고해 실패한다. 이번 변경에서 추가된 계층 위반은 아니다.

이번 작업 중 시작 창 스모크가 절반 가까이 실패하는 것을 발견해 CLI 핸드오프 의존을 걷어냈다. 원인과
재구성 내용은 [추가 개발 8의 정정](additional-development-08.md#정정--시작-창-스모크의-cli-단계)에 적었다.

데스크톱 스모크가 확인하는 것: JAR를 열면 폴더로 붙고 편집기 탭이 남지 않는다, 마운트된 폴더에
`.java`가 없다, `.class`가 뷰어로 열린다, 리소스를 고쳐 저장하면 원본이 백업되고 JAR가 다시 묶인다,
저장된 JAR를 `JarInputStream`으로 읽어 `Main-Class`와 사용자 정의 헤더가 그대로 나온다, `java -jar`로
실행된다, 마운트를 해제하면 폴더가 사라진다.

### 하지 않은 것

- 서명된 JAR는 다루지 않는다. 내용이 바뀌면 `META-INF/*.SF`의 다이제스트가 어긋나므로 서명은 어차피
  무효가 된다. 서명 파일을 지우거나 다시 서명하지 않고 그대로 둔다.
- 탐색기 트리 안에서 JAR 노드가 제자리에서 펼쳐지지는 않는다. VS Code 표준 탐색기는 파일 노드를 펼칠 수
  없어, 워크스페이스 폴더 루트로 붙이는 방식을 쓴다.
- 폴더가 하나뿐인 워크스페이스에 마운트하면 VS Code가 untitled 워크스페이스로 전환한다 — 8차 기록 참고.
- 패키지 빌드와 패키징 후 스모크는 실행하지 않았다. 대형 JAR, 긴 Windows 경로, 중첩 JAR 재열기는
  확인하지 않았다.
