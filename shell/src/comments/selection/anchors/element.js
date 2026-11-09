// Describing an element so it can be found again, on the doc page and in an
// app (the feedback widget). Framework-free; the doc frame bundles it.
import { containerFor, matchContainer, SLIDE_SELECTOR } from './container.js';

function cssEscapeValue(value) {
  return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

export function shownText(el) {
  return String(el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

// A selector: the element's id, else a short path of tags with their stable
// classes and, where a parent has several of a tag, its position. Positional
// paths are only one clue: findElement checks the text too.
export function selectorFor(element, options) {
  var stopAt = (options && options.stopAt) || 'main,nav,header,footer,[role="main"]';
  if (!element || element.nodeType !== 1) return '';
  if (element.id) return '#' + cssEscapeValue(element.id);
  var parts = [];
  for (var current = element; current && current.nodeType === 1 && parts.length < 7 && current.localName !== 'body' && current.localName !== 'html'; current = current.parentElement) {
    var part = current.localName;
    var stable = Array.prototype.filter.call(current.classList || [], function (name) {
      return !/^(active|hover|focus|selected|open|css-|sc-|tdoc-)/.test(name);
    }).slice(0, 2);
    if (stable.length) part += stable.map(function (name) { return '.' + cssEscapeValue(name); }).join('');
    var parent = current.parentElement;
    if (parent) {
      var peers = Array.prototype.filter.call(parent.children, function (peer) { return peer.localName === current.localName; });
      if (peers.length > 1) part += ':nth-of-type(' + (peers.indexOf(current) + 1) + ')';
    }
    parts.unshift(part);
    if (current.matches && current.matches(stopAt)) break;
  }
  return parts.join(' > ');
}

export function accessibleName(el) {
  return (el && (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('data-tdoc-artifact'))) || '';
}

// What an anchor on an element carries: where it was (selector), what it
// showed (tag, text, name), and the container it sat in (a slide), which
// survives the deck being reordered where a positional path does not.
export function describeElement(el) {
  var out = {
    selector: selectorFor(el),
    tag: el.localName,
    text: shownText(el),
    accessible_name: accessibleName(el),
  };
  var container = containerFor(el);
  if (container) {
    out.container = container;
    // A comment on the slide itself: found by the slide's id alone.
    if (el.matches && el.matches(SLIDE_SELECTOR)) out.container_is_target = true;
  }
  return out;
}

// Finding an element again: { element, approximate }. In order of trust:
//   0. its container (a slide), when the element IS that container;
//   1. the selector's element, still showing the text it showed then;
//   2. the one element of that tag showing that text (it moved), inside the
//      container when there is one; several such elements are a guess;
//   3. the selector's element, if it is still the same kind of element (the
//      text changed in place; the spot did not).
// A guess is `approximate`: the doc page draws its card dashed with
// Re-anchor. Anchors from before all this (the doc's {selector, label}, the
// widget's {selector, tag, text}) resolve through the same steps.
export function resolveElement(anchor, options) {
  var none = { element: null, approximate: false };
  if (!anchor) return none;
  var root = (options && options.root) || document;
  var exclude = (options && options.exclude) || function () { return false; };
  var want = shownText({ textContent: anchor.region ? anchor.region.container_text : anchor.text });
  var hit = anchor.container ? matchContainer(anchor.container, root) : none;
  var scope = hit.element;
  if (scope && anchor.container_is_target) return { element: scope, approximate: hit.approximate };
  var bySelector = null;
  try { bySelector = anchor.selector ? root.querySelector(anchor.selector) : null; } catch (e) { bySelector = null; }
  if (bySelector && exclude(bySelector)) bySelector = null;
  if (bySelector && scope && !scope.contains(bySelector)) bySelector = null;
  if (bySelector && (!want || shownText(bySelector) === want)) return { element: bySelector, approximate: hit.approximate };
  if (want) {
    var candidates = [];
    try { candidates = (scope || root).querySelectorAll(anchor.tag || '*'); } catch (e) { candidates = []; }
    var matches = [];
    for (var i = 0; i < candidates.length; i++) {
      if (exclude(candidates[i]) || shownText(candidates[i]) !== want) continue;
      matches.push(candidates[i]);
    }
    // A wrapper showing exactly its child's words is the same match: keep
    // the deepest of each nest.
    var leaves = matches.filter(function (el) { return !matches.some(function (other) { return other !== el && el.contains(other); }); });
    if (leaves.length === 1) return { element: leaves[0], approximate: hit.approximate };
    if (leaves.length > 1) {
      var same = bySelector && (!anchor.tag || bySelector.localName === anchor.tag) ? bySelector : null;
      return { element: same || leaves[0], approximate: true };
    }
  }
  if (bySelector && (!anchor.tag || bySelector.localName === anchor.tag)) return { element: bySelector, approximate: hit.approximate };
  return scope ? { element: scope, approximate: true } : none;
}

export function findElement(anchor, options) {
  return resolveElement(anchor, options).element;
}
