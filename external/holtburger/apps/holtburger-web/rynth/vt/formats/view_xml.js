// rynth/vt/formats/view_xml.js — safe Virindi meta-view XML → ViewModel
// (W1-3 FMT, PLAN §3.6, §2.9 X6, D25; U5 §7).
//
// The XML comes from user-supplied metas (CreateView), so it is parsed by a
// small whitelist tokenizer of our own — no browser XML parser (node tests and
// the page behave the same), no HTML strings built anywhere, no entity
// definitions (a DOCTYPE is skipped; only the five XML entities and numeric
// character references are decoded), bounded size/depth/control count.
//
//   elements   view, control                — anything else is dropped WITH its
//                                               whole subtree (e.g. <script>)
//   attributes title width height type name left top text setstate actionexpr
//              checked                       — anything else (on*, style, …) is
//                                               dropped with a warning
//
// Real view (CORPUS ColRings, U5 §7): <view width title height><control
// type="layout"> + absolutely positioned buttons with setstate/actionexpr.
// `layout` controls are containers: their children are flattened into
// `controls` with the layout's left/top added. Control types map to
// button | label | checkbox | textbox; every other type is kept as
// "unsupported" (with `origType`) so the renderer can draw an inert
// placeholder.
//
// parseViewXml(xml) → { ok, model?: ViewModel, warnings: string[], error? }
// ViewModel = { title, width, height, controls: Array<{ type, name, left, top,
//   width, height, text, setstate?, actionexpr?, checked?, origType? }> }

const MAX_XML = 128 * 1024;
const MAX_DEPTH = 32;
const MAX_CONTROLS = 256;
const MAX_WARNINGS = 64;

const VIEW_ATTRS = new Set(["title", "width", "height"]);
const CONTROL_ATTRS = new Set(["type", "name", "left", "top", "width", "height", "text", "setstate", "actionexpr", "checked"]);
const TYPE_MAP = {
  button: "button",
  pushbutton: "button",
  label: "label",
  staticlabel: "label",
  statictext: "label",
  text: "label",
  checkbox: "checkbox",
  textbox: "textbox",
  edit: "textbox",
  input: "textbox",
};
const CONTAINERS = new Set(["layout", "fixedlayout"]);
const RAW_TEXT = new Set(["script", "style"]);
const RAW_END = { script: /<\/script/gi, style: /<\/style/gi }; // raw-text end tags; lastIndex is set before every exec

const NAME_RE = /^[A-Za-z_:][-A-Za-z0-9_:.]*/;

function decodeEntities(s, warn) {
  return s.replace(/&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z]+);/g, (m, ent) => {
    switch (ent) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
    }
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
    }
    warn(`unknown entity ${m} kept as text`);
    return m;
  });
}

class XmlError extends Error {}

// Tokenise into a tree of { name, attrs: Map, children }. Text, comments,
// processing instructions, CDATA and DOCTYPE are skipped.
function tokenize(xml, warn) {
  const root = { name: "#root", attrs: new Map(), children: [], parent: null };
  let cur = root;
  let depth = 0;
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    i = lt;
    if (xml.startsWith("<!--", i)) {
      const e = xml.indexOf("-->", i + 4);
      if (e < 0) throw new XmlError("unterminated comment");
      i = e + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", i)) {
      const e = xml.indexOf("]]>", i + 9);
      if (e < 0) throw new XmlError("unterminated CDATA section");
      i = e + 3;
      continue;
    }
    if (xml.startsWith("<?", i)) {
      const e = xml.indexOf("?>", i + 2);
      if (e < 0) throw new XmlError("unterminated processing instruction");
      i = e + 2;
      continue;
    }
    if (xml.startsWith("<!", i)) {
      // DOCTYPE / declarations: skipped (an internal subset is skipped whole;
      // entities it declares are never expanded).
      let j = i + 2;
      let bracket = 0;
      while (j < n) {
        const c = xml[j];
        if (c === "[") bracket++;
        else if (c === "]") bracket = Math.max(0, bracket - 1);
        else if (c === ">" && bracket === 0) break;
        j++;
      }
      if (j >= n) throw new XmlError("unterminated declaration");
      warn("XML declaration/DOCTYPE skipped");
      i = j + 1;
      continue;
    }
    if (xml[i + 1] === "/") {
      const m = NAME_RE.exec(xml.slice(i + 2, i + 2 + 128));
      const e = xml.indexOf(">", i);
      if (!m || e < 0) throw new XmlError("malformed closing tag");
      const name = m[0].toLowerCase();
      if (cur.name === name) {
        cur = cur.parent;
        depth--;
      } else {
        // Close the nearest open element of that name (lenient), else ignore.
        let k = cur;
        while (k && k.name !== name) k = k.parent;
        if (k && k !== root) {
          warn(`</${name}> closes unclosed element(s)`);
          while (cur !== k) {
            cur = cur.parent;
            depth--;
          }
          cur = cur.parent;
          depth--;
        } else warn(`stray </${name}> ignored`);
      }
      i = e + 1;
      continue;
    }
    // Start tag.
    const m = NAME_RE.exec(xml.slice(i + 1, i + 1 + 128));
    if (!m) throw new XmlError(`malformed tag at offset ${i}`);
    const name = m[0].toLowerCase();
    let j = i + 1 + m[0].length;
    const attrs = new Map();
    let selfClose = false;
    for (;;) {
      while (j < n && /\s/.test(xml[j])) j++;
      if (j >= n) throw new XmlError(`unterminated <${name}> tag`);
      if (xml[j] === ">") {
        j++;
        break;
      }
      if (xml[j] === "/" && xml[j + 1] === ">") {
        selfClose = true;
        j += 2;
        break;
      }
      const am = NAME_RE.exec(xml.slice(j, j + 128));
      if (!am) throw new XmlError(`malformed attribute in <${name}>`);
      const aname = am[0].toLowerCase();
      j += am[0].length;
      while (j < n && /\s/.test(xml[j])) j++;
      let value = "";
      if (xml[j] === "=") {
        j++;
        while (j < n && /\s/.test(xml[j])) j++;
        const quote = xml[j];
        if (quote === '"' || quote === "'") {
          const e = xml.indexOf(quote, j + 1);
          if (e < 0) throw new XmlError(`unterminated attribute ${aname} in <${name}>`);
          value = xml.slice(j + 1, e);
          j = e + 1;
        } else {
          let e = j;
          while (e < n && !/[\s>]/.test(xml[e]) && !(xml[e] === "/" && xml[e + 1] === ">")) e++;
          value = xml.slice(j, e);
          j = e;
          warn(`unquoted attribute ${aname} in <${name}>`);
        }
      } else warn(`attribute ${aname} in <${name}> has no value`);
      if (attrs.has(aname)) warn(`duplicate attribute ${aname} in <${name}> (first kept)`);
      else attrs.set(aname, decodeEntities(value, warn));
    }
    const el = { name, attrs, children: [], parent: cur };
    cur.children.push(el);
    if (!selfClose && RAW_TEXT.has(name)) {
      // <script>/<style> bodies are raw text: skip to the closing tag whole.
      // Case-insensitive search on the ORIGINAL string (a lower-cased copy can
      // change length, e.g. "İ", and shift every index after it).
      const endRe = RAW_END[name];
      endRe.lastIndex = j;
      const hit = endRe.exec(xml);
      const close = hit ? hit.index : -1;
      const e = close < 0 ? -1 : xml.indexOf(">", close);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (!selfClose) {
      if (depth + 1 > MAX_DEPTH) throw new XmlError(`elements nested deeper than ${MAX_DEPTH}`);
      cur = el;
      depth++;
    }
    i = j;
  }
  if (cur !== root) warn(`unclosed <${cur.name}> element(s) at end of XML`);
  return root;
}

