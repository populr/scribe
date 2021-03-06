define([
  'event-emitter',
  'lodash-modern/objects/defaults',
  './plugins/core/commands',
  './plugins/core/events',
  './plugins/core/formatters/html/replace-nbsp-chars',
  './plugins/core/formatters/plain-text/escape-html-characters',
  './plugins/core/inline-elements-mode',
  './plugins/core/patches',
  './plugins/core/set-root-p-element',
  './api',
  './transaction-manager',
  './undo-manager'
], function (
  EventEmitter,
  defaults,
  commands,
  events,
  replaceNbspCharsFormatter,
  escapeHtmlCharactersFormatter,
  inlineElementsMode,
  patches,
  setRootPElement,
  Api,
  buildTransactionManager,
  buildUndoManager
) {

  'use strict';

  function Scribe(el, options) {
    this.el = el;
    this.commands = {};
    this.options = defaults(options || {}, {
      allowBlockElements: true,
      debug: false
    });
    this.targetWindow = options.targetWindow || window;
    this.commandPatches = {};
    this.plainTextFormatter = new Formatter();
    this.htmlFormatter = new Formatter();

    this.api = new Api(this);

    var TransactionManager = buildTransactionManager(this);
    this.transactionManager = new TransactionManager();

    var UndoManager = buildUndoManager(this);
    this.undoManager = new UndoManager();

    this.el.setAttribute('contenteditable', true);

    var handleInput = function () {
      /**
       * This event triggers when either the user types something or a native
       * command is executed which causes the content to change (i.e.
       * `document.execCommand('bold')`). We can't wrap a transaction around
       * these actions, so instead we run the transaction in this event.
       */
      this.transactionManager.run();
    }.bind(this);

    this.el.addEventListener('input', handleInput, false);
    this.on('deactivated', function() {
      this.el.removeEventListener('keypress', handleInput);
    }.bind(this));

    /**
     * Core Plugins
     */

    if (this.allowsBlockElements()) {
      // Commands assume block elements are allowed, so all we have to do is
      // set the content.
      this.use(setRootPElement());
    } else {
      // Commands assume block elements are allowed, so we have to set the
      // content and override some UX.
      this.use(inlineElementsMode());
    }

    // Formatters
    this.use(escapeHtmlCharactersFormatter());
    this.use(replaceNbspCharsFormatter());

    // Patches
    this.use(patches.commands.bold());
    this.use(patches.commands.indent());
    this.use(patches.commands.insertHTML());
    this.use(patches.commands.insertList());
    this.use(patches.commands.outdent());
    if (this.allowsBlockElements()) {
      this.use(patches.emptyWhenDeleting());
    }
    this.use(patches.events());

    this.use(commands.indent());
    this.use(commands.insertHTML());
    this.use(commands.insertList());
    this.use(commands.outdent());
    this.use(commands.redo());
    this.use(commands.subscript());
    this.use(commands.superscript());
    this.use(commands.undo());

    this.use(events());

    var pushHistoryOnFocus = function () {
      // Tabbing into the editor doesn't create a range immediately, so we have to
      // wait until the next event loop.
      setTimeout(function () {
        this.pushHistory();
      }.bind(this), 0);

      this.el.removeEventListener('focus', pushHistoryOnFocus);
    }.bind(this);

    // TODO: abstract
    var placeCaretOnFocus = function() {
      /**
       * Firefox: Giving focus to a `contenteditable` will place the caret
       * outside of any block elements. Chrome behaves correctly by placing the
       * caret at the  earliest point possible inside the first block element.
       * As per: http://jsbin.com/eLoFOku/1/edit?js,console,output
       *
       * We detect when this occurs and fix it by placing the caret ourselves.
       */
      var selection = new this.api.Selection();

      var getFirstDeepestChild = function(node) {
        var treeWalker = this.targetWindow.document.createTreeWalker(node, NodeFilter.SHOW_ALL, null, false);
        var previousNode = treeWalker.currentNode;
        if (treeWalker.firstChild()) {
          // TODO: build list of non-empty elements (used elsewhere)
          // Do not include non-empty elements
          if (treeWalker.currentNode.nodeName === 'BR') {
            return previousNode;
          } else {
            return getFirstDeepestChild(treeWalker.currentNode);
          }
        } else {
          return treeWalker.currentNode;
        }
      }.bind(this);

      // In Chrome, the range is not created on or before this event loop.
      // It doesn’t matter because this is a fix for Firefox.
      if (selection.range) {
        selection.placeMarkers();
        var isFirefoxBug = this.allowsBlockElements() && this.getHTML().match(/^<em class="scribe-marker"><\/em>/);
        selection.removeMarkers();

        if (isFirefoxBug) {
          var focusElement = getFirstDeepestChild(this.el.firstChild);

          var range = selection.range;

          range.setStart(focusElement, 0);
          range.setEnd(focusElement, 0);

          selection.selection.removeAllRanges();
          selection.selection.addRange(range);
        }
      }

    }.bind(this);

    this.el.addEventListener('focus', placeCaretOnFocus);
    this.on('deactivated', function() {
      this.el.removeEventListener('focus', placeCaretOnFocus);
    }.bind(this));

    this.el.addEventListener('focus', pushHistoryOnFocus);
    this.on('deactivated', function() {
      this.el.removeEventListener('focus', pushHistoryOnFocus);
    }.bind(this));
  }

  Scribe.prototype = Object.create(EventEmitter.prototype);

  // For plugins
  // TODO: tap combinator?
  Scribe.prototype.use = function (configurePlugin) {
    configurePlugin(this);
    return this;
  };

  Scribe.prototype.setHTML = function (html) {
    this.el.innerHTML = html;
  };

  Scribe.prototype.getHTML = function () {
    return this.el.innerHTML;
  };

  Scribe.prototype.getContent = function () {
    // Remove bogus BR element for Firefox — see explanation in BR mode files.
    return this.getHTML().replace(/<br>$/, '');
  };

  Scribe.prototype.getTextContent = function () {
    return this.el.textContent;
  };

  Scribe.prototype.pushHistory = function () {
    var previousUndoItem = this.undoManager.stack[this.undoManager.position];
    var previousContent = previousUndoItem && previousUndoItem
      .replace(/<em class="scribe-marker">/g, '').replace(/<\/em>/g, '');

    /**
     * Chrome and Firefox: If we did push to the history, this would break
     * browser magic around `Document.queryCommandState` (http://jsbin.com/eDOxacI/1/edit?js,console,output).
     * This happens when doing any DOM manipulation.
     */

    // We only want to push the history if the content actually changed.
    if (! previousUndoItem || (previousUndoItem && this.getContent() !== previousContent)) {
      var selection = new this.api.Selection();

      if (selection.rangeCount)
        selection.placeMarkers();
      var html = this.getHTML();
      if (selection.rangeCount)
        selection.removeMarkers();

      this.undoManager.push(html);

      return true;
    } else {
      return false;
    }
  };

  Scribe.prototype.getCommand = function (commandName) {
    return this.commands[commandName] || this.commandPatches[commandName] || new this.api.Command(commandName);
  };

  Scribe.prototype.restoreFromHistory = function (historyItem) {
    this.setHTML(historyItem);

    // Restore the selection
    var selection = new this.api.Selection();
    selection.selectMarkers();

    this.trigger('content-changed');
  };

  // This will most likely be moved to another object eventually
  Scribe.prototype.allowsBlockElements = function () {
    return this.options.allowBlockElements;
  };

  Scribe.prototype.setContent = function (content) {
    if (! this.allowsBlockElements()) {
      // Set bogus BR element for Firefox — see explanation in BR mode files.
      content = content + '<br>';
    }

    this.setHTML(this.htmlFormatter.format(content));

    this.trigger('content-changed');
  };

  Scribe.prototype.insertPlainText = function (plainText) {
    this.insertHTML('<p>' + this.plainTextFormatter.format(plainText) + '</p>');
  };

  Scribe.prototype.insertHTML = function (html) {
    // TODO: error if the selection is not within the Scribe instance? Or
    // focus the Scribe instance if it is not already focused?

    var selection = new this.api.Selection();
    var range = selection.range;
    var div = this.targetWindow.document.createElement('DIV');
    range.deleteContents();
    range.insertNode(div);
    html = this.htmlFormatter.format(html);
    div.appendChild(range.createContextualFragment(html));
    new this.api.Element(div.parentNode).unwrap(div);
  };

  Scribe.prototype.isDebugModeEnabled = function () {
    return this.options.debug;
  };

  // TODO: abstract
  function Formatter() {
    this.formatters = [];
  }

  Formatter.prototype.format = function (html) {
    var formattedHTML = this.formatters.reduce(function (formattedData, formatter) {
      return formatter(formattedData);
    }, html);

    return formattedHTML;
  };

  return Scribe;

});
