/**
 * Brightspace MCP Server (NYU fork)
 * Copyright (c) 2026 Robin Chen.
 * Licensed under MIT — see LICENSE file for details.
 */

/**
 * A minimal XML tree for reading OOXML parts. Office documents are
 * machine-written and well formed, so this skips DTDs, namespaces and
 * validation: it only needs element names, attributes, children and text in
 * document order. Malformed input never throws; unbalanced tags are closed
 * where they stop matching.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITY[body.toLowerCase()] ?? match;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1]] = decodeXmlEntities(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

/** Parse XML into a synthetic root element whose children are the document's top-level nodes. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!(?:[^>])*>|<(\/?)([\w:.-]+)((?:\s+[^>]*?)?)(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(token)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.children.push(m[1]);
    } else if (m[6] !== undefined) {
      if (m[6].trim() !== "" || top.name.endsWith(":t") || top.name === "t") {
        top.children.push(decodeXmlEntities(m[6]));
      }
    } else if (m[3] !== undefined) {
      const [, , closing, name, rawAttrs, selfClosing] = m;
      if (closing) {
        const at = stack.map((e) => e.name).lastIndexOf(name);
        if (at > 0) stack.length = at;
      } else {
        const el: XmlElement = { name, attrs: parseAttrs(rawAttrs ?? ""), children: [] };
        top.children.push(el);
        if (!selfClosing) stack.push(el);
      }
    }
  }
  return root;
}

export function isElement(node: XmlNode): node is XmlElement {
  return typeof node !== "string";
}

/** Direct child elements, optionally only those with the given name. */
export function childElements(el: XmlElement, name?: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => isElement(c) && (name === undefined || c.name === name));
}

export function firstChild(el: XmlElement, name: string): XmlElement | undefined {
  return childElements(el, name)[0];
}

/** Every descendant element with the given name, in document order. */
export function descendants(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (node: XmlElement) => {
    for (const child of childElements(node)) {
      if (child.name === name) out.push(child);
      walk(child);
    }
  };
  walk(el);
  return out;
}

/** First descendant reached by following names in order, e.g. path(el, "p:nvSpPr", "p:nvPr", "p:ph"). */
export function path(el: XmlElement | undefined, ...names: string[]): XmlElement | undefined {
  let current = el;
  for (const name of names) {
    if (!current) return undefined;
    current = firstChild(current, name);
  }
  return current;
}

/** All text beneath an element, concatenated. */
export function textContent(el: XmlElement): string {
  return el.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
}
