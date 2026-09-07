/**
 * 가져오기 계획 — 무엇이 새 연결이고, 무엇이 이미 있고, 무엇을 이름을 바꿔
 * 넣을지 결정한다.
 *
 * 확인 화면과 실제 저장이 같은 판단을 쓰도록 계획을 먼저 만든다. 목록에서
 * "이미 있음" 으로 보이던 항목이 저장 단계에서 조용히 하나 더 생기는 일은
 * 없어야 한다. vscode API 를 쓰지 않는다 — 테스트에서 그대로 부른다.
 */

import { duplicateName } from '../config/profileNames';

/** 같은 연결인지 판단하는 데 쓰는 최소 정보. */
export interface ImportIdentity {
  name: string;
  folder?: string;
  dialect: string;
  host: string;
  port: number;
  database: string;
  user: string;
}

export type ImportStatus =
  /** 그대로 새로 만든다. */
  | 'new'
  /** 같은 폴더에 이름이 겹쳐서 이름을 바꿔 만든다. */
  | 'renamed'
  /** 접속 정보까지 같은 것이 이미 있다 — 기본적으로 건너뛴다. */
  | 'existing';

export interface ImportItem<T extends ImportIdentity> {
  source: T;
  /** 실제로 저장할 이름. `renamed` 일 때만 source.name 과 다르다. */
  name: string;
  status: ImportStatus;
}

/** 이름과 경로에 나타날 수 없는 구분자 — 키를 이어 붙일 때만 쓴다. */
const SEP = '\u0000';

/**
 * 들어온 순서대로 계획을 세운다.
 *
 * 앞 항목이 차지한 이름은 뒤 항목에게도 "이미 쓰인 이름" 이다 — 한 번의
 * 가져오기 안에서 같은 이름이 두 개 생기지 않게 하려면 누적해서 봐야 한다.
 */
export function planImport<T extends ImportIdentity>(
  existing: ImportIdentity[],
  incoming: T[],
): ImportItem<T>[] {
  const identities = new Set(existing.map(identityKey));
  const names = new Set(existing.map(nameKey));

  return incoming.map((source) => {
    if (identities.has(identityKey(source))) {
      return { source, name: source.name, status: 'existing' as const };
    }
    let name = source.name;
    let status: ImportStatus = 'new';
    if (names.has(nameKey(source))) {
      name = duplicateName(source.name, namesInFolder(names, source.folder));
      status = 'renamed';
    }
    identities.add(identityKey({ ...source, name }));
    names.add(nameKey({ ...source, name }));
    return { source, name, status };
  });
}

/** 폴더가 다르면 같은 이름을 허용한다 — 트리에서 서로 구분되기 때문이다. */
function nameKey(identity: Pick<ImportIdentity, 'name' | 'folder'>): string {
  return `${identity.folder ?? ''}${SEP}${identity.name}`;
}

function identityKey(identity: ImportIdentity): string {
  return [
    identity.folder ?? '',
    identity.name,
    identity.dialect,
    identity.host,
    String(identity.port),
    identity.database,
    identity.user,
  ].join(SEP);
}

/** 이름 후보를 고를 때는 같은 폴더 안에서 쓰인 이름만 걸림돌이 된다. */
function namesInFolder(names: Set<string>, folder: string | undefined): string[] {
  const prefix = `${folder ?? ''}${SEP}`;
  const taken: string[] = [];
  for (const key of names) {
    if (key.startsWith(prefix)) {
      taken.push(key.slice(prefix.length));
    }
  }
  return taken;
}
