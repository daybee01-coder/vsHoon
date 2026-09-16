
## 1. 추가개발2 [x]
- D:\project\vscode\DBconn
- 위 경로의 플러그인을 기본 플러그인으로 병합
- 플러그인의 커넥션 설정창이 새창으로 뜨는데 모달형태로 변경

## 2. 추가개발2 [x]
- D:\project\vscode\VSsh
- D:\project\vscode\VSearch
- 위 경로에 있는 플러그인도 동일하게 병합

## 3. 추가개발 [x]
- 윈도우 기본 파일 선택기를 사용하는데 현재 ui와 통일감있게 파일선택기 개발
- D:\project\vscode\Decom 플러그인도 기본 기능으로 병합

## 4. 추가개발 [보류]
- VSsh가 플러그인 상태로 써보니 몇가지 보안점 발생
- 터미널에서 블럭으로 드래그시 복사가 되지않고 우클릭 시 복사가됨 일반 ssh터미널과같이 드래그 또는 블럭 시 복사되고 우클릭으로 붙여넣기 되게해줘
- sftp에서 드레그앤 드랍으로 전송 시 전송 되지않는 버그 존재
- 터미널에서 로그를 tail 걸었을때 일정 라인이 넘어가면 더이상 위로 못올리는 상황 발생하여 보안

## 5. 추가개발 [x]
- vsHoon이 켜져있는동안 각 플로그인 별 모달 위치 이동시, 크기 조절 시 기억후 종료되면 리셋
- VSearch를 ctrl+shift+f로 변경(기존 검색 기능을 대체하는거임)
- 구현 범위·검증 결과·후속 코드 점검: [docs/code-review-2026-09-07.md](docs/code-review-2026-09-07.md)

## 6. 추가개발
- VSsh가 윈도우 탐색기와 드래그앤 드랍으로 파일 업/다운로드
- [x] 탐색기 → 패널: 원격 업로드와 로컬 복사. 실사용 확인 완료. (VSH-0012)
- [ ] 로컬 패널 → 탐색기: 네이티브 드래그. 구현·빌드·검사 완료, 실사용 확인 남음. (VSH-0013)
- [보류] 원격 패널 → 탐색기 직접 드래그.
  - Electron `webContents.startDrag`는 이미 존재하는 실경로(`CF_HDROP`)만 받는다. 원격 파일은
    드래그 시작 시점에 로컬에 없으므로 임시 폴더로 먼저 받아야 하고, 그 사이 사용자가 버튼을
    놓으면 드래그가 성립하지 않는다.
  - 네이티브 SFTP 클라이언트는 Windows 지연 렌더링(`IDataObject`의 `CFSTR_FILEDESCRIPTOR` +
    `CFSTR_FILECONTENTS`)으로 드롭 시점에 내려받는다. Electron은 이 경로를 노출하지 않는다.
  - 대안 후보: 단일 파일 한정 `DownloadURL` + 로컬 HTTP 서버(지연 다운로드, upstream 패치 불필요),
    또는 `IDataObject`를 구현하는 네이티브 애드온(비용 큼).
  - 우회로: 원격 → 로컬 패널로 끌어온 뒤 로컬 패널에서 탐색기로 끌어낸다.
- seam 기록: [docs/upstream-patches.md](docs/upstream-patches.md)의 VSH-0012, VSH-0013


## 7. 추가 개발 [x]
 - [x] 새 창을 누르면 콤팩트 시작 창 표시
 - [x] 프로그램 표시 이름을 `VShoon`에서 `vs Hoon`으로 변경

