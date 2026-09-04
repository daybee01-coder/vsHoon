import type { DialectId } from '../types';

/**
 * 자동 완성용 키워드/함수 사전.
 *
 * 완전한 문법 목록이 아니라 "손으로 자주 치는 것" 위주다.
 * 목록이 길수록 제안이 시끄러워져서 오히려 쓸모가 떨어진다.
 */

export const COMMON_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT',
  'OFFSET', 'DISTINCT', 'AS', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN',
  'LIKE', 'IS NULL', 'IS NOT NULL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN',
  'CROSS JOIN', 'ON', 'USING', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT',
  'WITH', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'MERGE',
  'CREATE TABLE', 'CREATE INDEX', 'CREATE VIEW', 'ALTER TABLE', 'DROP TABLE',
  'TRUNCATE TABLE', 'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'UNIQUE',
  'DEFAULT', 'CHECK', 'CONSTRAINT', 'CASCADE', 'ASC', 'DESC', 'ALL', 'ANY',
  'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'EXPLAIN', 'OVER', 'PARTITION BY',
  'ROWS BETWEEN', 'UNBOUNDED PRECEDING', 'CURRENT ROW',
];

export const COMMON_FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST', 'ABS',
  'ROUND', 'CEIL', 'FLOOR', 'LENGTH', 'LOWER', 'UPPER', 'TRIM', 'LTRIM',
  'RTRIM', 'SUBSTRING', 'REPLACE', 'CONCAT', 'ROW_NUMBER', 'RANK',
  'DENSE_RANK', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'NTILE',
];

const DIALECT_KEYWORDS: Record<DialectId, string[]> = {
  mysql: ['LIMIT', 'AUTO_INCREMENT', 'ENGINE', 'CHARACTER SET', 'COLLATE',
          'ON DUPLICATE KEY UPDATE', 'SHOW TABLES', 'SHOW DATABASES',
          'DESCRIBE', 'STRAIGHT_JOIN', 'FORCE INDEX', 'USE INDEX'],
  mariadb: ['LIMIT', 'AUTO_INCREMENT', 'ENGINE', 'CHARACTER SET', 'COLLATE',
            'ON DUPLICATE KEY UPDATE', 'RETURNING', 'SHOW TABLES',
            'SHOW DATABASES', 'DESCRIBE', 'STRAIGHT_JOIN'],
  postgres: ['RETURNING', 'ON CONFLICT', 'DO NOTHING', 'DO UPDATE SET',
             'ILIKE', 'SIMILAR TO', 'LATERAL', 'DISTINCT ON', 'ARRAY',
             'JSONB_BUILD_OBJECT', 'GENERATE_SERIES', 'MATERIALIZED',
             'FOR UPDATE SKIP LOCKED', 'TABLESAMPLE'],
  oracle: ['DUAL', 'ROWNUM', 'ROWID', 'CONNECT BY', 'START WITH', 'PRIOR',
           'FETCH FIRST', 'ROWS ONLY', 'NVL', 'NVL2', 'DECODE', 'SYSDATE',
           'SYSTIMESTAMP', 'TO_DATE', 'TO_CHAR', 'TO_NUMBER', 'MERGE INTO',
           'PARTITION BY', 'PIVOT', 'UNPIVOT', 'MINUS'],
};

const DIALECT_FUNCTIONS: Record<DialectId, string[]> = {
  mysql: ['NOW', 'CURDATE', 'DATE_FORMAT', 'DATE_ADD', 'DATE_SUB', 'DATEDIFF',
          'IFNULL', 'IF', 'GROUP_CONCAT', 'JSON_EXTRACT', 'UNIX_TIMESTAMP'],
  mariadb: ['NOW', 'CURDATE', 'DATE_FORMAT', 'DATE_ADD', 'DATE_SUB', 'DATEDIFF',
            'IFNULL', 'IF', 'GROUP_CONCAT', 'JSON_VALUE', 'UNIX_TIMESTAMP'],
  postgres: ['NOW', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'DATE_TRUNC',
             'AGE', 'EXTRACT', 'STRING_AGG', 'ARRAY_AGG', 'JSONB_AGG',
             'TO_CHAR', 'TO_TIMESTAMP', 'GEN_RANDOM_UUID', 'SPLIT_PART'],
  oracle: ['SYSDATE', 'SYSTIMESTAMP', 'ADD_MONTHS', 'MONTHS_BETWEEN',
           'LAST_DAY', 'TRUNC', 'LISTAGG', 'REGEXP_SUBSTR', 'REGEXP_REPLACE',
           'INSTR', 'SUBSTR', 'TO_CHAR', 'TO_DATE'],
};

export function keywordsFor(dialect: DialectId): string[] {
  return dedupe([...COMMON_KEYWORDS, ...DIALECT_KEYWORDS[dialect]]);
}

export function functionsFor(dialect: DialectId): string[] {
  return dedupe([...COMMON_FUNCTIONS, ...DIALECT_FUNCTIONS[dialect]]);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** 설정된 대소문자 규칙을 적용한다. */
export function applyCase(keyword: string, mode: 'upper' | 'lower' | 'preserve'): string {
  switch (mode) {
    case 'upper':
      return keyword.toUpperCase();
    case 'lower':
      return keyword.toLowerCase();
    default:
      return keyword;
  }
}
