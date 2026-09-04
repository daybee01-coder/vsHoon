import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { getConfig } from './config';
import { log } from './output';

const CFR_VERSION = '0.152';
const CFR_FILENAME = `cfr-${CFR_VERSION}.jar`;
const CFR_URL = `https://github.com/leibnitz27/cfr/releases/download/${CFR_VERSION}/${CFR_FILENAME}`;
const CFR_SHA256 = 'f686e8f3ded377d7bc87d216a90e9e9512df4156e75b06c655a16648ae8765b2';

function sha256OfFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

function downloadFile(url: string, destPath: string, redirectsLeft = 5): Promise<void> {
    return new Promise((resolve, reject) => {
        if (redirectsLeft < 0) {
            reject(new Error('너무 많은 리다이렉트가 발생했습니다.'));
            return;
        }
        const request = https.get(url, { headers: { 'User-Agent': 'vscode-decom-extension' } }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                downloadFile(res.headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`다운로드 실패: HTTP ${res.statusCode} (${url})`));
                return;
            }
            const tmpPath = `${destPath}.download`;
            const fileStream = fs.createWriteStream(tmpPath);
            res.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close((err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    fs.rename(tmpPath, destPath, (renameErr) => {
                        if (renameErr) reject(renameErr);
                        else resolve();
                    });
                });
            });
            fileStream.on('error', reject);
        });
        request.on('error', reject);
    });
}

/**
 * CFR jar가 준비되어 있는지 확인하고, 없으면 GitHub 릴리스에서 내려받아 sha256으로 무결성을
 * 검증한다. 사용자가 decom.cfr.jarPath를 지정한 경우 해당 경로를 그대로 사용한다.
 */
export async function ensureCfrJar(context: vscode.ExtensionContext): Promise<string> {
    const cfg = getConfig();
    if (cfg.cfrJarPath) {
        if (!fs.existsSync(cfg.cfrJarPath)) {
            throw new Error(`설정된 decom.cfr.jarPath 경로를 찾을 수 없습니다: ${cfg.cfrJarPath}`);
        }
        return cfg.cfrJarPath;
    }

    const storageDir = path.join(context.globalStorageUri.fsPath, 'cfr');
    fs.mkdirSync(storageDir, { recursive: true });
    const destPath = path.join(storageDir, CFR_FILENAME);

    if (fs.existsSync(destPath)) {
        return destPath;
    }

    log(`CFR 디컴파일러(${CFR_VERSION})를 다운로드합니다: ${CFR_URL}`);
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Decom: CFR 디컴파일러 다운로드 중...',
            cancellable: false
        },
        async () => {
            await downloadFile(CFR_URL, destPath);
        }
    );

    const actualHash = await sha256OfFile(destPath);
    if (actualHash !== CFR_SHA256) {
        fs.unlinkSync(destPath);
        throw new Error(
            `CFR jar의 무결성 검증에 실패했습니다 (예상: ${CFR_SHA256}, 실제: ${actualHash}). 다운로드를 다시 시도해주세요.`
        );
    }
    log('CFR 디컴파일러 다운로드 및 검증 완료.');
    return destPath;
}

export interface RunResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

async function runJava(context: vscode.ExtensionContext, cfrArgs: string[], token?: vscode.CancellationToken): Promise<RunResult> {
    const cfg = getConfig();
    // ensureCfrJar는 여기서 await하여, 실패 시 이 async 함수의 반환 Promise가 정상적으로 reject되도록 한다.
    // (Promise executor 내부에서 await하면 예외가 executor의 반환값으로 흡수되어 바깥 Promise가 영원히 pending 상태로 남는다.)
    const cfrJarPath = await ensureCfrJar(context);

    return new Promise((resolve, reject) => {
        const args = ['-jar', cfrJarPath, ...cfrArgs];
        log(`실행: ${cfg.javaExecutable} ${args.join(' ')}`);
        const child = spawn(cfg.javaExecutable, args, { windowsHide: true });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
        child.stderr.on('data', (d) => (stderr += d.toString('utf8')));

        const cancelListener = token?.onCancellationRequested(() => {
            child.kill();
        });

        child.on('error', (err) => {
            cancelListener?.dispose();
            reject(err);
        });
        child.on('close', (code) => {
            cancelListener?.dispose();
            resolve({ code, stdout, stderr });
        });
    });
}

/**
 * 단일 .class 파일을 디컴파일하여 소스 문자열을 반환한다. 같은 디렉터리에 내부/익명 클래스에
 * 해당하는 형제 .class 파일(예: Foo$1.class)이 함께 있으면 CFR이 자동으로 본문에 병합해준다.
 */
export async function decompileSingleClass(context: vscode.ExtensionContext, classFilePath: string): Promise<string> {
    const cfg = getConfig();
    const extraArgs = cfg.cfrExtraOptions ? cfg.cfrExtraOptions.split(/\s+/) : [];
    const args = [classFilePath, '--silent', 'true', ...extraArgs];
    if (cfg.extraClasspath.length > 0) {
        args.push('--extraclasspath', cfg.extraClasspath.join(path.delimiter));
    }
    const result = await runJava(context, args);
    if (result.code !== 0 || !result.stdout.trim()) {
        throw new Error(`CFR 디컴파일 실패 (exit ${result.code}):\n${result.stderr || result.stdout}`);
    }
    return result.stdout;
}