function intAttr(v) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function keepAttrs(el, allowed, warn, what) {
  const out = {};
  for (const [k, v] of el.attrs) {
    if (allowed.has(k)) out[k] = v;
    else if (/^on/i.test(k)) warn(`event attribute ${k} on <${what}> dropped`);
    else warn(`attribute ${k} on <${what}> dropped`);
  }
  return out;
}

/** Parse Virindi view XML into a safe ViewModel. Never throws. */
export function parseViewXml(xml) {
  const warnings = [];
  const seen = new Set();
  const warn = (msg) => {
    if (warnings.length >= MAX_WARNINGS || seen.has(msg)) return;
    seen.add(msg);
    warnings.push(msg);
  };
  if (typeof xml !== "string") return { ok: false, warnings, error: "view XML must be text" };
  if (xml.length > MAX_XML) return { ok: false, warnings, error: `view XML is larger than ${MAX_XML} bytes` };
  if (!xml.trim()) return { ok: false, warnings, error: "empty view XML" };
  let root;
  try {
    root = tokenize(xml, warn);
  } catch (e) {
    return { ok: false, warnings, error: `malformed view XML: ${e && e.message ? e.message : e}` };
  }
  // The first <view> anywhere at the top level.
  const views = root.children.filter((c) => c.name === "view");
  for (const c of root.children) if (c.name !== "view") warn(`element <${c.name}> outside <view> dropped`);
  if (!views.length) return { ok: false, warnings, error: "no <view> element" };
  if (views.length > 1) warn("more than one <view>: the first is used");
  const v = views[0];
  const va = keepAttrs(v, VIEW_ATTRS, warn, "view");
  const model = { title: String(va.title ?? ""), width: intAttr(va.width), height: intAttr(va.height), controls: [] };
  let truncated = false;
  const walk = (el, dx, dy) => {
    for (const c of el.children) {
      if (c.name !== "control") {
        warn(`element <${c.name}> dropped`);
        continue;
      }
      const a = keepAttrs(c, CONTROL_ATTRS, warn, "control");
      const origType = String(a.type ?? "").trim().toLowerCase();
      const left = intAttr(a.left) + dx;
      const top = intAttr(a.top) + dy;
      if (CONTAINERS.has(origType)) {
        walk(c, left, top);
        continue;
      }
      if (model.controls.length >= MAX_CONTROLS) {
        truncated = true;
        continue;
      }
      const type = TYPE_MAP[origType] || "unsupported";
      const ctl = {
        type,
        name: String(a.name ?? ""),
        left,
        top,
        width: intAttr(a.width),
        height: intAttr(a.height),
        text: String(a.text ?? ""),
      };
      if (a.setstate !== undefined) ctl.setstate = String(a.setstate);
      if (a.actionexpr !== undefined) ctl.actionexpr = String(a.actionexpr);
      if (type === "checkbox" || a.checked !== undefined) ctl.checked = /^(true|1|yes|checked)$/i.test(String(a.checked ?? "").trim());
      if (type === "unsupported") {
        ctl.origType = origType || "(none)";
        warn(`control type "${origType || "(none)"}" is not supported (inert placeholder)`);
      }
      model.controls.push(ctl);
      // Children of a non-layout control (tab pages, …) are flattened as well.
      if (c.children.length) walk(c, left, top);
    }
  };
  walk(v, 0, 0);
  if (truncated) warn(`more than ${MAX_CONTROLS} controls: the rest were dropped`);
  return { ok: true, model, warnings };
}

export default { parseViewXml };
