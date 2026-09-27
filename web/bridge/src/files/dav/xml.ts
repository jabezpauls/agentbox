/**
 * Just enough XML for WebDAV request bodies: elements, attributes, text,
 * CDATA, comments and namespaces, resolved to `{ns, local}` pairs so a
 * `<D:prop>` and a `<prop xmlns="DAV:">` read the same. A DOCTYPE is refused
 * outright — no DAV client sends one, and refusing it rules out entity
 * expansion and external entities in one stroke.
 */

export interface XmlElement {
  ns: string;
  local: string;
  attrs: Map<string, string>;
  children: XmlElement[];
  text: string;
}

export class XmlError extends Error {}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** A character XML 1.0 allows at all (its `Char` production). */
function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) => {
    if (e.startsWith("#")) {
      const cp = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!isXmlChar(cp)) throw new XmlError(`character reference ${m} is not an XML character`);
      return String.fromCodePoint(cp);
    }
    const v = ENTITIES[e];
    if (v === undefined) throw new XmlError(`unknown entity ${m}`);
    return v;
  });
}

const NAME = /[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?/y;

/** The XML name starting exactly at `at`, or null. */
function nameAt(src: string, at: number): string | null {
  NAME.lastIndex = at;
  return NAME.exec(src)?.[0] ?? null;
}

/**
 * Bounds on what a request body may hold. A WebDAV body is a handful of
 * elements; these stop a hostile one from costing more than a moment.
 */
export const XML_LIMITS = { elements: 10_000, attributes: 64, depth: 64 };

const XML_NS = "http://www.w3.org/XML/1998/namespace";

interface Frame {
  el: XmlElement;
  name: string;
  /** Only the namespaces this element itself declares; lookups walk the stack. */
  decls: Map<string, string> | null;
}

/** Parse a document and return its root element. */
export function parseXml(src: string): XmlElement {
  let i = 0;
  const stack: Frame[] = [];
  let root: XmlElement | null = null;
  let elements = 0;

  const fail = (msg: string): never => {
    throw new XmlError(`${msg} at ${i}`);
  };

  while (i < src.length) {
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i);
      if (end === -1) fail("unterminated processing instruction");
      i = end + 2;
    } else if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      if (end === -1) fail("unterminated comment");
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i);
      if (end === -1) fail("unterminated CDATA");
      const top = stack[stack.length - 1];
      if (top) top.el.text += src.slice(i + 9, end);
      i = end + 3;
    } else if (src.startsWith("<!", i)) {
      fail("DOCTYPE and other declarations are not accepted");
    } else if (src.startsWith("</", i)) {
      const m = nameAt(src, i + 2);
      if (!m) fail("bad closing tag");
      const name = m!;
      const top = stack.pop();
      if (!top || top.name !== name) fail(`mismatched </${name}>`);
      i += 2 + name.length;
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] !== ">") fail("bad closing tag");
      i++;
    } else if (src[i] === "<") {
      const m = nameAt(src, i + 1);
      if (!m) fail("bad tag");
      const name = m!;
      i += 1 + name.length;
      const raw = new Map<string, string>();
      for (;;) {
        while (/\s/.test(src[i] ?? "")) i++;
        if (src[i] === ">" || src.startsWith("/>", i)) break;
        const a = nameAt(src, i);
        if (!a) fail("bad attribute");
        i += a!.length;
        while (/\s/.test(src[i] ?? "")) i++;
        if (src[i] !== "=") fail("attribute without a value");
        i++;
        while (/\s/.test(src[i] ?? "")) i++;
        const q = src[i];
        if (q !== '"' && q !== "'") fail("unquoted attribute");
        const end = src.indexOf(q!, i + 1);
        if (end === -1) fail("unterminated attribute");
        raw.set(a!, decodeEntities(src.slice(i + 1, end)));
        if (raw.size > XML_LIMITS.attributes) fail("too many attributes");
        i = end + 1;
      }
      if (++elements > XML_LIMITS.elements) fail("too many elements");
      // An element's own declarations only. Copying the whole scope for every
      // element made a body of many declarations and many elements cost their
      // product; the stack is short (see the depth limit), so walking it is not.
      let decls: Map<string, string> | null = null;
      const attrs = new Map<string, string>();
      for (const [k, v] of raw) {
        if (k === "xmlns") (decls ??= new Map()).set("", v);
        else if (k.startsWith("xmlns:")) {
          // Namespaces in XML 1.0: a prefix cannot be bound to the empty name.
          if (v === "") fail(`empty namespace for prefix ${k.slice(6)}`);
          (decls ??= new Map()).set(k.slice(6), v);
        } else attrs.set(k, v);
      }
      const lookup = (prefix: string): string | undefined => {
        if (decls?.has(prefix)) return decls.get(prefix);
        for (let k = stack.length - 1; k >= 0; k--) {
          const d = stack[k]!.decls;
          if (d?.has(prefix)) return d.get(prefix);
        }
        return prefix === "xml" ? XML_NS : undefined;
      };
      const colon = name.indexOf(":");
      const prefix = colon === -1 ? "" : name.slice(0, colon);
      const local = colon === -1 ? name : name.slice(colon + 1);
      const ns = lookup(prefix);
      if (ns === undefined && prefix !== "") fail(`unbound prefix ${prefix}`);
      const el: XmlElement = { ns: ns ?? "", local, attrs, children: [], text: "" };
      const parent = stack[stack.length - 1];
      if (parent) parent.el.children.push(el);
      else if (root) fail("more than one root element");
      else root = el;
      if (src.startsWith("/>", i)) {
        i += 2;
      } else {
        i += 1;
        if (stack.length >= XML_LIMITS.depth) fail("elements nested too deeply");
        stack.push({ el, name, decls });
      }
    } else {
      const end = src.indexOf("<", i);
      const text = src.slice(i, end === -1 ? src.length : end);
      const top = stack[stack.length - 1];
      if (top) top.el.text += decodeEntities(text);
      else if (text.trim()) fail("text outside the root element");
      i = end === -1 ? src.length : end;
    }
  }
  if (stack.length > 0) fail("unclosed element");
  if (!root) fail("no root element");
  return root!;
}

export const DAV = "DAV:";

/** The first child with this name, or undefined. */
export function child(el: XmlElement, local: string, ns = DAV): XmlElement | undefined {
  return el.children.find((c) => c.local === local && c.ns === ns);
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * Write an element back out with its namespace declared on itself, so it can
 * be dropped into any document — how a lock's `owner` is echoed faithfully.
 */
export function serialize(el: XmlElement): string {
  const attrs = [...el.attrs].map(([k, v]) => ` ${k.includes(":") ? k.slice(k.indexOf(":") + 1) : k}="${escapeXml(v)}"`).join("");
  const inner = el.children.map(serialize).join("") + escapeXml(el.text.trim() === "" && el.children.length > 0 ? "" : el.text);
  return `<${el.local} xmlns="${escapeXml(el.ns)}"${attrs}>${inner}</${el.local}>`;
}
