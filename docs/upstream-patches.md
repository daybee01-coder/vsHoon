# VShoon Upstream Patch Ledger

각 항목은 `patches/` 아래의 패치 파일 하나와 1:1로 대응한다. 적용 대상 코어 커밋은
`vshoon.lock.json`의 `upstream.commit`이며, `npm run sync`가 checkout 직후 순서대로 적용한다.
패치를 손으로 수정하지 말고 `.core`에서 파일을 고친 뒤 `npm run patch:save`로 다시 기록한다.
한 파일은 하나의 패치만 소유할 수 있다.

| 패치 ID | 파일 | 코어 대상 |
| --- | --- | --- |
| VSH-0001 | `patches/VSH-0001-product-identity.patch` | `product.json` |
| VSH-0002 | `patches/VSH-0002-start-window-seam.patch` | `src/vs/code/electron-main/app.ts` |
| VSH-0003 | `patches/VSH-0003-source-layers.patch` | `eslint.config.js` |

## VSH-0001 — Product Identity

- Purpose: separate VShoon application data, protocol handlers, mutexes, installer identities, and visible product name from Code - OSS.
- Upstream files: `product.json`.
- Reason: side-by-side installation and a distinct, non-Microsoft product identity require unique identifiers.
- Dependencies: upstream product configuration schema and packaging scripts that consume `product.json`.
- Conflict risk: medium; upstream occasionally adds product identity fields.
- Validation: parse `product.json`; inspect packaged Windows metadata and side-by-side behavior in Phase 4.
- Removal condition: none while VShoon remains a separately distributed product.

## VSH-0002 — Start-Window Policy and Lifecycle Seam

- 목적: 대상 없는 데스크톱 실행을 Workbench 생성 전에 VShoon 시작 창으로 위임하고, 시작 창이 실행을 소유하는 동안 도착한 두 번째 인스턴스를 올바르게 처리한다.
- VShoon 소유 파일: `src/vs/vshoon/common/startWindowPolicy.ts`, `src/vs/vshoon/node/launchRequest.ts`, `src/vs/vshoon/electron-main/startWindowMainService.ts`, `src/vs/vshoon/electron-main/launchMainService.ts`, `src/vs/vshoon/electron-sandbox/startWindow/**`, `src/vs/vshoon/test/**`.
- 수정한 upstream 파일: `src/vs/code/electron-main/app.ts`.
- 이유: 일반 확장은 Workbench가 생성된 뒤 활성화되므로 시작 창 수명주기를 제어할 수 없다.
- 의존성: `CodeApplication.openFirstWindow`, `CodeApplication.initChannels`, `ILaunchMainService`, `IWindowsMainService`, `IWorkspacesHistoryMainService`, lifecycle 및 dialog 서비스.
- 충돌 위험도: 정책 모듈은 낮음, `app.ts` seam은 높음.
- 현재 seam: `app.ts`에서 세 곳만 수정한다. (1) `IVShoonStartWindowMainService` 등록, (2) `initChannels`에서 두 번째 인스턴스에 노출되는 `launch` 채널을 `VShoonLaunchMainService`로 감싸기, (3) `openFirstWindow`에서 정책 판정과 시작 창 수명주기 처리.
- 두 번째 인스턴스: 시작 창이 실행을 소유하는 동안 대상 없는 요청은 시작 창을 포커스한다. 대상이 있는 요청은 upstream으로 위임하되 위임 **전에** 시작 창이 물러난다. `--wait` 요청의 `start()`는 편집이 끝나야 resolve되므로 결과를 기다리면 안 된다.
- 검증: 정책 및 인자 매핑 단위 테스트 9개, 대상 ESLint, `valid-layers-check`, `typecheck-client` 통과. 격리된 Windows 데스크톱 실행에서 시작 창 표시, 두 번째 인스턴스 포커스, 폴더 인자 전달 시 Workbench 인계를 확인했다.
- 제거 조건: upstream이 지원되는 pre-workbench 제품 기여점을 제공하는 경우.

## VSH-0003 — VShoon 소스 계층 규칙

- 목적: `src/vs/vshoon/**` 파일에 upstream과 동일한 import 계층 검사를 적용한다.
- 수정한 upstream 파일: `eslint.config.js`.
- 이유: 새 제품 소스 루트는 명시적인 `code-import-patterns` 대상이 없으면 린트 경고가 발생하고 계층 위반도 검사할 수 없다.
- 허용 의존성: VShoon은 `vs/base`, `vs/base/parts`, `vs/platform`, `vs/code`, `vs/vshoon`을 사용할 수 있다. 제품 진입 seam을 위해 `vs/code`에서 `vs/vshoon`으로 향하는 참조도 허용한다.
- 충돌 위험도: 낮음. upstream import 규칙 배열의 인접 변경 시 수동 병합이 필요할 수 있다.
- 검증: VShoon 소스 및 테스트 파일 대상 ESLint, 전체 계층 검사.
- 제거 조건: VShoon 소스가 upstream 표준 루트로 이동하거나 별도 ESLint 구성을 사용하게 되는 경우.
