/**
 * Tenant context for the sidebar header.
 *
 * Kept in its own file rather than folded into app.js / app_v2.js: both of
 * those are loaded on this page and both are large, and this needs to run
 * regardless of which one owns a given control.
 */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.getElementById('tenant-bar');
    const label = document.getElementById('tenant-name');
    const switcher = document.getElementById('tenant-switcher');
    if (!bar || !label || !switcher) return;

    fetch('/api/me', { credentials: 'same-origin' })
      .then(res => (res.ok ? res.json() : null))
      .then(me => {
        if (!me) return;
        bar.hidden = false;
        label.textContent = me.tenant_name || 'No tenant selected';
        label.title = me.tenant_name
          ? `Acting as ${me.tenant_name} (${me.username}, ${me.role})`
          : 'Select a tenant to continue';

        // Only a superadmin can act as another tenant, so only they get the
        // switcher. For everyone else the label is the whole story.
        if (!me.is_superadmin) return;

        switcher.hidden = false;
        switcher.innerHTML = '';

        if (!me.tenant_id) {
          const placeholder = document.createElement('option');
          placeholder.value = '';
          placeholder.textContent = 'Select a tenant...';
          switcher.appendChild(placeholder);
        }

        (me.tenants || []).forEach(tenant => {
          const option = document.createElement('option');
          option.value = String(tenant.id);
          option.textContent = tenant.status === 'active'
            ? tenant.name
            : `${tenant.name} (${tenant.status})`;
          if (tenant.id === me.tenant_id) option.selected = true;
          switcher.appendChild(option);
        });

        switcher.addEventListener('change', () => {
          const tenantId = parseInt(switcher.value, 10);
          if (!tenantId) return;
          switcher.disabled = true;
          fetch('/api/tenants/switch', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenant_id: tenantId })
          })
            .then(res => res.json())
            .then(result => {
              if (result && result.success) {
                // A full reload is deliberate: the conversation list, the
                // websocket subscription and every cached view belong to the
                // old tenant and none of them may carry over.
                window.location.reload();
              } else {
                switcher.disabled = false;
                console.error('Tenant switch failed:', result && result.error);
              }
            })
            .catch(err => {
              switcher.disabled = false;
              console.error('Tenant switch failed:', err);
            });
        });
      })
      .catch(err => console.error('Could not load tenant context:', err));
  });
})();
