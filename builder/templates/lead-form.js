/**
 * lead-form.js — the only lead-submission code any AZ Contractor Pro site uses.
 *
 * Both tiers include this. Same payload shape, same endpoint, same failure
 * handling, so a lead behaves identically on a one-page prospect site and on a
 * full client build.
 *
 * Usage — put this on the page and mark up the form:
 *
 *   <form data-acp-lead
 *         data-endpoint="https://script.google.com/macros/s/AKfy.../exec"
 *         data-client-id="luis-rojos-masonry-llc">
 *     <input name="name" required>
 *     <input name="phone" type="tel">
 *     <input name="email" type="email">
 *     <select name="service">...</select>
 *     <textarea name="message"></textarea>
 *     <input name="company_website" tabindex="-1" autocomplete="off"
 *            aria-hidden="true" class="acp-hp">
 *     <button type="submit">Request a Free Estimate</button>
 *     <p data-acp-status role="status" aria-live="polite"></p>
 *   </form>
 *
 *   <style>.acp-hp{position:absolute;left:-9999px;width:1px;height:1px}</style>
 *
 * The honeypot must be visually hidden but NOT display:none — some bots skip
 * fields that are display:none, which defeats the point.
 */
(function () {
  'use strict';

  var FALLBACK_MS = 15000;

  function init(form) {
    var endpoint = form.getAttribute('data-endpoint');
    var clientId = form.getAttribute('data-client-id');
    var status = form.querySelector('[data-acp-status]');
    var button = form.querySelector('button[type="submit"], input[type="submit"]');

    if (!endpoint || !clientId) {
      // Loud in the console, invisible to visitors. A misconfigured form that
      // looks like it works is the failure mode worth preventing.
      console.error('[acp-lead] missing data-endpoint or data-client-id', form);
      return;
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (form.dataset.acpBusy === '1') return;

      var payload = { action: 'lead', client_id: clientId };
      Array.prototype.forEach.call(form.elements, function (el) {
        if (!el.name || el.type === 'submit') return;
        payload[el.name] = el.value;
      });
      payload.page = location.pathname + location.search;
      payload.source = document.referrer || 'direct';
      payload.user_agent = navigator.userAgent;

      if (!payload.name || !String(payload.name).trim()) {
        return say(status, 'Please enter your name.', 'error');
      }
      if (!payload.phone && !payload.email) {
        return say(status, 'Please add a phone number or email so we can reach you.', 'error');
      }

      form.dataset.acpBusy = '1';
      if (button) { button.disabled = true; button.dataset.label = button.textContent; button.textContent = 'Sending…'; }
      say(status, 'Sending…', 'pending');

      var done = false;
      var timer = setTimeout(function () {
        if (!done) finish(false, 'That took longer than expected. Please call us instead.');
      }, FALLBACK_MS);

      // Content-Type MUST stay text/plain. Anything else triggers a CORS
      // preflight, which Apps Script does not answer, and the lead is lost
      // while the visitor sees a success state. See router.gs.
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.ok) finish(true, 'Thanks — we got it. We\u2019ll be in touch shortly.');
          else finish(false, (data && data.error) || 'Something went wrong. Please call us.');
        })
        .catch(function () {
          finish(false, 'We couldn\u2019t send that. Please call us and we\u2019ll take it down.');
        });

      function finish(ok, message) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        form.dataset.acpBusy = '';
        if (button) { button.disabled = false; button.textContent = button.dataset.label || 'Send'; }
        say(status, message, ok ? 'success' : 'error');
        if (ok) {
          form.reset();
          form.dispatchEvent(new CustomEvent('acp:lead', { bubbles: true, detail: payload }));
          if (window.gtag) window.gtag('event', 'generate_lead', { client_id: clientId });
        }
      }
    });
  }

  function say(node, message, state) {
    if (!node) return;
    node.textContent = message;
    node.setAttribute('data-state', state);
  }

  function boot() {
    document.querySelectorAll('form[data-acp-lead]').forEach(init);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