## 8. 기능 개선
 - 포터블과 설치 성능 차이 존재 유무
 - 로딩, 반응 미묘하게 vscode와 비교하면 느림
 - 전반적인 성능 개선 필요
 - 불필요한 동작이 있는 확인 필요
 - 개선점 바로 처리하지않고 가이드 작성 후 추후 진행할거니 가이드 파일 생성 후 작성
 - [x] 조사 및 가이드 작성: [성능 개선 가이드](docs/performance-improvement-guide.md)
 - [ ] 가이드 기반 성능 측정 및 개선 구현 (진행 중)
   - [x] 1차: SQL 초안 중복 텍스트 조회 제거 및 단위 테스트 — [작업 기록](docs/performance-improvement-01.md)
   - [x] 2차: 파일 선택창 조기 표시·요청 수명·행 리스너 정리 및 단위 테스트 — [작업 기록](docs/performance-improvement-02.md)
   - [x] 3차: VSearch 검색 범위 밖 미저장 문서 조회·전달 제거 — [작업 기록](docs/performance-improvement-03.md)
   - [x] 4차: SFTP 로컬 패널 목록의 stat 동시성 제한 및 단위 테스트 — [작업 기록](docs/performance-improvement-04.md)
   - [x] 5차: 쿼리 보관 목록의 순차 stat 제거 및 단위 테스트 — [작업 기록](docs/performance-improvement-05.md)
   - [x] 6차: JAR 작업의 데이터 보존 테스트 기준선 및 저장 결과 임시 파일 교체 — [작업 기록](docs/performance-improvement-06.md)
   - [ ] 동일 배포판 기준 A/B 측정 및 나머지 개선 후보 검증

## 8. 추가 개발

- 새창으로했을때 시작 워크벤치가 나오는데 왜 실행되는 ide는 기존 창으로 띄우고있어 ide도 새창으로 띄우게해줘
- jar 파일을 인텔리제이처럼 미리 디컴파일해서 폴더 형식처럼 자연스럽게 탐색할수있게해줘
- 재 컴파일하는기능은 유지해줘
- [x] 완료 — [작업 기록](docs/additional-development-08.md)

## 9. 추가 개발

- Decom에 대한 재정의
  1. 자바 소스 수정하지않음으로 자바로 디컴파일해서 자바 파일 생성하지않아도 됨
  2. class파일은 열람할수있어야함
  3. 별도의 동작 없이 jar파일은 폴더 열듯이 펼쳐지며 내부 파일 열람 가능해야함
  4. 내부 파일 수정(텍스트나 내부 lib파일 등)시 매니패스트가 깨지지않게해야함
  5. 내부 파일 수정 시 저장할때 다시 하나의 jar로 만들어져야함
  6. 기존 파일은 별도의 경로에 백업되야함
  7. jar파일은 메인 편집 화면으로 열리는게 아님
- [x] 완료 — [작업 기록](docs/additional-development-09.md)

## 10. 추가 개발

- [x] JAR를 워크스페이스에 마운트하지 않고 IntelliJ처럼 기본 Explorer의 파일 노드 아래에서 바로 펼쳐 보기
- [x] 완료 — [작업 기록](docs/additional-development-10.md)

## 11. DeCom 고도화
1. Jar를 폴더처럼 여는 것 — Virtual File System (VFS)

IntelliJ 플랫폼은 실제 OS 파일시스템 위에 자체 추상화 계층인 VFS(Virtual File System) 를 두고 있어요. 에디터, 프로젝트 트리, 인덱서 등 플랫폼 내부 로직은 전부 이 VFS를 통해서만 파일에 접근하고, 실제 디스크 I/O는 몰라도 돼요.

VirtualFileSystem은 여러 구현체를 가질 수 있는데, 그중 JarFileSystem (요즘은 ArchiveFileSystem을 상속) 이 있어요.
일반 파일은 file:// 프로토콜의 LocalFileSystem을 쓰지만, jar 안의 엔트리는 jar://some.jar!/com/foo/Bar.class 같은 형태의 URL로 표현돼요. !/ 뒤가 jar 내부 경로죠.
JarFileSystem은 내부적으로 java의 java.util.zip.ZipFile / JarFile을 이용해서 jar의 central directory(엔트리 목록)를 읽고, 이를 트리 구조의 VirtualFile 객체들로 매핑해요. 즉 압축을 풀어서 임시 디렉토리에 물리적으로 전개하는 게 아니라, zip 인덱스만 메모리에 캐싱해서 가상의 디렉토리 트리처럼 보여주는 것이에요.
프로젝트 트리(ProjectView)나 파일 선택 다이얼로그는 VirtualFile이 진짜 로컬 파일인지 jar 엔트리인지 신경 안 쓰고 동일한 API(getChildren(), getParent(), getInputStream() 등)로 다루기 때문에 사용자 입장에서는 폴더처럼 자연스럽게 느껴지는 거예요.
2. .class 파일을 "로딩 없이" 여는 것 — 디컴파일러 통합

