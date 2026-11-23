# Spring 실행·디버그

IntelliJ IDEA·Eclipse처럼 실행 구성 목록에서 Spring 애플리케이션을 실행, 디버그, 정지, 재시작한다.
`launch.json`을 직접 쓰지 않는다.

## 요구사항

- JDK. 실행 구성의 JDK 칸이 비어 있으면 Spring Boot는 Java 확장의 기본 JDK를, Maven은 `JAVA_HOME`을 쓴다.
- Spring Boot 실행과 모든 디버그: `redhat.java`와 `vscjava.vscode-java-debug` 확장. 없으면 설치를 안내한다.
- Maven 플러그인 실행: 프로젝트의 Maven 래퍼(`mvnw`), 없으면 `PATH`의 `mvn`. `vshoon.spring.maven.executable`로
  바꿀 수 있다.

## 실행 방식

| 종류 | 실행 | 디버그 |
| --- | --- | --- |
| Spring Boot | Java 디버거가 `@SpringBootApplication` main 클래스를 `noDebug`로 실행 | 같은 구성을 디버그 모드로 실행 |
| Spring (Maven) | pom.xml의 서버 플러그인 골(`jetty:run`, `tomcat7:run` 등), 없으면 Jetty 전체 좌표 골을 작업으로 실행 | `MAVEN_OPTS`에 JDWP 에이전트를 붙여 실행한 뒤 디버거가 자동으로 연결 |

- 프로파일은 Boot에 `--spring.profiles.active`, Maven에 `-Dspring.profiles.active`로 전달한다.
- 포트는 Boot에 `--server.port`, Maven에 플러그인이 읽는 속성(`jetty.http.port`, `jetty.port`,
  `maven.tomcat.port`, `cargo.servlet.port`)으로 전달한다. pom.xml 플러그인 설정에 포트를 숫자로 적었다면
  그 값이 우선한다.
- Maven 플러그인 서버는 Maven JVM 안에서 돌기 때문에 VM 옵션도 `MAVEN_OPTS`로 들어간다. 프로그램 인자 칸은
  `-Pdev` 같은 Maven 인자다.
- 디버그 중인 Maven 서버는 디버그 도구 모음의 정지로도 서버까지 정지한다.

## 화면

- 탐색기 하단의 **Spring 실행** 뷰: 실행 구성 목록, 실행 상태, 행마다 실행·디버그(실행 중에는 재시작·정지) 버튼,
  우클릭 메뉴의 편집·복제·삭제.
- 상태 표시줄: 선택한 실행 구성과 실행·디버그(실행 중에는 재시작·정지) 버튼.
- `@SpringBootApplication` 클래스의 `main` 위 CodeLens: 실행, 디버그. 구성이 없으면 만들어 저장한다.
- 실행 구성 편집은 모달 창으로 연다.

## 실행 구성 저장

워크스페이스 폴더의 `.vscode/vshoon-spring.json`에 저장한다. 프로젝트와 함께 커밋할 수 있다.

폴더를 열면 `pom.xml`을 찾아 Spring Boot main 클래스마다, 그리고 WAR 프로젝트마다 구성을
만든다. 이렇게 찾은 구성은 사용자가 편집하거나 추가하기 전까지 파일로 쓰지 않는다. 이미 파일이 있으면
**자동 탐지**는 없는 구성만 덧붙이고 기존 구성은 건드리지 않는다.

## 서버 플러그인이 없는 WAR

`<packaging>war</packaging>` 프로젝트는 pom.xml에 서버 플러그인이 없어도 자동 탐지한다. 플러그인 전체 좌표 골은
pom.xml의 플러그인 선언이나 `settings.xml`의 pluginGroup 없이 실행되므로 프로젝트를 고치지 않는다.

| 판별 | 골 | 비고 |
| --- | --- | --- |
| javax (Spring 5 이하) | `org.eclipse.jetty:jetty-maven-plugin:9.4.57.v20241219:run` | Servlet 3.1, Java 8 이상 |
| jakarta (Spring 6) | `org.eclipse.jetty.ee10:jetty-ee10-maven-plugin:12.0.25:run` | Servlet 6.0, Java 17 이상 |

jakarta 판별은 `jakarta.servlet` groupId 또는 Spring 버전 6 이상(`spring.version` 속성, `spring-*` 의존성 버전)이다.
Spring 버전을 부모 pom에서만 정하면 javax로 본다. 골은 `vshoon.spring.maven.javaxServerGoal`,
`vshoon.spring.maven.jakartaServerGoal` 설정이나 실행 구성 편집 창에서 바꿀 수 있다. Jetty의 컨텍스트 경로는 `/`다.

## 알려진 제약

- 멀티 모듈 프로젝트의 Maven 플러그인 실행은 해당 모듈 폴더에서 Maven을 실행한다. 다른 모듈에 의존하면 먼저
  `mvn install`이 필요하다.
