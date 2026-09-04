import * as path from 'path';

/**
 * Windows의 legacy MAX_PATH(260자) 제한을 우회하기 위해 절대경로에 `\\?\` 확장 경로 접두어를
 * 붙인다. 시스템의 LongPathsEnabled 설정 여부와 무관하게 항상 동작한다. Java 패키지가 깊게
 * 중첩된 대형 jar를 사용자 프로필 아래 캐시 폴더에 풀어낼 때 실제로 260자를 넘길 수 있어
 * 필요한 방어 코드다.
 */
export function longPath(p: string): string {
    if (process.platform !== 'win32') return p;
    if (p.startsWith('\\\\?\\')) return p;
    const resolved = path.resolve(p);
    if (resolved.startsWith('\\\\')) {
        return `\\\\?\\UNC\\${resolved.slice(2)}`;
    }
    return `\\\\?\\${resolved}`;
}
