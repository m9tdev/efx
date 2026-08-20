// Pure core of the comment line-width tool: reflow logic only, no filesystem
// or process. `comment-width.mjs` is the shell (file list, write, report,
// exit code); `comment-width.test.mjs` pins the tricky comment shapes.

export const WIDTH = 80

const COMMENT = /^(\s*)(\/\/\/?|\*(?!\/)|\/\*\*?)( ?)(.*)$/
const exempt = (text) =>
  /https?:\/\//.test(text) ||
  /\|.*\|/.test(text) ||
  /^[\s^~-]+$/.test(text) ||
  /^@ts-|^eslint-|^oxlint-|^biome-|^prettier-/.test(text) || // directives
  /^\s*[─│┌└├]/.test(text) // section headers / box drawings
// A line that must start its own paragraph (list item, heading, code fence,
// JSDoc tag, separator, blank comment line).
const LIST = /^(\s*)([-*•]|\d+[.)])\s+/
const startsBlock = (text) =>
  text === "" ||
  LIST.test(text) ||
  /^\s{2,}/.test(text) || // indented: code sample, aligned table, diagram
  /^(@\w|```|─|#|\(\d+\)|-{3,}|\*{3,}|\s*[│┌└├])/.test(text)

/**
 * Scan one file's source for over-width comment paragraphs; reflow them when
 * `fix`. Returns `{ text, paragraphs, changed }`: the (possibly rewritten)
 * source, the count of overflowing paragraphs, and whether `text` differs
 * from `src`.
 */
export const processSource = (src, { width = WIDTH, fix = false } = {}) => {
  const lines = src.split("\n")
  const out = []
  let bad = 0
  let i = 0
  let changed = false
  while (i < lines.length) {
    // Single-line `/** text */` (or `/* text */`) longer than width: expand
    // into a block comment and reflow it.
    const one = /^(\s*)(\/\*\*?) (.*?) \*\/$/.exec(lines[i])
    if (one) {
      const [, ind, open, text] = one
      if (lines[i].length <= width || exempt(text)) {
        out.push(lines[i++])
        continue
      }
      bad++
      if (!fix) {
        out.push(lines[i++])
        continue
      }
      out.push(`${ind}${open}`)
      let cur = ""
      for (const w of text.split(/\s+/).filter(Boolean)) {
        const cand = cur === "" ? w : cur + " " + w
        if ((`${ind} * ` + cand).length > width && cur !== "") {
          out.push(`${ind} * ${cur}`)
          cur = w
        } else cur = cand
      }
      if (cur) out.push(`${ind} * ${cur}`)
      out.push(`${ind} */`)
      changed = true
      i++
      continue
    }
    const m = COMMENT.exec(lines[i])
    if (!m) {
      out.push(lines[i++])
      continue
    }
    // Collect a run of same-style comment lines.
    const [, indent, marker] = m
    const run = []
    while (i < lines.length) {
      const mm = COMMENT.exec(lines[i])
      if (!mm || mm[1] !== indent || mm[2] !== marker) break
      run.push(mm[4])
      i++
    }
    // Split the run into paragraphs; reflow those that overflow.
    const prefix = `${indent}${marker} `
    const bare = `${indent}${marker}`
    let p = 0
    let inFence = false
    while (p < run.length) {
      const para = [run[p]]
      p++
      const head = para[0]
      if (/^\s*```/.test(head)) inFence = !inFence
      if (inFence || /^\s*```/.test(head)) {
        // Fenced code in a comment: verbatim.
        out.push(head === "" ? bare : prefix + head)
        continue
      }
      const listItem = LIST.exec(head)
      // Indented text: prose (a sub-paragraph under a `───` header, wrapped
      // with its indent as the hang) or code/diagram (never reflowed).
      const indented = !listItem && /^(\s{2,})/.exec(head)
      const looksLikeCode =
        indented &&
        (/=>|;\s*$|^\s*[<{}]|^\s*(const|let|yield|return|import|export|await)\b/.test(
          head,
        ) ||
          !/^\s+[A-Za-z`*(]/.test(head))
      const hang = listItem
        ? " ".repeat(listItem[0].length)
        : indented
          ? indented[1]
          : ""
      const indentedHead = Boolean(looksLikeCode)
      // A paragraph continues over non-block lines; a list item's continuation
      // lines are the ones indented by its hang.
      while (
        head !== "" &&
        p < run.length &&
        (indented && !looksLikeCode
          ? run[p].startsWith(hang) &&
            !/^\s{2,}/.test(run[p].slice(hang.length)) &&
            !LIST.test(run[p]) &&
            run[p].trim() !== ""
          : listItem
            ? // a list item's continuation lines are indented by its hang
              run[p].startsWith(hang) &&
              !LIST.test(run[p]) &&
              run[p].trim() !== ""
            : !startsBlock(run[p]))
      ) {
        para.push(run[p])
        p++
      }
      const overflow = para.some((t) => (prefix + t).length > width)
      const anyExempt = para.some(exempt) || indentedHead
      if (!overflow || anyExempt || head === "") {
        for (const t of para) out.push(t === "" ? bare : prefix + t)
        continue
      }
      bad++
      if (!fix) {
        for (const t of para) out.push(prefix + t)
        continue
      }
      // Reflow: join words, wrap at width; list items keep a hanging indent.
      const joined = para
        .map((t, k) =>
          k === 0
            ? listItem
              ? t // the marker stays; hang re-indents continuations
              : t.slice(hang.length)
            : t.startsWith(hang)
              ? t.slice(hang.length)
              : t,
        )
        .join(" ")
      // Tokens: whitespace-separated, but a `code span` (with any trailing
      // punctuation) is one token — never split inside backticks.
      const words = joined.match(/[^\s`]*`[^`]*`[^\s`]*|[^\s`]+|`/g) ?? []
      let cur = ""
      let first = true
      for (const w of words) {
        const lead = first && listItem ? "" : hang
        const cand = cur === "" ? lead + w : cur + " " + w
        if ((prefix + cand).length > width && cur !== "") {
          out.push(prefix + cur)
          cur = hang + w
          first = false
        } else cur = cand
      }
      if (cur !== "") out.push(prefix + cur)
      changed = true
    }
  }
  return { text: out.join("\n"), paragraphs: bad, changed }
}

/**
 * Comment lines still over `width` after (or without) a fix, `{ line,
 * length }` with 1-indexed line numbers — the ones a fix cannot shorten
 * (directive, header, code sample). URLs are excluded: those cannot be
 * shortened by hand either.
 */
export const overlongCommentLines = (src, { width = WIDTH } = {}) => {
  const out = []
  src.split("\n").forEach((l, i) => {
    if (
      l.length > width &&
      /^\s*(\/\/|\*|\/\*)/.test(l) &&
      !/https?:\/\//.test(l)
    )
      out.push({ line: i + 1, length: l.length })
  })
  return out
}
