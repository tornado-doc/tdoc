// Markdown input rules for the in-place contenteditable editor.
//
// Concatenated into the same script tag as frame-probe.js (local server and
// the worker bundle). Nothing here parses the document into a schema: a rule
// fires on the keystroke that completes it and rewrites only the block or
// mark being typed. Artifacts stay untouched because they are not editable.
//
// Undo is one execCommand('insertHTML') so a misfire costs one ⌘Z.
(function (root) {
  var BLOCK = 'p,div,h1,h2,h3,h4,h5,h6,li,blockquote';

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function matchBlock(textBefore, incoming) {
    if (incoming === ' ') {
      if (/^#{1,3}$/.test(textBefore)) return { kind: 'heading', level: textBefore.length };
      if (textBefore === '-' || textBefore === '*') return { kind: 'ul' };
      if (/^\d+\.$/.test(textBefore)) return { kind: 'ol' };
      if (textBefore === '>') return { kind: 'quote' };
    }
    if (incoming === '-' && textBefore === '--') return { kind: 'hr' };
    if (incoming === '\n' && textBefore === '---') return { kind: 'hr' };
    return null;
  }

  function matchInline(text) {
    var rules = [
      { delim: '**', tag: 'strong' },
      { delim: '`', tag: 'code' },
      { delim: '*', tag: 'em' },
    ];
    for (var i = 0; i < rules.length; i++) {
      var delim = rules[i].delim;
      if (text.length < delim.length * 2 + 1) continue;
      if (text.slice(-delim.length) !== delim) continue;
      var innerEnd = text.length - delim.length;
      var from = text.lastIndexOf(delim, innerEnd - 1);
      if (from < 0) continue;
      if (delim === '*' && (text.slice(from, from + 2) === '**' || text.slice(-2) === '**')) continue;
      var inner = text.slice(from + delim.length, innerEnd);
      if (!inner || !inner.trim() || /\n/.test(inner)) continue;
      if (delim === '*' && inner.indexOf('*') !== -1) continue;
      if (delim === '`' && inner.indexOf('`') !== -1) continue;
      return { tag: rules[i].tag, inner: inner, from: from };
    }
    return null;
  }

  function closestBlock(node, root) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentNode);
    while (el && el !== root) {
      if (el.matches && el.matches(BLOCK)) return el;
      el = el.parentNode;
    }
    return null;
  }

  function isAtomic(node, atomicSelector) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentNode);
    return !!(el && el.closest && el.closest(atomicSelector));
  }

  function rangeToBlockStart(block, range) {
    var pre = document.createRange();
    pre.selectNodeContents(block);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().replace(/\u200B/g, '');
  }

  function rangeToBlockEnd(block, range) {
    var post = document.createRange();
    post.selectNodeContents(block);
    post.setStart(range.startContainer, range.startOffset);
    return post.toString().replace(/\u200B/g, '');
  }

  // The prefix is matched as text, but the content after it is still the
  // author's HTML. Clone the live range so converting "## " in front of a
  // link or styled span does not flatten that content into plain text.
  function rangeToBlockEndHtml(block, range) {
    var post = document.createRange();
    post.selectNodeContents(block);
    post.setStart(range.startContainer, range.startOffset);
    var container = document.createElement('div');
    container.appendChild(post.cloneContents());
    return container.innerHTML;
  }

  function replaceNodeWithHtml(node, html) {
    var range = document.createRange();
    range.selectNode(node);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertHTML', false, html);
  }

  function blockHtml(rule, restHtml) {
    // restHtml comes only from rangeToBlockEndHtml: it is serialized from the
    // current author DOM, not interpolated user text.
    var inner = restHtml || '<br>';
    if (rule.kind === 'heading') return '<h' + rule.level + '>' + inner + '</h' + rule.level + '>';
    if (rule.kind === 'ul') return '<ul><li>' + inner + '</li></ul>';
    if (rule.kind === 'ol') return '<ol><li>' + inner + '</li></ol>';
    if (rule.kind === 'quote') return '<blockquote><p>' + inner + '</p></blockquote>';
    if (rule.kind === 'hr') return restHtml ? '<hr><p>' + restHtml + '</p>' : '<hr><p><br></p>';
    return null;
  }

  function collapsedRange() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    return { sel: sel, range: sel.getRangeAt(0) };
  }

  function convertAtCaret(ctx, incoming, alreadyInserted) {
    var live = collapsedRange();
    if (!live) return false;
    var node = live.range.startContainer;
    if (isAtomic(node, ctx.atomicSelector)) return false;

    if (!alreadyInserted && incoming.length === 1 && (incoming === '*' || incoming === '`')) {
      if (node.nodeType === 3 && node.parentNode && !node.parentNode.closest('code,pre,kbd,samp')) {
        var data = node.data.slice(0, live.range.startOffset);
        var inline = matchInline(alreadyInserted ? data : data + incoming);
        if (inline) {
          var wrap = document.createRange();
          wrap.setStart(node, inline.from);
          wrap.setEnd(node, live.range.startOffset);
          live.sel.removeAllRanges();
          live.sel.addRange(wrap);
          document.execCommand(
            'insertHTML',
            false,
            '<' + inline.tag + '>' + escapeHtml(inline.inner) + '</' + inline.tag + '>'
          );
          return true;
        }
      }
    }

    if (alreadyInserted && incoming.length === 1 && (incoming === '*' || incoming === '`') && node.nodeType === 3) {
      if (node.parentNode && !node.parentNode.closest('code,pre,kbd,samp')) {
        var typed = node.data.slice(0, live.range.startOffset);
        var closed = matchInline(typed);
        if (closed) {
          var mark = document.createRange();
          mark.setStart(node, closed.from);
          mark.setEnd(node, live.range.startOffset);
          live.sel.removeAllRanges();
          live.sel.addRange(mark);
          document.execCommand(
            'insertHTML',
            false,
            '<' + closed.tag + '>' + escapeHtml(closed.inner) + '</' + closed.tag + '>'
          );
          return true;
        }
      }
    }

    var block = closestBlock(node, ctx.root);
    if (!block) return false;
    var before = rangeToBlockStart(block, live.range);
    var afterHtml = rangeToBlockEndHtml(block, live.range);
    var prefix = before;
    if (alreadyInserted) {
      if (incoming === '\n') {
        if (before.slice(-1) === '\n') prefix = before.slice(0, -1);
      } else if (incoming && before.slice(-incoming.length) === incoming) {
        prefix = before.slice(0, -incoming.length);
      }
    }
    var rule = matchBlock(prefix, incoming);
    if (!rule) return false;
    var html = blockHtml(rule, afterHtml);
    if (!html) return false;
    replaceNodeWithHtml(block, html);
    return true;
  }

  function applyBeforeInput(event, ctx) {
    if (!ctx || !ctx.root || event.type !== 'beforeinput') return false;
    if (event.isComposing) return false;
    if (event.inputType !== 'insertText' && event.inputType !== 'insertParagraph') return false;
    var incoming = event.inputType === 'insertParagraph' ? '\n' : String(event.data || '');
    if (!incoming) return false;
    if (!convertAtCaret(ctx, incoming, false)) return false;
    event.preventDefault();
    return true;
  }

  function applyAfterInput(event, ctx) {
    if (!ctx || !ctx.root || !event || event.type !== 'input') return false;
    if (event.isComposing) return false;
    if (event.inputType !== 'insertText' && event.inputType !== 'insertParagraph') return false;
    var incoming = event.inputType === 'insertParagraph' ? '\n' : String(event.data || '');
    if (!incoming) return false;
    return convertAtCaret(ctx, incoming, true);
  }

  function liIsEmpty(li) {
    return !String(li.textContent || '').replace(/\u200B/g, '').trim();
  }

  function applyKeydown(event, ctx) {
    if (!ctx || !ctx.root) return false;
    if (event.isComposing || event.altKey || event.metaKey || event.ctrlKey) return false;
    var live = collapsedRange();
    if (!live) return false;
    var node = live.range.startContainer;
    if (isAtomic(node, ctx.atomicSelector)) return false;
    var block = closestBlock(node, ctx.root);
    if (!block) return false;

    if (event.key === 'Tab') {
      var inLi = block.closest('li');
      if (!inLi || !ctx.root.contains(inLi)) return false;
      event.preventDefault();
      document.execCommand(event.shiftKey ? 'outdent' : 'indent', false, null);
      return true;
    }

    if (event.key !== 'Enter' || event.shiftKey) return false;

    if (block.matches('li') && liIsEmpty(block)) {
      event.preventDefault();
      document.execCommand('outdent', false, null);
      return true;
    }

    var before = rangeToBlockStart(block, live.range);
    var afterHtml = rangeToBlockEndHtml(block, live.range);
    if (matchBlock(before, '\n')) {
      var html = blockHtml({ kind: 'hr' }, afterHtml);
      event.preventDefault();
      replaceNodeWithHtml(block, html);
      return true;
    }
    return false;
  }

  var api = {
    escapeHtml: escapeHtml,
    matchBlock: matchBlock,
    matchInline: matchInline,
    applyBeforeInput: applyBeforeInput,
    applyAfterInput: applyAfterInput,
    applyKeydown: applyKeydown,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.tdocEditMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
