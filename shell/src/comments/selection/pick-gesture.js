// Picking something on a page to comment on: one pointer state machine for
// the feedback widget and the doc frame. Framework-free; the doc frame
// bundles it. It only decides what a press was and calls back:
//   a click                         → onElement(startElement)
//   a drag that starts on text      → onText(start, end)   (a quote)
//   a drag anywhere else            → onBox(box)           (with areaSelect;
//                                      without it, onElement)
//   touch: a tap picks, a hold then drag draws a box, a swipe scrolls
//   Esc (cancel()) drops a press in progress.
// options:
//   areaSelect      boxes allowed (the feedbackAreaSelect rule)
//   textSelect      text drags make quotes (else they pick the element)
//   elementAt(x,y)  what is under a point, overlays excluded
//   startsOnText(x,y)
//   onHover(el|null), onDrag(box|null), onHold()
import { boxBetween } from './anchors/region.js';

export var PICK_THRESHOLD = 8;
export var PICK_HOLD_MS = 450;

export function commonAncestor(a, b) {
  if (!a || !b) return a || b;
  for (var el = a; el; el = el.parentElement) if (el.contains(b)) return el;
  return a;
}

export function createPickGesture(options) {
  var o = options || {};
  var press = null;
  function boxTo(x, y) { return boxBetween({ x: press.x, y: press.y }, { x: x, y: y }); }
  function clear() {
    if (press && press.timer) clearTimeout(press.timer);
    press = null;
    if (o.onDrag) o.onDrag(null);
  }
  return {
    pressing: function () { return Boolean(press); },
    touching: function () { return Boolean(press && press.touch); },
    mode: function () { return press ? press.mode : null; },
    down: function (e) {
      clear();
      var x = e.clientX, y = e.clientY;
      var touch = e.pointerType && e.pointerType !== 'mouse';
      var onText = Boolean((o.areaSelect || o.textSelect) && o.startsOnText && o.startsOnText(x, y));
      press = { id: e.pointerId, touch: touch, x: x, y: y, lastX: x, lastY: y, start: o.elementAt(x, y), mode: 'pending', onText: onText, timer: 0 };
      if (touch && o.areaSelect) {
        var p = press;
        p.timer = setTimeout(function () {
          if (press !== p || p.mode !== 'pending') return;
          p.mode = 'area';
          if (o.onHold) o.onHold();
          if (o.onHover) o.onHover(null);
          if (o.onDrag) o.onDrag(boxTo(p.lastX, p.lastY));
        }, o.holdMs || PICK_HOLD_MS);
      }
      return press;
    },
    move: function (e) {
      var x = e.clientX, y = e.clientY;
      if (!press) { if (!e.pointerType || e.pointerType === 'mouse') { if (o.onHover) o.onHover(o.elementAt(x, y)); } return; }
      if (e.pointerId !== press.id) return;
      press.lastX = x; press.lastY = y;
      var far = Math.hypot(x - press.x, y - press.y) >= (o.threshold || PICK_THRESHOLD);
      if (press.mode === 'pending' && far) {
        if (press.touch) { press.mode = 'scroll'; clearTimeout(press.timer); return; }
        press.mode = press.onText && o.textSelect ? 'text' : press.onText ? 'element' : (o.areaSelect ? 'area' : 'element');
      }
      if (press.mode === 'area') { if (o.onHover) o.onHover(null); if (o.onDrag) o.onDrag(boxTo(x, y)); }
      else if (press.mode === 'text' || press.mode === 'element') { if (o.onHover) o.onHover(commonAncestor(press.start, o.elementAt(x, y))); }
    },
    up: function (e) {
      var p = press;
      if (!p || e.pointerId !== p.id) return null;
      clear();
      var x = e.clientX, y = e.clientY;
      if (p.mode === 'scroll') return 'scroll';
      if (p.mode === 'area') {
        var box = boxBetween({ x: p.x, y: p.y }, { x: x, y: y });
        var t = o.threshold || PICK_THRESHOLD;
        if (box.width >= t || box.height >= t) { if (o.onBox) o.onBox(box); return 'area'; }
      }
      if (p.mode === 'text') { if (o.onText) o.onText({ x: p.x, y: p.y }, { x: x, y: y }); return 'text'; }
      if (p.mode === 'element' && p.onText) { if (o.onElement) o.onElement(commonAncestor(p.start, o.elementAt(x, y))); return 'element'; }
      if (o.onElement) o.onElement(p.start || o.elementAt(x, y));
      return 'click';
    },
    // Esc, a pointer leaving the window, a cancelled pointer.
    cancel: function (keepArea) {
      if (!press) return false;
      if (keepArea && press.mode === 'area') return false;
      clear();
      return true;
    },
  };
}

// A Range between two points, through the caret under each.
export function rangeBetweenPoints(start, end, doc) {
  var d = doc || document;
  function caret(p) {
    if (d.caretPositionFromPoint) { var c = d.caretPositionFromPoint(p.x, p.y); return c ? { node: c.offsetNode, offset: c.offset } : null; }
    if (d.caretRangeFromPoint) { var r = d.caretRangeFromPoint(p.x, p.y); return r ? { node: r.startContainer, offset: r.startOffset } : null; }
    return null;
  }
  var a = caret(start), b = caret(end);
  if (!a || !b) return null;
  var range = d.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    if (range.collapsed) { range.setStart(b.node, b.offset); range.setEnd(a.node, a.offset); }
  } catch (e) { return null; }
  return range.collapsed ? null : range;
}
