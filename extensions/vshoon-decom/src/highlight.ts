const KEYWORDS = new Set([
    'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
    'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
    'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
    'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
    'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
    'volatile', 'while', 'var', 'record', 'sealed', 'permits', 'yield', 'true', 'false', 'null'
]);

const TOKEN_RE =
    /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(@[A-Za-z_]\w*)|(\b0[xX][0-9a-fA-F_]+[lL]?\b|\b\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?[lLfFdD]?\b)|([A-Za-z_]\w*)/g;

export function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => {
        switch (c) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            default:
                return '&#39;';
        }
    });
}

/** 자바 소스에 아주 가벼운 정규식 기반 구문 강조를 적용해 HTML로 변환한다. (클라이언트 스크립트 불필요) */
export function highlightJava(source: string): string {
    let result = '';
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(source))) {
        if (m.index > lastIndex) {
            result += escapeHtml(source.slice(lastIndex, m.index));
        }
        const [full, comment1, comment2, str, ch, annotation, number, word] = m;
        if (comment1 || comment2) {
            result += `<span class="tok-comment">${escapeHtml(full)}</span>`;
        } else if (str || ch) {
            result += `<span class="tok-string">${escapeHtml(full)}</span>`;
        } else if (annotation) {
            result += `<span class="tok-annotation">${escapeHtml(full)}</span>`;
        } else if (number) {
            result += `<span class="tok-number">${escapeHtml(full)}</span>`;
        } else if (word) {
            result += KEYWORDS.has(word) ? `<span class="tok-keyword">${escapeHtml(full)}</span>` : escapeHtml(full);
        }
        lastIndex = TOKEN_RE.lastIndex;
    }
    result += escapeHtml(source.slice(lastIndex));
    return result;
}
