import * as fs from 'fs';
import { DecomManifest, writeManifest } from './manifest';
import { longPath } from './longpath';
import { log } from './output';

/** 해당 jar를 처음으로 변경하는 시점에 한 번 `<jar>.decom-bak` 백업을 만든다. */
export function ensureBackup(manifest: DecomManifest, cacheDir: string): void {
    if (manifest.backupPath && fs.existsSync(longPath(manifest.backupPath))) return;
    const backupPath = `${manifest.jarPath}.decom-bak`;
    if (!fs.existsSync(longPath(backupPath))) {
        fs.copyFileSync(longPath(manifest.jarPath), longPath(backupPath));
        log(`원본 JAR 백업 생성: ${backupPath}`);
    }
    manifest.backupPath = backupPath;
    writeManifest(cacheDir, manifest);
}
