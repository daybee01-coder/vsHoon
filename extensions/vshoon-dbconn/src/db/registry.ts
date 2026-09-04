import type { DialectId } from '../types';
import type { Driver } from './driver';
import { createMySqlDriver } from './mysql/driver';
import { createOracleDriver } from './oracle/driver';
import { createPostgresDriver } from './postgres/driver';

/**
 * 방언 → 드라이버.
 *
 * 드라이버 객체 자체는 가볍고, 무거운 라이브러리는 첫 connect() 때
 * 동적 import 로 불러온다. 그래서 Oracle 을 쓰지 않는 사용자는
 * oracledb 를 로드하는 비용을 전혀 치르지 않는다.
 */
const drivers = new Map<DialectId, Driver>();

export function getDriver(dialect: DialectId): Driver {
  let driver = drivers.get(dialect);
  if (driver) {
    return driver;
  }
  switch (dialect) {
    case 'mysql':
    case 'mariadb':
      driver = createMySqlDriver(dialect);
      break;
    case 'postgres':
      driver = createPostgresDriver();
      break;
    case 'oracle':
      driver = createOracleDriver();
      break;
  }
  drivers.set(dialect, driver);
  return driver;
}
