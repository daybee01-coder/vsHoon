/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import { FileStat } from './fileSession';

export function isProbablyTextFile(content: Uint8Array): boolean {
  const sample = content.subarray(0, Math.min(content.length, 8192));
  if (sample.length === 0) {
    return true;
  }
  if (
    (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) ||
    (sample[0] === 0xff && sample[1] === 0xfe) ||
    (sample[0] === 0xfe && sample[1] === 0xff)
  ) {
    return true;
  }
  if (sample.includes(0)) {
    return false;
  }
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte < 0x20 && byte !== 0x08 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) {
      controlBytes++;
    }
  }
  return controlBytes / sample.length < 0.05;
}

export function remoteFileChanged(original: FileStat, current: FileStat): boolean {
  return original.isDirectory !== current.isDirectory || original.size !== current.size || original.mtime !== current.mtime;
}

export function safeTemporaryFileName(name: string): string {
  const sanitized = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '');
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sanitized);
  return sanitized && sanitized !== '.' && sanitized !== '..' && !reserved ? sanitized : `remote-${crypto.randomUUID()}`;
}
