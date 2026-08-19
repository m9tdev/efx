/**
 * A tiny, dependency-free TSX-ish tokenizer for the guided-tour code blocks.
 *
 * Why hand-rolled instead of Shiki/Prism: verrex builds DOM from a View tree
 * and has no `innerHTML` seam, so a highlighter that emits HTML strings doesn't
 * fit. Emitting tokens lets `main.vx` render each as a `<span>` View node —
 * highlighting becomes just another verrex child array, no new dependency, no
 * bundle weight. The snippets are short and curated, so a pragmatic lexer (not
 * a full TS grammar) is plenty.
 */

export type Token = {
  readonly text: string
  readonly kind:
    | "kw"
    | "str"
    | "com"
    | "num"
    | "type"
    | "fn"
    | "tag"
    | "punct"
    | "plain"
}

const KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "yield",
  "return",
  "new",
  "function",
  "if",
  "else",
  "for",
  "of",
  "in",
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "await",
  "async",
  "import",
  "export",
  "from",
  "as",
  "interface",
  "type",
  "extends",
  "class",
  "typeof",
])

const isSpace = (c: string) =>
  c === " " || c === "\t" || c === "\n" || c === "\r"
const isDigit = (c: string) => c >= "0" && c <= "9"
const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c)
const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c)
// `<` opens a JSX tag only in expression position — after `(`, `{`, `=>`, etc.
// After an identifier/`)`/ `]` (e.g. `collection<Todo>`) it's a
// generic/less-than.
const isExprPos = (prev: string) => prev === "" || !/[A-Za-z0-9_)\]]/.test(prev)

export const highlight = (src: string): ReadonlyArray<Token> => {
  const toks: Token[] = []
  const push = (text: string, kind: Token["kind"]) => {
    if (text) toks.push({ text, kind })
  }
  let i = 0
  const n = src.length
  let prev = "" // last significant (non-space) char, for JSX detection

  while (i < n) {
    const c = src[i]!

    if (isSpace(c)) {
      let j = i + 1
      while (j < n && isSpace(src[j]!)) j++
      const ws = src.slice(i, j)
      push(ws, "plain")
      // A newline resets expression position: a `<` starting a fresh line is a
      // JSX tag, not a less-than against the previous line's trailing
      // `)`/ident.
      if (ws.includes("\n")) prev = ""
      i = j
      continue
    }

    // line comment
    if (c === "/" && src[i + 1] === "/") {
      let j = i + 2
      while (j < n && src[j] !== "\n") j++
      push(src.slice(i, j), "com")
      prev = ""
      i = j
      continue
    }

    // string / template (whole template, incl. ${…}, colored as one string)
    if (c === "`" || c === '"' || c === "'") {
      let j = i + 1
      while (j < n) {
        if (src[j] === "\\") {
          j += 2
          continue
        }
        if (src[j] === c) {
          j++
          break
        }
        j++
      }
      push(src.slice(i, j), "str")
      prev = c
      i = j
      continue
    }

    if (isDigit(c)) {
      let j = i + 1
      while (j < n && (isDigit(src[j]!) || src[j] === ".")) j++
      push(src.slice(i, j), "num")
      prev = "0"
      i = j
      continue
    }

    // JSX tag: `</name` is unambiguously a closing tag (highlight it wherever
    // it appears, e.g. `failed</p>`); `<name` only *opens* a tag in expression
    // position, so generics like `collection<Todo>` aren't mistaken for tags.
    const afterLt = src[i + 1] ?? ""
    if (
      c === "<" &&
      (afterLt === "/" || (isExprPos(prev) && /[A-Za-z]/.test(afterLt)))
    ) {
      let j = i + 1
      let open = "<"
      if (src[j] === "/") {
        open = "</"
        j++
      }
      let k = j
      while (k < n && /[A-Za-z0-9_.]/.test(src[k]!)) k++
      const name = src.slice(j, k)
      push(open, "punct")
      push(name, "tag")
      prev = name ? name[name.length - 1]! : "<"
      i = k
      continue
    }

    if (isIdentStart(c)) {
      let j = i + 1
      while (j < n && isIdent(src[j]!)) j++
      const word = src.slice(i, j)
      let kind: Token["kind"] = "plain"
      if (KEYWORDS.has(word)) kind = "kw"
      else if (/^[A-Z]/.test(word)) kind = "type"
      else {
        let p = j
        while (p < n && src[p] === " ") p++
        if (src[p] === "(") kind = "fn"
      }
      push(word, kind)
      prev = word[word.length - 1]!
      i = j
      continue
    }

    // punctuation / operators — group a run (but never swallow a `<`, which is
    // re-decided at the top of the loop as either a JSX open or less-than)
    const PUNCT = /[{}()[\].,;:=+\-*/%!&|?>~^@]/
    let j = i + 1
    while (j < n && PUNCT.test(src[j]!)) j++
    push(src.slice(i, j), "punct")
    prev = src[j - 1]!
    i = j
  }

  return toks
}
