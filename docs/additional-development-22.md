# 22. SFTP 파일 관리와 DBConn 다중 선택

## Windows 개발 빌드

PowerShell에서 저장소 루트로 이동한다. 코어가 고정한 Node.js 버전은 `.core/.nvmrc`에 있으며 현재는 **24.18.0**이다. 저장소에 준비된 Node를 사용하려면 다음과 같이 설정한다.

```powershell
Set-Location 'D:\project\vscode\vsHoon'
if (Test-Path '.build/tools/node-v24.18.0/node.exe') {
    $env:PATH = (Resolve-Path '.build/tools/node-v24.18.0').Path + ';' + $env:PATH
}
node --version
```

처음 빌드하거나 고정된 코어 버전이 바뀐 경우 다음 명령으로 코어와 의존성을 준비한다. 처음 설치하는 컴퓨터에는 Windows C++ 빌드 도구가 필요하다.

```powershell
npm run sync
npm run core -- install
```

개발 빌드를 만들고 실행한다. 빌드 스크립트가 VShoon 소스를 코어에 반영하고 클라이언트와 내장 확장을 컴파일한다.

```powershell
npm run build
$env:NODE_ENV = 'development'
$env:VSCODE_DEV = '1'
& '.\.core\.build\electron\vs Hoon.exe' (Resolve-Path '.\.core').Path
```

관련 확장 테스트는 `npm run test:vssh`와 `npm run test:dbconn`으로 실행한다.

## 배포 폴더와 설치 프로그램

개발 빌드가 끝난 상태에서 Windows x64 배포 폴더를 만든다.

```powershell
npm run core -- run gulp vscode-win32-x64
```

결과는 저장소 루트의 `VSCode-win32-x64\`에 있으며 폴더 안의 `vs Hoon.exe`로 실행한다. 사용자 설치 프로그램까지 필요하면 다음 명령을 차례대로 실행한다. [Windows 릴리스 가이드](release.md)

```powershell
npm run core -- run gulp vscode-win32-x64-inno-updater
npm run core -- run gulp vscode-win32-x64-user-setup
```

설치 프로그램은 `.core\.build\win32-x64\user-setup\VShoonSetup.exe`에 생성된다.

## 새 기능 사용

- **SFTP**에서 파일이나 폴더를 같은 패널의 폴더 행에 놓으면 이동한다. `..` 행에 놓으면 상위 폴더로 이동한다. 로컬과 원격 패널 사이에 놓으면 업로드 또는 다운로드한다. Windows 파일 탐색기로 내보낼 때는 로컬 항목에서 `Alt`를 누른 채 드래그를 시작한다.
- **SFTP**에서 항목을 여러 개 선택한 뒤 `Delete` 또는 우클릭 **삭제**를 사용할 수 있다. 우클릭 **폴더로 복사…**와 **폴더로 이동…**에서 대상 폴더 경로를 입력할 수 있다. 같은 이름의 대상 항목은 건너뛰고 결과를 표시한다. 작업이 끝나면 목록이 새로고침된다.
- **DBConn**에서 `Ctrl` 또는 `Shift`로 테이블, 뷰, 시퀀스 등 여러 객체를 선택한다. `Ctrl+C` 또는 우클릭 **이름 복사**를 선택하면 `스키마.이름`이 한 줄에 하나씩 복사된다.
- **DBConn**에서 선택한 객체 중 하나를 우클릭하고 **선택한 객체 삭제…**를 선택하면 실행할 삭제 구문과 대상 연결을 확인할 수 있다. 실행 결과와 실패 원인은 쿼리 결과 및 기록에서 확인할 수 있다. 수동 커밋 모드에서 PostgreSQL 변경은 커밋 후 반영된다.

## 검증

Windows 개발 빌드, VSsh 단위 테스트 17개, DBConn 단위 테스트 351개, `npm run lint`, 오프라인 동기화 검사와 시작 창 스모크 테스트를 통과했다. Windows에서 임시 폴더를 사용해 로컬 SFTP의 파일·폴더 다중 이동, 우클릭 복사, `Delete` 키 삭제 및 자동 새로고침을 확인했다. 원격 SSH와 실제 DB 서버를 대상으로 한 통합 검증은 남아 있다.
