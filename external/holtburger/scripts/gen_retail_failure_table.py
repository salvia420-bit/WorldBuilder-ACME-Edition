#!/usr/bin/env python3
"""chat-errors-2 (2026-10-13): generate the retail failure-text table.

Retail `ClientCommunicationSystem::HandleFailureEvent` (acclient.c:413716)
is the one place the client turns a WeenieError code into chat text: both
`Handle_Communication__WeenieError` (:420742, user_data = null string) and
`…WeenieErrorWithString` (:422430) and `Handle_Item__UseDone` (:401924)
call it. This script walks that function and emits, for every case that
prints, the exact text and the `ClientSystem::AddTextToScroll` text type
(0 = default/System, 7 = Magic, 0x1A = the transient spew box):

    crates/holtburger-core/src/retail_failure_table.rs

The output is checked in (it is NOT generated at build time). Re-run after
touching this script:

    python3 scripts/gen_retail_failure_table.py            # rewrite
    python3 scripts/gen_retail_failure_table.py --check    # diff only

Arm shapes handled (all re-derived from the decomp; nothing ported):
- `PStringBase(&vN, L"...")` constants, and `set(&msg, L"...")`.
- `sprintf(&msg, L"fmt", user_data…)`: every `%s` becomes `{}` (each is
  substituted with the same parameter — retail passes user_data each time).
  Retail's literal `$s` (0x4F, 0x4F4) is NOT a format specifier and stays.
- `operator=(&msg, user_data)` + `operator+=(&msg, &vN)` suffixes, and the
  `vK = operator+(a, &tmp, b)` chains (0x4F7-0x4F9, 0x4DE/0x4DF).
- The named globals `cant_jump_*_0` (0x24/0x48/0x49), resolved from their
  `_wcscpy` initialisers.
- Shared `LABEL_xxx:` exits: a `goto` to a label whose next statement is
  `AddTextToScroll(v4, &msg, T, …)` prints `msg` at type T.
- `if ( etype == N )` arms, and `if ( etype != N ) { … }` blocks whose
  fall-through after the block is N's arm (1256, 1006).
- `case X: goto $Lnnn;` aliases (0x1E shares 0x4CE's arm).
- Notice-only arms (`CM_Character::SendNotice_AbuseReportResponse`,
  0x4B8-0x4BA) print nothing: listed in `RETAIL_FAILURE_NOTICE_ONLY`.
- Arms that print "item" for an empty user_data (0x4BF/0x4C0): listed in
  `RETAIL_FAILURE_ITEM_FALLBACK`.
- `default:` prints nothing and emits no entry.

The trailing `\\n` of a literal is stripped (AddTextToScroll line ends);
retail's double spaces and typos are kept verbatim.
"""

import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DEFAULT_DECOMP = "/home/wbterminal/ac-headers/acclient.c"
DEFAULT_OUT = os.path.join(REPO, "crates", "holtburger-core", "src", "retail_failure_table.rs")

DEF_RE = re.compile(
    r"^void __thiscall ClientCommunicationSystem::HandleFailureEvent\(.*\)\s*$"
)
CASE_RE = re.compile(r"^case (0x[0-9A-Fa-f]+|\d+)u?:$")
LABEL_RE = re.compile(r"^(LABEL_\d+|\$L\d+):$")
DEFAULT_RE = re.compile(r"^default:$")
IF_EQ_RE = re.compile(r"^if \(\s*etype == (0x[0-9A-Fa-f]+|\d+)u?\s*\)$")
IF_NE_RE = re.compile(r"^if \(\s*etype != (0x[0-9A-Fa-f]+|\d+)u?\s*\)$")
GOTO_RE = re.compile(r"^goto (LABEL_\d+|\$L\d+);$")
# `&var` (a built string / a named global) or bare `user_data` (0x55E).
ADD_RE = re.compile(r"ClientSystem::AddTextToScroll\(v4, &?(\w+), (0x[0-9A-Fa-f]+|\d+)u?, 1, 0\);$")
CTOR_RE = re.compile(r'^PStringBase<unsigned short>::PStringBase<unsigned short>\(&(\w+), L"((?:[^"\\]|\\.)*)"\);$')
# The formatting constructor `PStringBase(&s, 0, L"fmt", user_data…)` (0x51F).
CTOR_FMT_RE = re.compile(
    r'^PStringBase<unsigned short>::PStringBase<unsigned short>\(&(\w+), 0, L"((?:[^"\\]|\\.)*)"(.*)\);$'
)
SET_RE = re.compile(r'^PStringBase<unsigned short>::set\(&(\w+), L"((?:[^"\\]|\\.)*)"\);$')
SPRINTF_RE = re.compile(r'^PStringBase<unsigned short>::sprintf\(\s*&(\w+),\s*L"((?:[^"\\]|\\.)*)"(.*)\);$')
ASSIGN_RE = re.compile(r"^PStringBase<unsigned short>::operator=\(&(\w+), (.+)\);$")
APPEND_RE = re.compile(r"^PStringBase<unsigned short>::operator\+=\(&(\w+), (.+)\);$")
PLUS_RE = re.compile(
    r"^(\w+) = (?:\([^)]*\))?PStringBase<unsigned short>::operator\+\((\S+), &(\w+), (\S+)\);$"
)
WCSCPY_RE = re.compile(r'_wcscpy\((\w+)\.m_charbuffer->m_data, L"((?:[^"\\]|\\.)*)"\);')
NOTICE_RE = re.compile(r"CM_Character::SendNotice_\w+\(etype\);$")


