import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { storageLocations } from './locations';

describe('storageLocations', () => {
  it('Windows 에서는 APPDATA 아래를 본다', () => {
    const found = storageLocations({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32');
    assert.deepStrictEqual(
      found.map((location) => [location.label, location.statePath, location.localStatePath]),
      [
        [
          'Visual Studio Code',
          path.join('C:\\Users\\me\\AppData\\Roaming', 'Code', 'User', 'globalStorage', 'state.vscdb'),
          path.join('C:\\Users\\me\\AppData\\Roaming', 'Code', 'Local State'),
        ],
        [
          'Visual Studio Code - Insiders',
          path.join(
            'C:\\Users\\me\\AppData\\Roaming',
            'Code - Insiders',
            'User',
            'globalStorage',
            'state.vscdb',
          ),
          path.join('C:\\Users\\me\\AppData\\Roaming', 'Code - Insiders', 'Local State'),
        ],
        [
          'VSCodium',
          path.join('C:\\Users\\me\\AppData\\Roaming', 'VSCodium', 'User', 'globalStorage', 'state.vscdb'),
          path.join('C:\\Users\\me\\AppData\\Roaming', 'VSCodium', 'Local State'),
        ],
      ],
    );
  });

  it('플랫폼별 데이터 루트를 쓴다', () => {
    const mac = storageLocations({ HOME: '/Users/me' }, 'darwin')[0];
    const linux = storageLocations({ HOME: '/home/me' }, 'linux')[0];
    const xdg = storageLocations({ HOME: '/home/me', XDG_CONFIG_HOME: '/cfg' }, 'linux')[0];
    assert.deepStrictEqual(
      [mac?.dataDir, linux?.dataDir, xdg?.dataDir],
      [
        path.join('/Users/me', 'Library', 'Application Support', 'Code'),
        path.join('/home/me', '.config', 'Code'),
        path.join('/cfg', 'Code'),
      ],
    );
  });

  it('필요한 환경 변수가 없으면 후보가 없다', () => {
    assert.deepStrictEqual(
      [storageLocations({}, 'win32'), storageLocations({}, 'linux')],
      [[], []],
    );
  });
});
