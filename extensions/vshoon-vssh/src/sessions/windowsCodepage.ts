import { execFileSync } from 'child_process';

let cachedAnsiCp: number | undefined;
let cachedOemCp: number | undefined;

function readNlsCodepage(valueName: 'ACP' | 'OEMCP'): number {
  const out = execFileSync(
    'reg',
    ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', valueName],
    { windowsHide: true, encoding: 'utf8' }
  );
  const m = out.match(new RegExp(`${valueName}\\s+REG_SZ\\s+(\\d+)`));
  if (!m) {
    throw new Error(`레지스트리에서 ${valueName} 코드페이지 값을 읽을 수 없습니다.`);
  }
  return parseInt(m[1], 10);
}

/** Win32 "ANSI" 코드페이지 (GetDlgItemTextA 등 narrow API가 사용하는 코드페이지). */
export function getSystemAnsiCodepage(): number {
  if (cachedAnsiCp === undefined) {
    cachedAnsiCp = readNlsCodepage('ACP');
  }
  return cachedAnsiCp;
}

/** 콘솔 출력 코드페이지 (reg.exe stdout을 디코딩할 때 사용). */
export function getSystemOemCodepage(): number {
  if (cachedOemCp === undefined) {
    cachedOemCp = readNlsCodepage('OEMCP');
  }
  return cachedOemCp;
}

const CODEPAGE_TO_ICONV: Record<number, string> = {
  65001: 'utf8',
  949: 'cp949',
  936: 'cp936',
  950: 'cp950',
  932: 'cp932',
  1252: 'windows-1252',
  1251: 'windows-1251',
  20127: 'ascii',
};

export function codepageToIconvEncoding(cp: number): string {
  return CODEPAGE_TO_ICONV[cp] ?? `cp${cp}`;
}