def parse_int(tok):
    return int(tok, 16) if tok.lower().startswith("0x") else int(tok)


def unescape(lit):
    """Decode a C wide-string literal body (only the escapes the decomp uses)."""
    out = []
    i = 0
    while i < len(lit):
        c = lit[i]
        if c == "\\" and i + 1 < len(lit):
            n = lit[i + 1]
            out.append({"n": "\n", "t": "\t", '"': '"', "\\": "\\", "'": "'"}.get(n, "\\" + n))
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def strip_literals(s):
    return re.sub(r'L?"(?:[^"\\]|\\.)*"', '""', s)


def load_function(decomp_path):
    with open(decomp_path, "rb") as fh:
        raw = fh.read().decode("utf-8", errors="replace")
    lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    start = None
    for i, line in enumerate(lines):
        if DEF_RE.match(line):
            start = i
            break
    if start is None:
        sys.exit("HandleFailureEvent definition not found in " + decomp_path)
    end = None
    for j in range(start + 1, len(lines)):
        if lines[j] == "}":
            end = j
            break
    if end is None:
        sys.exit("HandleFailureEvent body end not found")
    globals_ = {m.group(1): unescape(m.group(2)) for m in WCSCPY_RE.finditer(raw)}
    return start + 1, lines[start + 1 : end + 1], globals_


def statements(body):
    """Join the decomp's wrapped lines into whole statements."""
    buf = ""
    for raw in body:
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        if not buf and (CASE_RE.match(line) or LABEL_RE.match(line) or DEFAULT_RE.match(line)):
            yield line
            continue
        # `sprintf(\n  &msg,\n  L"..",\n  user_data);` joins back to
        # `sprintf(&msg, L"..", user_data);` (no space after the open paren).
        if buf:
            buf = buf + ("" if buf.endswith("(") else " ") + line
        else:
            buf = line
        flat = strip_literals(buf)
        if flat.count("(") != flat.count(")"):
            continue
        if (
            buf.endswith(";")
            or buf in ("{", "}", "else")
            or re.match(r"^(if|else if|switch|while|for)\b", buf)
        ):
            yield buf
            buf = ""
    if buf:
        sys.exit("unterminated statement: " + buf)


def fmt_text(lit):
    text = unescape(lit)
    if "{" in text or "}" in text:
        sys.exit("literal contains a brace: " + text)
    bad = re.findall(r"%[^s]", text)
    if bad:
        sys.exit("unsupported format specifier %r in %r" % (bad, text))
    return text.replace("%s", "{}")


