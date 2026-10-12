// rynth/vt/expr/lexer.js — tokenizer for the VTank/UB expression language
// (PLAN §3.4 "Tokens" + the D14 whitespace rule). No imports, no side effects.
//
// Outside backticks the specials are  ( ) [ ] { } , ; # + - * / % < > = ! & | ^ ~ $
// plus the backtick, and `:` while directly inside a `{…}` index (UB slices,
// `spellname[$1]{10:}` in the corpus missingLegendaries meta). `\X` yields the
// literal character X (part of a string token). A string token ("text") is a
// maximal run of non-special characters INCLUDING spaces. Inside backticks
// everything is literal except "\`" (a literal backtick); nested levels write
// "\\`", which this rule turns into "\`" for the next evaluation level.
//
// Whitespace rule (D14, both modes): the leading/trailing (unescaped)
// whitespace of a text token is removed on a side whose neighbour is a
// comparison or logical operator, a bracket/paren/brace, an argument comma,
// `=`, a unary `!`/`~`, `$`, a backtick string, or the start/end of the
// expression; it is KEPT next to `+ - * / % # ;` (and the bitwise operators),
// so `chatbox[\/t +x]` keeps "/t ". A text token made only of unescaped
// whitespace is dropped (it is never an operand).

const SINGLE = new Set(["(", ")", "[", "]", "{", "}", ",", ";", "#", "+", "-", "*", "/", "%", "<", ">", "=", "!", "&", "|", "^", "~", "$"]);
const DOUBLE = new Set(["==", "!=", "<=", ">=", "&&", "||", "<<", ">>"]);
const TRIM_NEIGHBOUR_OPS = new Set([
  "(", ")", "[", "]", "{", "}", ",", ":",
  "==", "!=", "<", "<=", ">", ">=", "&&", "||",
  "=", "!", "~", "$",
]);
const OPENERS = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set([")", "]", "}"]);

function isWs(ch) {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\v" || ch === " ";
}

// → { ok: true, tokens } | { ok: false, error, pos }
// token = { type: "op", v, s, e } | { type: "bt", v, s, e }
//       | { type: "text", text /* side-trimmed */, trim /* fully trimmed */, s, e }
export function lex(src) {
  const s = String(src ?? "");
  const n = s.length;
  const raw = [];
  const stack = [];
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === "`") {
      let j = i + 1;
      let buf = "";
      let closed = false;
      while (j < n) {
        const d = s[j];
        if (d === "\\" && s[j + 1] === "`") {
          buf += "`";
          j += 2;
          continue;
        }
        if (d === "`") {
          closed = true;
          break;
        }
        buf += d;
        j++;
      }
      if (!closed) return { ok: false, error: "unterminated backtick string", pos: i };
      raw.push({ type: "bt", v: buf, s: i, e: j + 1 });
      i = j + 1;
      continue;
    }
    const inBrace = stack.length > 0 && stack[stack.length - 1] === "{";
    if (c === ":" && inBrace) {
      raw.push({ type: "op", v: ":", s: i, e: i + 1 });
      i++;
      continue;
    }
    if (SINGLE.has(c)) {
      const two = s.substr(i, 2);
      if (DOUBLE.has(two)) {
        raw.push({ type: "op", v: two, s: i, e: i + 2 });
        i += 2;
        continue;
      }
      raw.push({ type: "op", v: c, s: i, e: i + 1 });
      if (OPENERS[c]) stack.push(c);
      else if (CLOSERS.has(c) && stack.length && OPENERS[stack[stack.length - 1]] === c) stack.pop();
      i++;
      continue;
    }
    // text run
    const start = i;
    const chars = [];
    const esc = [];
    while (i < n) {
      const d = s[i];
      if (d === "\\") {
        if (i + 1 < n) {
          chars.push(s[i + 1]);
          esc.push(true);
          i += 2;
        } else {
          chars.push("\\");
          esc.push(true);
          i++;
        }
        continue;
      }
      if (d === "`" || SINGLE.has(d) || (d === ":" && inBrace)) break;
      chars.push(d);
      esc.push(false);
      i++;
    }
    raw.push({ type: "text", chars, esc, s: start, e: i });
  }

  // D14 whitespace rule (post-pass: needs both neighbours).
  const tokens = [];
  for (let k = 0; k < raw.length; k++) {
    const t = raw[k];
    if (t.type !== "text") {
      tokens.push(t);
      continue;
    }
    const len = t.chars.length;
    let lead = 0;
    while (lead < len && !t.esc[lead] && isWs(t.chars[lead])) lead++;
    if (lead === len) continue; // whitespace-only: never an operand
    let trail = 0;
    while (trail < len - lead && !t.esc[len - 1 - trail] && isWs(t.chars[len - 1 - trail])) trail++;
    const left = k > 0 ? raw[k - 1] : null;
    const right = k + 1 < raw.length ? raw[k + 1] : null;
    const trimL = !left || left.type === "bt" || (left.type === "op" && TRIM_NEIGHBOUR_OPS.has(left.v));
    const trimR = !right || right.type === "bt" || (right.type === "op" && TRIM_NEIGHBOUR_OPS.has(right.v));
    const from = trimL ? lead : 0;
    const to = trimR ? len - trail : len;
    tokens.push({
      type: "text",
      text: t.chars.slice(from, to).join(""),
      trim: t.chars.slice(lead, len - trail).join(""),
      s: t.s,
      e: t.e,
    });
  }
  return { ok: true, tokens };
}
