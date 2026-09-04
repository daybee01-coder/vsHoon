import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { longPath } from './longpath';

export const MANIFEST_DIRNAME = '.decom';
export const MANIFEST_FILENAME = 'manifest.json';

export interface DecomManifest {
    version: 1;
    jarPath: string;
    jarSize: number;
    jarMtimeMs: number;
    backupPath: string | null;
}

export function hashPath(absolutePath: string): string {
    return crypto.createHash('sha1').update(path.resolve(absolutePath)).digest('hex').slice(0, 12);
}

export function cacheDirFor(context: vscode.ExtensionContext, jarPath: string): string {
    const base = path.basename(jarPath, path.extname(jarPath));
    const safeBase = base.replace(/[^A-Za-z0-9_.-]/g, '_');
    return path.join(context.globalStorageUri.fsPath, 'jars', `${safeBase}-${hashPath(jarPath)}`);
}

export function manifestPath(cacheDir: string): string {
    return path.join(cacheDir, MANIFEST_DIRNAME, MANIFEST_FILENAME);
}

export function readManifest(cacheDir: string): DecomManifest | undefined {
    const p = longPath(manifestPath(cacheDir));
    if (!fs.existsSync(p)) return undefined;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as DecomManifest;
    } catch {
        return undefined;
    }
}

export function writeManifest(cacheDir: string, manifest: DecomManifest): void {
    const p = longPath(manifestPath(cacheDir));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(manifest, null, 2), 'utf8');
}
