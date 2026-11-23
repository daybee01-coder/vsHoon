# Spring 실행·디버그 작업 기록

## 구현 범위

- 새 내장 확장 `extensions/vshoon-spring`. overlay 목록(`vshoon.lock.json`)과 빌드 등록 패치(VSH-0005)에 추가했다.
- 디버거는 만들지 않고 `vscjava.vscode-java-debug`의 `java` launch/attach를 쓴다. 없으면 설치를 안내한다.
- Spring Boot: `@SpringBootApplication` main 클래스를 `java` launch로 실행한다. 실행은 `noDebug`, 디버그는 일반 launch.
- 레거시 Spring: `jetty:run`/`tomcat7:run`/`tomcat:run`/`cargo:run`을 VS Code 작업으로 실행한다. Windows에서는
  사용자 기본 셸과 무관하게 `cmd.exe /d /c`로 실행한다. JVM 옵션·프로파일·포트·JDWP는 모두 `MAVEN_OPTS`로 넘겨
  셸의 인자 분리 규칙을 피한다. 디버그는 빈 포트에 JDWP(`suspend=n`)를 붙이고 `attach`의 `timeout`(120초)
  재시도로 서버 JVM이 뜨는 즉시 연결한다.
- 실행 상태는 디버그 구성의 `vshoonSpringConfigurationId` 속성과 작업 정의의 `configurationId`로 추적한다.
  Maven 디버그 세션을 정지하면 서버 작업도 함께 종료한다.
- 화면: 탐색기 하단 Spring 실행 뷰, 상태 표시줄 선택기·실행/디버그(실행 중 재시작/정지), main 메서드 CodeLens,
  실행 구성 편집 모달(`vshoon.ui.modalWebviews`, `680×660`).
- 저장: 워크스페이스 폴더의 `.vscode/vshoon-spring.json`. 자동 탐지 결과는 사용자가 바꾸기 전까지 파일로 쓰지 않는다.
  파일은 손으로 고칠 수 있으므로 읽을 때 항목마다 검증하고, 프로젝트 경로가 워크스페이스 밖을 가리키면 버린다.

- 서버 플러그인이 없는 WAR도 자동 탐지한다. 플러그인 전체 좌표 골(javax → Jetty 9.4.57, jakarta → Jetty 12.0.25 EE10)을
  쓰므로 pom.xml을 고치지 않는다. jakarta 판별은 `jakarta.servlet` groupId 또는 Spring 6 이상 버전.
  트리와 이름에는 `jetty:run`으로 줄여 표시한다(`goalLabel`). 두 골은 설정으로 바꿀 수 있다.

## 검증

- `npm run test:spring`
  - TypeScript 컴파일: 오류 0
  - 단위 테스트 17개 통과: pom 해석(Boot 부모, Jetty·Tomcat 플러그인, 주석 무시), main 클래스 판별, 실행 구성
    파일 검증·왕복, 환경 변수 파싱, Boot launch 구성, Maven 명령·`MAVEN_OPTS`, attach 구성, 인자 분리
- ESLint(`extensions/vshoon-spring`): TypeScript 오류 0. `media/form.js`는 `code-no-new-javascript-files` 규칙에
  걸린다. DBconn의 `media/*.js`와 같은 웹뷰 스크립트 방식이다.
- 서버 플러그인이 없는 Spring 5.3 MVC WAR(web.xml) 샘플을 컴파일된 확장 모듈이 만든 명령 그대로
  (`cmd.exe /d /c mvn org.eclipse.jetty:jetty-maven-plugin:9.4.57.v20241219:run`, `MAVEN_OPTS`에 JDWP·프로파일·포트)
  실행해 Jetty 기동, `GET /hello` → `hello profile=dev`(포트 18080), JDWP 포트 수신을 확인했다.
- `cmd.exe /d /c mvn -v`에 `MAVEN_OPTS`로 JDWP를 넘겨 Maven JVM이 `Listening for transport dt_socket`을 출력하는 것을 확인했다.
- 설치된 `vscode-java-debug` 0.60.0의 `attach`가 `timeout`을, `launch`가 `javaExec`·`env`·`cwd`를 지원하는 것을 확인했다.

## 남은 확인

- 실제 vs Hoon 빌드에서 Spring Boot·Jetty·Tomcat 7 프로젝트를 실행·디버그·정지·재시작하는 실사용 확인.
