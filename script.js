/**
 * script.js
 *
 * Responsibilities:
 * - Mobile navigation toggle (accessible)
 * - Smooth-scrolling for in-page anchor links
 * - Client-side contact form validation + draft persistence (localStorage)
 *
 * Public API:
 * - SiteApp.init(options)
 * - SiteApp.teardown()
 *
 * Initializes itself once on DOMContentLoaded if not already initialized.
 *
 * This file is self-contained, portable, and framework-free.
 *
 * Usage:
 *   // Auto-init happens by default. To prevent auto-init (for tests or manual control):
 *   window.__SITEAPP_NO_AUTO_INIT = true;
 *   // To enable the lightweight test harness:
 *   window.__SITEAPP_ENABLE_TESTS = true;
 *   // Initialize manually:
 *   SiteApp.init({ logger: { level: 'debug' } });
 */

/**
 * SiteApp
 *
 * Example:
 *   SiteApp.init({ logger: { level: 'debug' } });
 *
 * API:
 *   init(options) - options: partial DEFAULTS replacement (see DEFAULTS below)
 *   teardown() - remove listeners and runtime artifacts added by SiteApp
 *
 * Note: This module is UMD-friendly as a global. Prefer ESM import in modern apps.
 */

/* global window, document, console, location, history */

(function (global) {
  'use strict';

  /**
   * Track elements that had tabindex added by focusAndReveal so teardown can undo it.
   * Use a WeakMap to record previous tabindex values and a Set to allow iteration during teardown.
   */
  const _revealedPrevTabIndex = new WeakMap(); // element -> previousTabIndex (string|null)
  const _revealedSet = new Set(); // elements currently managed

  /**
   * Default configuration and feature flags.
   * @type {Object}
   */
  const DEFAULTS = {
    enableMobileNav: true,
    mobileNavToggleSelector: '.nav-toggle',
    // resilient selector to match multiple markup choices
    mobileNavContainerSelector: '.nav, .main-nav, [data-nav], nav',
    mobileNavOpenClass: 'nav-open',
    enableSmoothScroll: true,
    smoothScrollSelector: 'a[href^="#"]',
    smoothScrollOffset: 16, // px from top for focus visibility (fallback)
    enableContactForm: true,
    contactFormSelector: '#contact-form',
    contactDraftKey: 'aiagency_contact_draft_v1',
    formDebounceMs: 500,
    logger: { level: 'info' }, // debug|info|warn|error|silent
    messages: {
      nameRequired: 'Please enter your name.',
      emailRequired: 'Please enter your email.',
      emailInvalid: 'Please enter a valid email address.',
      messageRequired: 'Please enter a message.',
      successMessage: 'Thanks! Your message has been received (demo).'
    }
  };

  /**
   * Simple logger with levels.
   */
  const Logger = (function () {
    const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
    let currentLevel = levels[DEFAULTS.logger.level] || levels.info;

    function setLevel(name) {
      if (levels[name] !== undefined) currentLevel = levels[name];
    }
    function _log(levelName, ...args) {
      if (levels[levelName] >= currentLevel) {
        const fn = console[levelName] || console.log;
        try {
          fn.call(console, `[SiteApp:${levelName}]`, ...args);
        } catch (e) {
          console.log(`[SiteApp:${levelName}]`, ...args);
        }
      }
    }
    return {
      setLevel,
      debug: (...a) => _log('debug', ...a),
      info: (...a) => _log('info', ...a),
      warn: (...a) => _log('warn', ...a),
      error: (...a) => _log('error', ...a),
    };
  })();

  /**
   * Utility: simple debounce
   * @param {Function} fn
   * @param {number} wait
   */
  function debounce(fn, wait) {
    let t = null;
    return function debounced(...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  /**
   * Utility: safe text setter
   */
  function setText(el, text) {
    if (!el) return;
    el.textContent = text;
  }

  /**
   * Utility: determine scroll offset preferring CSS variable --scroll-offset if present.
   * Returns a number of pixels.
   */
  function resolveScrollOffset(fallback) {
    try {
      const val = getComputedStyle(document.documentElement).getPropertyValue('--scroll-offset') || '';
      const n = parseInt(val, 10);
      if (!Number.isNaN(n)) return n;
    } catch (e) {
      // ignore
    }
    return (typeof fallback === 'number' ? fallback : DEFAULTS.smoothScrollOffset);
  }

  /**
   * Utility: focus an element and ensure it's visible after scroll
   * Restores prior tabindex (if any) when done or during teardown.
   * @param {HTMLElement} el
   * @param {number} [offsetPx] optional offset in px to leave between top of viewport and element
   */
  function focusAndReveal(el, offsetPx) {
    if (!el || typeof el.focus !== 'function') return;
    try {
      const prev = el.getAttribute && el.getAttribute('tabindex');
      _revealedPrevTabIndex.set(el, prev === null ? null : prev);
      _revealedSet.add(el);
      // set tabindex only if it's not already '-1' (we still record the previous)
      if (prev !== '-1') {
        el.setAttribute('tabindex', '-1');
      }
      // focus without scrolling, then perform a smooth scroll that accounts for offset
      try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (__) { /* ignore */ } }

      const offset = resolveScrollOffset(offsetPx);
      const top = Math.max(0, el.getBoundingClientRect().top + window.pageYOffset - offset);
      try {
        window.scrollTo({ top, behavior: 'smooth' });
      } catch (e) {
        window.scrollTo(0, top);
      }

      // schedule restore of tabindex after scroll time; if the element had an original tabindex,
      // restore that value, otherwise remove the attribute we added.
      const restore = () => {
        try {
          const recorded = _revealedPrevTabIndex.get(el);
          if (recorded === null || recorded === undefined) {
            // remove only if we added it and it's still '-1'
            if (el.getAttribute && el.getAttribute('tabindex') === '-1') {
              el.removeAttribute('tabindex');
            }
          } else {
            // restore original value
            el.setAttribute('tabindex', recorded);
          }
        } catch (_) { /* ignore */ }
        _revealedPrevTabIndex.delete(el);
        _revealedSet.delete(el);
      };

      // Use a reasonable timeout: allow for slow devices but avoid permanence. Keep to 1s as before.
      setTimeout(restore, 1000);
    } catch (e) {
      // defensive: if anything fails, ensure we don't leave a record in maps
      try { _revealedPrevTabIndex.delete(el); } catch (_) {}
      try { _revealedSet.delete(el); } catch (_) {}
    }
  }

  /**
   * Simple email format check
   * @param {string} value
   */
  function isValidEmail(value) {
    if (!value || typeof value !== 'string') return false;
    // basic RFC5322-ish regex, tolerant
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(value.trim());
  }

  /**
   * SiteApp module
   */
  const SiteApp = (function () {
    let opts = Object.assign({}, DEFAULTS);
    let state = {
      initialized: false,
      handlers: [],
      formDraft: null,
    };

    /**
     * Runtime input validation for init options
     * @param {Object} supplied
     */
    function validateOptions(supplied) {
      if (!supplied) return;
      if (typeof supplied !== 'object') {
        throw new TypeError('SiteApp.init expects an options object');
      }
      if (supplied.logger && supplied.logger.level && typeof supplied.logger.level !== 'string') {
        throw new TypeError('logger.level must be a string');
      }
    }

    /**
     * Attach event listeners and save cleanup handles.
     * Each handler is stored as {target, type, listener, opts}
     */
    function addListener(target, type, listener, opts) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, listener, opts);
      state.handlers.push({ target, type, listener, opts });
    }

    /**
     * Remove all registered listeners.
     */
    function removeAllListeners() {
      state.handlers.forEach(h => {
        try {
          h.target.removeEventListener(h.type, h.listener, h.opts);
        } catch (e) {
          // ignore removal errors
        }
      });
      state.handlers = [];
    }

    /**
     * Mobile navigation behavior
     */
    function setupMobileNav() {
      if (!opts.enableMobileNav) return;
      const toggle = document.querySelector(opts.mobileNavToggleSelector);
      const nav = document.querySelector(opts.mobileNavContainerSelector);
      const body = document.body;

      if (!toggle || !nav) {
        Logger.debug('Mobile nav: missing toggle or nav container', toggle, nav);
        return;
      }

      // Ensure accessibility attributes
      const navId = nav.id || `main-nav-${Math.random().toString(36).slice(2, 8)}`;
      if (!nav.id) nav.id = navId;
      toggle.setAttribute('aria-controls', nav.id);
      if (!toggle.hasAttribute('aria-expanded')) toggle.setAttribute('aria-expanded', 'false');
      if (!nav.hasAttribute('aria-expanded')) nav.setAttribute('aria-expanded', 'false');

      function openNav() {
        body.classList.add(opts.mobileNavOpenClass);
        toggle.setAttribute('aria-expanded', 'true');
        nav.setAttribute('aria-expanded', 'true');
        nav.classList.add('is-open');
        // set focus to first link inside nav for accessibility
        const firstLink = nav.querySelector('a, button, [tabindex]:not([tabindex="-1"])');
        if (firstLink) {
          try { firstLink.focus(); } catch (_) { /* ignore */ }
        }
        Logger.info('Mobile nav opened');
      }

      function closeNav() {
        body.classList.remove(opts.mobileNavOpenClass);
        toggle.setAttribute('aria-expanded', 'false');
        nav.setAttribute('aria-expanded', 'false');
        nav.classList.remove('is-open');
        try { toggle.focus({ preventScroll: true }); } catch (_) { try { toggle.focus(); } catch (__) { /* ignore */ } }
        Logger.info('Mobile nav closed');
      }

      function toggleNav() {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        if (expanded) closeNav();
        else openNav();
      }

      function onDocumentKey(e) {
        if (e.key === 'Escape') {
          if (document.body.classList.contains(opts.mobileNavOpenClass)) closeNav();
        }
      }

      function onDocumentClick(e) {
        // close nav when clicking outside the nav + toggle
        if (!document.body.classList.contains(opts.mobileNavOpenClass)) return;
        const path = e.composedPath ? e.composedPath() : (e.path || []);
        if (path && path.length) {
          if (path.includes(nav) || path.includes(toggle)) return;
        } else {
          if (nav.contains(e.target) || toggle.contains(e.target)) return;
        }
        closeNav();
      }

      addListener(toggle, 'click', function (ev) {
        ev.preventDefault();
        toggleNav();
      });

      // also support quick touchstart for snappy mobile - passive true
      addListener(toggle, 'touchstart', function () {
        // no-op; keep passive true to avoid blocking
      }, { passive: true });

      addListener(document, 'keydown', onDocumentKey, false);
      addListener(document, 'click', onDocumentClick, false);
    }

    /**
     * Smooth scroll handling for in-page anchors.
     */
    function setupSmoothScroll() {
      if (!opts.enableSmoothScroll) return;

      function handleAnchorClick(ev) {
        // Only left-click w/o modifier keys
        if (ev.defaultPrevented) return;
        // Some browsers set button === 0 for left click; guard if undefined
        if (ev.button !== undefined && ev.button !== 0) return;
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

        const link = ev.target.closest('a');
        if (!link) return;
        const href = link.getAttribute('href') || '';
        if (!href.startsWith('#')) return; // only same-page anchors

        // If href is just '#' no-op (smooth scroll to top)
        const id = href.slice(1);
        if (!id) {
          ev.preventDefault();
          try {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          } catch (_) {
            window.scrollTo(0, 0);
          }
          return;
        }

        const target = document.getElementById(id) || document.getElementsByName(id)[0];
        if (!target) return; // let default behavior occur (maybe external)
        ev.preventDefault();
        // compute top offset using runtime opts
        const top = Math.max(0, target.getBoundingClientRect().top + window.pageYOffset - (opts.smoothScrollOffset || DEFAULTS.smoothScrollOffset));
        try {
          window.scrollTo({ top, behavior: 'smooth' });
          // ensure focus & accessibility and pass runtime offset so focusAndReveal uses it
          focusAndReveal(target, opts.smoothScrollOffset);
        } catch (e) {
          window.scrollTo(0, top);
          try { focusAndReveal(target, opts.smoothScrollOffset); } catch (er) { /* ignore */ }
        }
      }

      // Delegate from document - single handler
      addListener(document, 'click', handleAnchorClick, false);
    }

    /**
     * Contact form validation and persistence
     */
    function setupContactForm() {
      if (!opts.enableContactForm) return;
      const form = document.querySelector(opts.contactFormSelector);
      if (!form) {
        Logger.debug('Contact form not found:', opts.contactFormSelector);
        return;
      }

      // find fields by common names
      const nameField = form.querySelector('[name="name"], [id="name"], input[name="fullname"]') || null;
      const emailField = form.querySelector('[name="email"], [id="email"]') || null;
      const messageField = form.querySelector('[name="message"], textarea[name="message"], [id="message"]') || null;

      // Prepare UI for inline error messages
      function ensureErrorEl(field) {
        if (!field) return null;
        let err = field.parentElement && field.parentElement.querySelector('.form-error');
        if (!err) {
          err = document.createElement('div');
          err.className = 'form-error';
          err.setAttribute('aria-live', 'polite');
          field.parentElement.appendChild(err);
        }
        return err;
      }

      function clearError(field) {
        if (!field) return;
        field.removeAttribute('aria-invalid');
        const err = field.parentElement && field.parentElement.querySelector('.form-error');
        if (err) err.textContent = '';
      }

      function showError(field, message) {
        if (!field) return;
        field.setAttribute('aria-invalid', 'true');
        const err = ensureErrorEl(field);
        setText(err, message);
      }

      function validateForm() {
        const errors = [];
        const nameVal = nameField ? (nameField.value || '').trim() : '';
        const emailVal = emailField ? (emailField.value || '').trim() : '';
        const msgVal = messageField ? (messageField.value || '').trim() : '';

        if (nameField && !nameVal) errors.push({ field: nameField, message: opts.messages.nameRequired });
        if (emailField && !emailVal) errors.push({ field: emailField, message: opts.messages.emailRequired });
        if (emailField && emailVal && !isValidEmail(emailVal)) errors.push({ field: emailField, message: opts.messages.emailInvalid });
        if (messageField && !msgVal) errors.push({ field: messageField, message: opts.messages.messageRequired });

        return errors;
      }

      function clearAllErrors() {
        [nameField, emailField, messageField].forEach(clearError);
      }

      function showFormSuccess() {
        // find or create a success message element
        let successEl = form.querySelector('.form-success');
        if (!successEl) {
          successEl = document.createElement('div');
          successEl.className = 'form-success';
          successEl.setAttribute('role', 'status');
          successEl.setAttribute('aria-live', 'polite');
          form.insertBefore(successEl, form.firstChild);
        }
        setText(successEl, opts.messages.successMessage);
      }

      function persistDraft() {
        try {
          const draft = {
            name: nameField ? (nameField.value || '') : '',
            email: emailField ? (emailField.value || '') : '',
            message: messageField ? (messageField.value || '') : '',
            ts: Date.now(),
          };
          localStorage.setItem(opts.contactDraftKey, JSON.stringify(draft));
          state.formDraft = draft;
          Logger.debug('Contact draft saved', draft);
        } catch (e) {
          Logger.warn('Could not save draft to localStorage', e);
        }
      }

      function restoreDraft() {
        try {
          const raw = localStorage.getItem(opts.contactDraftKey);
          if (!raw) return;
          const draft = JSON.parse(raw);
          if (!draft) return;
          if (nameField && draft.name) nameField.value = draft.name;
          if (emailField && draft.email) emailField.value = draft.email;
          if (messageField && draft.message) messageField.value = draft.message;
          state.formDraft = draft;
          Logger.debug('Contact draft restored', draft);
        } catch (e) {
          Logger.warn('Could not restore draft from localStorage', e);
        }
      }

      const debouncedPersist = debounce(persistDraft, opts.formDebounceMs);

      // Input handler to persist drafts and clear related errors
      function onInput(e) {
        const field = e.target;
        if (!field) return;
        clearError(field);
        debouncedPersist();
      }

      function handleSubmit(ev) {
        ev.preventDefault();
        clearAllErrors();
        const errors = validateForm();
        if (errors.length) {
          // show errors and focus first
          errors.forEach(err => showError(err.field, err.message));
          const first = errors[0].field;
          try { first.focus(); } catch (_) { /* ignore */ }
          return;
        }

        // Simulate success (no backend)
        try {
          // remove draft after successful submit
          localStorage.removeItem(opts.contactDraftKey);
          state.formDraft = null;
        } catch (e) {
          Logger.warn('Could not remove draft', e);
        }

        showFormSuccess();
        // Optionally clear form fields
        try {
          ev.target.reset();
        } catch (e) { /* ignore */ }

        Logger.info('Contact form validated and submitted (simulated)');
      }

      // Restore any saved draft
      restoreDraft();

      // Attach handlers
      addListener(form, 'input', onInput, false);
      addListener(form, 'change', onInput, false);
      addListener(form, 'submit', handleSubmit, false);
    }

    /**
     * Public init
     * @param {Object} options
     */
    function init(options) {
      if (state.initialized) {
        Logger.warn('SiteApp already initialized; ignoring duplicate init.');
        return SiteApp;
      }

      try {
        validateOptions(options);
      } catch (e) {
        console.error('SiteApp.init invalid options', e);
        throw e;
      }

      opts = Object.assign({}, DEFAULTS, options || {});
      // set logger level if provided
      if (opts.logger && opts.logger.level) Logger.setLevel(opts.logger.level);

      Logger.debug('Initializing with options', opts);

      try {
        if (opts.enableMobileNav) setupMobileNav();
        if (opts.enableSmoothScroll) setupSmoothScroll();
        if (opts.enableContactForm) setupContactForm();
      } catch (e) {
        Logger.error('Initialization error', e);
      }

      // mark initialized
      state.initialized = true;

      return SiteApp;
    }

    function teardown() {
      if (!state.initialized) {
        Logger.debug('SiteApp not initialized; nothing to teardown.');
        return;
      }
      removeAllListeners();

      // Clean up any tabindex attributes added by focusAndReveal, restoring previous values
      try {
        _revealedSet.forEach(el => {
          try {
            const prev = _revealedPrevTabIndex.get(el);
            if (prev === null || prev === undefined) {
              if (el.getAttribute && el.getAttribute('tabindex') === '-1') {
                el.removeAttribute('tabindex');
              }
            } else {
              if (el.setAttribute) el.setAttribute('tabindex', prev);
            }
          } catch (_) { /* ignore individual failures */ }
          try { _revealedPrevTabIndex.delete(el); } catch (_) {}
        });
        _revealedSet.clear();
      } catch (e) {
        Logger.debug('Error cleaning revealed elements during teardown', e);
      }

      state.initialized = false;
      Logger.info('SiteApp torn down');
    }

    // Expose public API (do not expose internals in production)
    return {
      init,
      teardown
    };
  })();

  // Safe auto-init on DOMContentLoaded unless explicitly disabled
  function ensureAutoInit() {
    try {
      // allow opt-out for tests or manual initialization
      if (global.__SITEAPP_NO_AUTO_INIT) {
        Logger && Logger.debug && Logger.debug('Auto-init disabled via __SITEAPP_NO_AUTO_INIT');
        return;
      }
      // if tests harness is enabled, tests will call init explicitly
      if (global.__SITEAPP_ENABLE_TESTS) {
        Logger && Logger.debug && Logger.debug('Auto-init skipped because __SITEAPP_ENABLE_TESTS is true');
        return;
      }

      function onReady() {
        try {
          // Only initialize once
          SiteApp.init();
        } catch (e) {
          console.error('SiteApp failed to initialize', e);
        }
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady, { once: true, passive: true });
      } else {
        // already ready
        setTimeout(onReady, 0);
      }
    } catch (e) {
      // fallback
      setTimeout(() => {
        try { SiteApp.init(); } catch (_) {}
      }, 0);
    }
  }

  // Attach to global for potential external usage (only the public API)
  try {
    if (!global.SiteApp) global.SiteApp = SiteApp;
  } catch (e) {
    // ignore
  }

  ensureAutoInit();

  /**
   * Minimal in-file test harness (created when global.__SITEAPP_ENABLE_TESTS is true).
   * This provides three small checks: mobile nav toggle, smooth-scroll anchor behavior,
   * and contact form validation/persistence. Intended for lightweight local dev checks.
   */
  try {
    if (global.__SITEAPP_ENABLE_TESTS) {
      global.SiteAppTests = {
        run: function (done) {
          const results = [];
          function assert(cond, msg) {
            results.push({ ok: !!cond, msg: msg || 'assert' });
            console.assert(cond, msg);
          }

          // Ensure a clean environment
          try { localStorage.removeItem(DEFAULTS.contactDraftKey); } catch (_) {}

          // 1) Mobile nav toggle
          (function testMobileNav() {
            const toggle = document.createElement('button');
            toggle.className = 'nav-toggle';
            toggle.textContent = 'Menu';
            const nav = document.createElement('nav');
            nav.className = 'main-nav';
            const a = document.createElement('a');
            a.href = '#';
            a.textContent = 'Home';
            nav.appendChild(a);
            document.body.appendChild(toggle);
            document.body.appendChild(nav);

            SiteApp.init();
            toggle.click();
            assert(document.body.classList.contains(DEFAULTS.mobileNavOpenClass), 'Mobile nav should open on toggle click');
            toggle.click();
            assert(!document.body.classList.contains(DEFAULTS.mobileNavOpenClass), 'Mobile nav should close on second toggle click');
            SiteApp.teardown();
            // cleanup
            document.body.removeChild(toggle);
            document.body.removeChild(nav);
          })();

          // 2) Smooth scroll anchor behavior
          (function testSmoothScroll(doneAnchor) {
            const target = document.createElement('section');
            target.id = 'test-section';
            target.style.height = '10px';
            target.textContent = 'Target';
            const anchor = document.createElement('a');
            anchor.href = '#test-section';
            anchor.textContent = 'Go';
            document.body.appendChild(anchor);
            document.body.appendChild(target);

            SiteApp.init();
            const evt = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
            anchor.dispatchEvent(evt);
            // Immediately after dispatch the target should have been focused and tabindex applied temporarily
            const hasTab = target.getAttribute && target.getAttribute('tabindex') === '-1';
            assert(hasTab, 'Target should receive temporary tabindex when navigating via anchor');
            SiteApp.teardown();
            document.body.removeChild(anchor);
            document.body.removeChild(target);
            if (doneAnchor) doneAnchor();
          })();

          // 3) Contact form validation / persistence
          (function testContactForm(donePersist) {
            const form = document.createElement('form');
            form.id = 'contact-form';
            const name = document.createElement('input'); name.name = 'name';
            const email = document.createElement('input'); email.name = 'email';
            const message = document.createElement('textarea'); message.name = 'message';
            const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Send';
            form.appendChild(name); form.appendChild(email); form.appendChild(message); form.appendChild(submit);
            document.body.appendChild(form);

            SiteApp.init();

            // Test validation: submit empty form should show errors
            const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
            form.dispatchEvent(submitEvent);
            // After submit, aria-invalid should be set on required fields
            assert(name.getAttribute && name.getAttribute('aria-invalid') === 'true', 'Name field should be marked invalid after empty submit');
            assert(email.getAttribute && email.getAttribute('aria-invalid') === 'true', 'Email field should be marked invalid after empty submit');

            // Test persistence: input text and wait for debounce
            name.value = 'Tester';
            email.value = 'tester@example.com';
            message.value = 'Hello';
            const inputEvent = new Event('input', { bubbles: true, cancelable: true });
            name.dispatchEvent(inputEvent);
            email.dispatchEvent(inputEvent);
            message.dispatchEvent(inputEvent);

            setTimeout(() => {
              try {
                const raw = localStorage.getItem(DEFAULTS.contactDraftKey);
                assert(raw && raw.indexOf('Tester') !== -1, 'Draft should be persisted to localStorage after input debounce');
              } catch (e) {
                assert(false, 'Exception while reading draft: ' + e);
              }

              SiteApp.teardown();
              document.body.removeChild(form);
              if (donePersist) donePersist();
            }, DEFAULTS.formDebounceMs + 100);
          })();

          // Allow async persistence test to finish if provided a done callback
          if (typeof done === 'function') {
            setTimeout(() => done(results), DEFAULTS.formDebounceMs + 200);
          } else {
            // otherwise log results later
            setTimeout(() => {
              console.info('SiteAppTests results', results);
            }, DEFAULTS.formDebounceMs + 200);
          }
        }
      };
    }
  } catch (e) {
    // non-critical test harness errors should not break app
    try { console.debug('SiteApp test harness error', e); } catch (_) {}
  }

})(typeof window !== 'undefined' ? window : this);