여기서 "로딩 없이"라고 하신 게 아마 클래스로더를 통해 실제로 JVM에 로드하는 과정 없이 바로 소스처럼 보여준다는 뜻일 텐데, 이것도 별도 메커니즘이에요.

.class 파일을 열면 IntelliJ는 바이트코드를 파싱해서 디컴파일러(기본적으로 FernFlower, JetBrains가 관리하는 fork) 를 통해 즉석에서 Java 소스 형태로 재구성해요.
이건 FileEditorProvider/FileType 확장 메커니즘 덕분에 가능해요. IntelliJ는 파일 확장자·시그니처(.class 매직 넘버 CAFEBABE)를 보고 어떤 에디터로 열지 결정하는데, .class용 에디터 프로바이더가 "바이트코드 → PSI(Program Structure Interface) 트리 → 디컴파일된 텍스트" 파이프라인을 돌려요.
만약 해당 jar에 대응하는 sources jar(-sources.jar)가 있으면 그걸 우선 매핑해서 진짜 원본 소스를 보여주고, 없으면 디컴파일 결과를 보여줘요. 이 자동 매칭도 JarFileSystem 상의 경로 규칙과 라이브러리 설정(OrderRootType.SOURCES)을 이용해서 이뤄져요.
이렇게 만들어진 디컴파일 텍스트도 PSI로 파싱되기 때문에, 실제 소스 파일처럼 문법 하이라이팅, 네비게이션(Go to Declaration), Find Usages까지 다 동작하는 거고요.
정리하면
기능	핵심 구조
jar를 폴더처럼 탐색	VFS 추상화 + JarFileSystem(zip 인덱스만 파싱, 가상 트리 구성)
class 파일을 소스처럼 열람	FileType/EditorProvider 확장 + 바이트코드 디컴파일러(FernFlower) + PSI 통합

즉, "물리적으로 압축을 풀지 않고 가상 파일시스템으로 흉내내는 것"과 "바이트코드를 실행 가능한 형태로 로드하는 게 아니라 정적으로 파싱해 소스처럼 재구성하는 것", 이 두 축이 결합돼서 자연스러운 경험을 만들어내는 거예요.

- [x] JAR 전체를 풀지 않는 읽기 전용 VFS 탐색 구현
- [x] 중첩 JAR 지연 탐색과 `.class` 선택 디컴파일 구현
- [x] 편집·JAR 재생성·백업 기능 비활성화
- [x] 완료 — [작업 기록](docs/additional-development-11.md)


## 12. DeCom 고도화2
- 라인수 표시
- class파일 내에서 연결된 함수 찾아가기
- jar 내 class 파일 열릴때 디컴파일하는게 아니고 미리 디컴파일해서 캐싱하기
- jar 내 class파일도 캐싱되기에 검색결과에 포함되게
- [x] 구현 가이드 작성: [DeCom 고도화2 구현 가이드](docs/decom-enhancement-02-guide.md)
- [x] A단계: 읽기 전용 소스 문서와 줄 번호
- [x] B단계: 영속 캐시와 백그라운드 사전 디컴파일
- [x] C단계: VSearch 연동과 검색 위치 이동
- [x] D단계: 클래스·메서드 분석과 선언 이동
- [x] 완료 — [작업 기록](docs/additional-development-12.md)
- [x] 후속: 클래스 열기 지연 개선(캐시 적중 빠른 경로, 사용자 요청 선점, 내부 클래스 문서 통합)
- [x] 후속: 새 창 성능 개선 — 클래스마다 CFR를 실행하지 않고 JAR당 한 번 일괄 실행, 완료 마커 재사용,
  재시작 캐시 검증의 전체 JAR 해시 제거. [측정과 구현 기록](docs/additional-development-12.md)
- [x] 후속: 선언 이동 심볼 인덱스 — JAR별 타입 인덱스로 후보 소스만 읽기(1,000 클래스 기준 856ms → 2.5ms).
  [측정과 구현 기록](docs/additional-development-12.md)
- [x] 후속: 디컴파일 작업 시간 제한 — 멈춘 클래스 작업은 큐를 풀고, 아무것도 쓰지 않는 JAR 일괄 실행은
  중단하며 다시 시도하지 않음(`vshoon.decom.decompileTimeoutSec`, 기본 120초)
- [ ] 실제 패키지에서 새 창·JAR 펼치기·첫 클래스 열기 체감 재확인
