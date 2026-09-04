/**
 * oracledb 는 타입 선언을 함께 배포하지 않는다 (6.10 기준).
 *
 * `@types/oracledb` 를 받는 대신 앰비언트 선언만 둔다. 이 확장은
 * 드라이버 라이브러리의 타입이 경계를 넘지 않게 하는 것을 규칙으로 삼고,
 * 실제로 쓰는 표면은 driver.ts 안에서 `OracleModule` 로 직접 선언한다.
 * 그래서 여기서 필요한 건 "이 모듈은 존재한다"는 사실뿐이다.
 *
 * 새 API 를 쓰기 시작하면 driver.ts 의 인터페이스에 추가하면 된다.
 */
declare module 'oracledb' {
  const oracledb: unknown;
  export = oracledb;
}
