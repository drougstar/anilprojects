// The active tab is the visible page name; keep an accessible heading too.
import { currentScope } from './scope.js';
const pages = {
  overview: 'Overview',
  week: 'Timesheets',
  expenses: 'Expenses',
  settings: 'Settings'
};

export function updateShell(name) {
  const personal = currentScope().workspace === 'personal';
  const labels = personal ? { ...pages, overview: 'Monthly spending', expenses: 'Transactions' } : pages;
  const page = labels[name] || labels.overview;
  document.body.dataset.workspace = personal ? 'personal' : 'work';
  const heading = document.getElementById('page-title');
  if (heading) heading.textContent = page;
  document.title = page + (personal ? ' · Pocket / IFS Bridge' : ' · IFS Bridge');
  const brandMark = document.querySelector('.brand .mark'), brandName = document.querySelector('.brand > span:last-child');
  if (brandMark) brandMark.textContent = personal ? 'P' : 'IFS';
  if (brandName) brandName.textContent = personal ? 'Pocket' : 'Bridge';
  for (const button of document.querySelectorAll('.tabs button')) {
    const label = button.querySelector('span');
    if (label) label.textContent = labels[button.dataset.tab];
    document.getElementById(`tab-${button.dataset.tab}`)?.setAttribute('aria-label', labels[button.dataset.tab]);
    if (button.dataset.tab === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

export function initShell() {
  const updateNetwork = () => {
    const badge = document.getElementById('offline-status');
    if (badge) badge.hidden = navigator.onLine;
  };
  window.addEventListener('online', updateNetwork);
  window.addEventListener('offline', updateNetwork);
  updateNetwork();
}
