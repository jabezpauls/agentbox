/**
 * The annotator: the only code agentbox adds to an agent's artifact.
 *
 * It runs inside a frame whose origin is opaque (the artifact route sends
 * `Content-Security-Policy: sandbox allow-scripts`, and the panel's iframe
 * carries `sandbox="allow-scripts"` as well), so it has no cookies, no storage
 * and no same-origin access to anything. Its whole outward surface is one
 * `postMessage` to the parent, and the only thing it accepts back is a mode
 * switch and a scroll request.
 *
 * It is a string rather than a module because it is injected into someone
 * else's document, which has no bundler and must not gain a network request.
 */
const SCRIPT = `
(function () {
  var OUT = "agentbox-review";
  var armed = false;
  var hovered = null;

  var style = document.createElement("style");
  style.textContent =
    "[data-agentbox-hover]{outline:2px solid #4c63e6 !important;outline-offset:1px !important;cursor:crosshair !important}" +
    "[data-agentbox-flash]{outline:2px solid #4c63e6 !important;outline-offset:1px !important}";
  document.documentElement.appendChild(style);

  function send(msg) {
    msg.source = OUT;
    try { parent.postMessage(msg, "*"); } catch (e) { /* no parent */ }
  }

  // A CSS path that survives a re-render of the same document: ids where they
  // exist, nth-of-type otherwise, stopping at <body>.
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return "";
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && parts.length < 8) {
      var tag = el.tagName.toLowerCase();
      if (el.id && /^[A-Za-z][-\\w]*$/.test(el.id)) {
        parts.unshift("#" + el.id);
        return parts.join(" > ");
      }
      var i = 1;
      var sib = el;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === el.tagName) i++;
      }
      parts.unshift(tag + ":nth-of-type(" + i + ")");
      el = el.parentElement;
    }
    return parts.length ? "body > " + parts.join(" > ") : "body";
  }

  function trimText(s) {
    return String(s || "").replace(/\\s+/g, " ").trim().slice(0, 300);
  }

  function unhover() {
    if (hovered) hovered.removeAttribute("data-agentbox-hover");
    hovered = null;
  }

  document.addEventListener("mouseover", function (e) {
    if (!armed) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === document.body) return;
    unhover();
    hovered = el;
    el.setAttribute("data-agentbox-hover", "");
  }, true);

  document.addEventListener("mouseout", function () {
    if (armed) unhover();
  }, true);

  document.addEventListener("click", function (e) {
    if (!armed) return;
    // While armed the page is a target, not an application: a link or a button
    // must not navigate the frame out from under the person choosing it.
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    var r = el.getBoundingClientRect();
    send({
      kind: "element",
      selector: selectorFor(el),
      text: trimText(el.textContent),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height }
    });
  }, true);

  // A selection is an anchor too, and it is the finer one: the person marks the
  // exact phrase they mean rather than the block containing it.
  function onSelect() {
    var sel = document.getSelection();
    if (!sel || sel.isCollapsed) return;
    var text = trimText(sel.toString());
    if (!text) return;
    var node = sel.anchorNode;
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    send({ kind: "selection", selector: selectorFor(el), text: text });
  }
  document.addEventListener("mouseup", function () { setTimeout(onSelect, 0); });

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.mode === "on" || d.mode === "off") {
      armed = d.mode === "on";
      if (!armed) unhover();
      document.documentElement.style.userSelect = "";
    }
    if (typeof d.scrollTo === "string" && d.scrollTo) {
      var target = null;
      try { target = document.querySelector(d.scrollTo); } catch (err) { target = null; }
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.setAttribute("data-agentbox-flash", "");
      setTimeout(function () { target.removeAttribute("data-agentbox-flash"); }, 1200);
    }
  });

  send({ kind: "ready" });
})();
`;

/** The annotator wrapped in a script tag, ready to inject. */
export const ANNOTATOR_TAG = `<script data-agentbox-review="annotator">${SCRIPT}</script>`;

/**
 * Put the annotator into an artifact, before `</body>` when there is one so it
 * runs after the page's own markup has parsed. Agent-written HTML is often a
 * fragment with no body tag at all, which is why the fallback appends.
 */
export function injectAnnotator(html: string): string {
  const i = html.toLowerCase().lastIndexOf("</body>");
  if (i === -1) return html + ANNOTATOR_TAG;
  return html.slice(0, i) + ANNOTATOR_TAG + html.slice(i);
}