def generate(decomp_path):
    first_line, body, globals_ = load_function(decomp_path)
    stmts = list(statements(body))

    # Pre-pass: the text type each shared exit label prints `msg` at.
    label_type = {}
    for i, s in enumerate(stmts):
        m = LABEL_RE.match(s)
        if m and m.group(1).startswith("LABEL_"):
            for nxt in stmts[i + 1 :]:
                if LABEL_RE.match(nxt):
                    continue
                a = ADD_RE.search(nxt)
                if a and a.group(1) == "msg":
                    label_type[m.group(1)] = parse_int(a.group(2))
                break

    arms = []  # [codes, text, type] — one per printing arm
    notice_only = set()
    item_fallback = set()
    aliases = {}  # code -> $L label
    label_codes = {}  # $L label -> codes active there
    codes = []
    cur = None  # index into `arms` of the arm now printing
    last_was_case = False
    env = {}
    depth = 0
    ne_stack = []  # (depth inside the block, N)

    def val(tok):
        tok = tok.strip()
        tok = re.sub(r"^\([^)]*\)", "", tok).strip()
        if tok == "user_data":
            return "{}"
        if tok.startswith("&"):
            tok = tok[1:]
        if tok in env:
            return env[tok]
        sys.exit("unknown string operand %r (codes %s)" % (tok, [hex(c) for c in codes]))

    def emit(text, ttype):
        # One arm may print in pieces (0x53B: "Banned Characters: ", then
        # user_data, then "\n" — one scroll line); join them.
        nonlocal cur
        if not codes:
            return
        if text is None:
            sys.exit("emit without text for %s" % [hex(c) for c in codes])
        if cur is not None and arms[cur][0] == codes:
            if arms[cur][2] != ttype:
                sys.exit("arm %s prints at two text types" % [hex(c) for c in codes])
            arms[cur][1] += text
        else:
            arms.append([list(codes), text, ttype])
            cur = len(arms) - 1

    def end_arm():
        nonlocal codes, cur
        codes = []
        cur = None

    for s in stmts:
        m = CASE_RE.match(s)
        if m:
            if not last_was_case:
                end_arm()
                env = {}
            codes.append(parse_int(m.group(1)))
            last_was_case = True
            continue
        last_was_case = False
        if DEFAULT_RE.match(s) or s == "break;":
            end_arm()
            env = {}
            continue
        m = LABEL_RE.match(s)
        if m:
            if m.group(1).startswith("$L"):
                label_codes[m.group(1)] = list(codes)
            continue
        m = IF_EQ_RE.match(s)
        if m:
            end_arm()
            codes = [parse_int(m.group(1))]
            env = {}
            continue
        m = IF_NE_RE.match(s)
        if m:
            ne_stack.append((depth + 1, parse_int(m.group(1))))
            continue
        if s == "{":
            depth += 1
            continue
        if s == "}":
            if ne_stack and ne_stack[-1][0] == depth:
                _, n = ne_stack.pop()
                end_arm()
                codes = [n]
                env = {}
            depth -= 1
            continue
        m = GOTO_RE.match(s)
        if m:
            # Every goto leaves the arm: to a shared print exit (LABEL_207 …),
            # to the common tail (LABEL_376 / LABEL_377), or to another arm.
            target = m.group(1)
            if target.startswith("$L"):
                for c in codes:
                    aliases[c] = target
            elif target in label_type and "msg" in env:
                emit(env["msg"], label_type[target])
            end_arm()
            continue
        if NOTICE_RE.search(s):
            notice_only.update(codes)
            end_arm()
            continue
        a = ADD_RE.search(s)
        if a:
            var, ttype = a.group(1), parse_int(a.group(2))
            if var == "user_data":
                text = "{}"
            elif var.endswith("_0") and var in globals_:
                text = globals_[var]
            else:
                text = env.get(var)
            emit(text, ttype)
            continue
        m = CTOR_RE.match(s)
        if m:
            env[m.group(1)] = fmt_text(m.group(2))
            if m.group(2) == "item":
                item_fallback.update(codes)
            continue
        m = CTOR_FMT_RE.match(s) or SET_RE.match(s)
        if m:
            env[m.group(1)] = fmt_text(m.group(2))
            continue
        m = SPRINTF_RE.match(s)
        if m:
            env[m.group(1)] = fmt_text(m.group(2))
            continue
        m = PLUS_RE.match(s)
        if m:
            joined = val(m.group(2)) + val(m.group(4))
            env[m.group(1)] = joined
            env[m.group(3)] = joined
            continue
        m = ASSIGN_RE.match(s)
        if m:
            env[m.group(1)] = val(m.group(2))
            continue
        m = APPEND_RE.match(s)
        if m:
            env[m.group(1)] = env.get(m.group(1), "") + val(m.group(2))
            continue
        if re.search(r'L"item"', s):
            item_fallback.update(codes)
        # Anything else (destructors, `v7 = &vN;`, the abort-attack prologue,
        # SetGroundObject, the 0x529 plugin poke) carries no text.

    entries = {}  # code -> (text, type)
    for arm_codes, text, ttype in arms:
        if text.endswith("\n"):
            text = text[:-1]
        if "\n" in text:
            sys.exit("embedded newline in %s: %r" % ([hex(c) for c in arm_codes], text))
        for c in arm_codes:
            prev = entries.get(c)
            if prev is not None and prev != (text, ttype):
                sys.exit("code %#x printed twice: %r vs %r" % (c, prev, (text, ttype)))
            entries[c] = (text, ttype)

    for code, label in aliases.items():
        target = label_codes.get(label)
        if not target or target[0] not in entries:
            sys.exit("alias %#x -> %s unresolved" % (code, label))
        entries[code] = entries[target[0]]

    for c in item_fallback:
        if c not in entries:
            sys.exit("item fallback for a code with no entry: %#x" % c)
    return first_line, entries, sorted(notice_only), sorted(item_fallback)


