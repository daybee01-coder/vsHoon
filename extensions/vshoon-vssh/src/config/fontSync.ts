import * as vscode from 'vscode';
import { getSettings } from './settings';

const LAST_PROMPTED_KEY = 'vssh.lastFontPromptValue';

/**
 * vscode.Pseudoterminal API는 터미널별로 폰트를 독립적으로 바꿀 방법을 제공하지 않는다.
 * 그래서 vssh.terminal.fontFamily/fontSize를 실제로 반영하려면 전역 terminal.integrated.*
 * 설정을 바꾸는 수밖에 없는데, 이는 vssh와 무관한 다른 터미널에도 영향을 준다.
 * 그 부작용을 명확히 알리고 동의를 받은 뒤에만 적용한다.
 */
export function registerFontSync(context: vscode.ExtensionContext): void {
  const check = async (): Promise<void> => {
    const { terminalFontFamily, terminalFontSize } = getSettings();
    if (!terminalFontFamily.trim()) return;

    const fingerprint = `${terminalFontFamily}::${terminalFontSize}`;
    if (context.globalState.get<string>(LAST_PROMPTED_KEY) === fingerprint) return;
    await context.globalState.update(LAST_PROMPTED_KEY, fingerprint);

    const choice = await vscode.window.showInformationMessage(
      `VSsh 터미널 폰트를 "${terminalFontFamily}" (${terminalFontSize}px)로 설정하셨습니다. ` +
        'VSCode는 터미널마다 폰트를 따로 지정할 수 없어서, 적용하면 vssh 터미널뿐 아니라 ' +
        '모든 통합 터미널의 폰트가 함께 바뀝니다. 적용할까요?',
      '전역 터미널 폰트에 적용',
      '취소'
    );
    if (choice !== '전역 터미널 폰트에 적용') return;

    const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
    await terminalConfig.update('fontFamily', terminalFontFamily, vscode.ConfigurationTarget.Global);
    await terminalConfig.update('fontSize', terminalFontSize, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(' 전역 터미널 폰트를 적용했습니다.');
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vssh.terminal.fontFamily') || e.affectsConfiguration('vssh.terminal.fontSize')) {
        void check();
      }
    })
  );

  void check();
}
