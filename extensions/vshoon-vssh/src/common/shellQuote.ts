/** POSIX 셸에 안전하게 넘기기 위해 작은따옴표로 감싸고, 내부 작은따옴표는 표준 방식으로 이스케이프한다. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