def rust_str(text):
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def render(first_line, entries, notice_only, item_fallback):
    out = []
    out.append("// @generated by scripts/gen_retail_failure_table.py — do not edit by hand.")
    out.append("//")
    out.append("// chat-errors-2 (2026-10-13): every case of retail")
    out.append("// `ClientCommunicationSystem::HandleFailureEvent` (acclient.c:%d) that" % first_line)
    out.append("// prints, as (WeenieError code, text, AddTextToScroll text type). `{}` marks")
    out.append("// each `%s` of the retail sprintf (all of them take the same user_data);")
    out.append("// the trailing `\\n` is stripped; retail's double spaces, typos and the")
    out.append("// literal `$s` of 0x4F / 0x4F4 are kept. Text types: 0 = System,")
    out.append("// 7 = Magic, 0x1A = the transient spew box. Sorted by code.")
    out.append("")
    out.append("/// (code, text, retail text type), sorted by code.")
    out.append("#[rustfmt::skip]")
    out.append("pub static RETAIL_FAILURE: &[(u32, &str, u8)] = &[")
    for code in sorted(entries):
        text, ttype = entries[code]
        if ttype > 0xFF:
            sys.exit("text type %#x does not fit u8" % ttype)
        out.append("    (0x%04X, %s, 0x%02X)," % (code, rust_str(text), ttype))
    out.append("];")
    out.append("")
    out.append("/// Codes whose arm only raises `CM_Character::SendNotice_AbuseReportResponse`")
    out.append("/// (no chat text).")
    out.append(
        "pub static RETAIL_FAILURE_NOTICE_ONLY: &[u32] = &[%s];"
        % ", ".join("0x%04X" % c for c in notice_only)
    )
    out.append("")
    out.append('/// Codes whose arm prints "item" in place of an empty user_data.')
    out.append(
        "pub static RETAIL_FAILURE_ITEM_FALLBACK: &[u32] = &[%s];"
        % ", ".join("0x%04X" % c for c in item_fallback)
    )
    out.append("")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--decomp", default=DEFAULT_DECOMP)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--check", action="store_true", help="exit 1 if --out differs")
    ap.add_argument("--stdout", action="store_true", help="print instead of writing")
    args = ap.parse_args()
    first_line, entries, notice_only, item_fallback = generate(args.decomp)
    text = render(first_line, entries, notice_only, item_fallback)
    counts = {}
    for _, t in entries.values():
        counts[t] = counts.get(t, 0) + 1
    summary = "%d entries (%s), %d notice-only, %d item-fallback" % (
        len(entries),
        ", ".join("type %#x: %d" % (t, n) for t, n in sorted(counts.items())),
        len(notice_only),
        len(item_fallback),
    )
    if args.stdout:
        sys.stdout.write(text)
        print(summary, file=sys.stderr)
        return 0
    if args.check:
        try:
            with open(args.out, encoding="utf-8") as fh:
                current = fh.read()
        except FileNotFoundError:
            current = ""
        if current != text:
            print("retail_failure_table.rs is stale: re-run the generator", file=sys.stderr)
            return 1
        print("up to date: " + summary)
        return 0
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(text)
    print("wrote %s: %s" % (args.out, summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
