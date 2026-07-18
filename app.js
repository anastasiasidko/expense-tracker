// ---------- Constants ----------

const STORAGE_KEY = 'expenseTracker.v1';
const RATE_BASE = 'USD';
const RATE_QUOTES = ['ILS', 'EUR'];
const FALLBACK_RATES = { ILS: 3.65, EUR: 0.92 }; // rough hardcoded fallback if no cache exists yet

const DEFAULT_CATEGORIES = [
  { id: 'transport', label: 'Transport', icon: '🚌', isDefault: true },
  { id: 'dancing', label: 'Dancing', icon: '💃', isDefault: true },
  { id: 'eating_out', label: 'Eating out', icon: '🍜', isDefault: true },
  { id: 'groceries', label: 'Groceries', icon: '🛒', isDefault: true },
  { id: 'apartment', label: 'Apartment', icon: '🏠', isDefault: true },
  { id: 'utilities', label: 'Utility bills', icon: '💡', isDefault: true },
  { id: 'taxes', label: 'Taxes', icon: '🧾', isDefault: true },
  { id: 'travel', label: 'Travel', icon: '✈️', isDefault: true },
  { id: 'clothes', label: 'Clothes', icon: '👕', isDefault: true },
  { id: 'beauty', label: 'Beauty', icon: '✨', isDefault: true },
  { id: 'therapy', label: 'Therapy', icon: '🤝', isDefault: true },
  { id: 'learning', label: 'Work/Learning', icon: '📚', isDefault: true },
  { id: 'entertainment', label: 'Entertainment', icon: '📺', isDefault: true },
  { id: 'extra', label: 'Extra', icon: '🔖', isDefault: true, nonDeletable: true },
];

// Canonical display order + icon/label for known categories, derived from the list above.
const CATEGORY_ORDER = DEFAULT_CATEGORIES.map((c) => c.id);

function orderedCategories() {
  return [...state.categories].sort((a, b) => {
    const ra = CATEGORY_ORDER.includes(a.id) ? CATEGORY_ORDER.indexOf(a.id) : CATEGORY_ORDER.length;
    const rb = CATEGORY_ORDER.includes(b.id) ? CATEGORY_ORDER.indexOf(b.id) : CATEGORY_ORDER.length;
    return ra - rb;
  });
}

const CURRENCY_SYMBOLS = { ILS: '₪', USD: '$', EUR: '€' };
const QUICK_CURRENCIES = ['ILS', 'USD', 'EUR'];
// Small static fallback list used if the live currency list hasn't loaded yet.
const ALL_CURRENCIES_FALLBACK = ['ILS', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'CNY', 'INR'];

function defaultState() {
  return {
    schemaVersion: 1,
    expenses: [],
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    settings: {
      monthlyLimitILS: 12000,
      anomalyLookbackMonths: 3,
      anomalyThreshold: 1.3,
      alertsShownByMonth: {},
      cachedRate: null, // { base, quotes: {ILS, EUR}, fetchedAt }
      currencyList: null, // { code: name, ... } cached from API
      defaultCurrency: 'ILS',
    },
  };
}

// ---------- State persistence ----------

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const base = defaultState();
    const merged = {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
    };
    // Known default categories have no rename/re-icon UI, so keep their icon/label
    // in sync with the source of truth above rather than the value saved at seed time.
    merged.categories = merged.categories.map((cat) => {
      const canonical = DEFAULT_CATEGORIES.find((d) => d.id === cat.id);
      return canonical ? { ...cat, icon: canonical.icon, label: canonical.label } : cat;
    });
    return merged;
  } catch (e) {
    console.error('Failed to load state, resetting', e);
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function monthKeyFromTimestamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function shiftMonthKey(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function firstOfMonthTimestamp(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m - 1, 1, 12, 0, 0).toISOString();
}

function getCategory(id) {
  return state.categories.find((c) => c.id === id) || { id, label: id, icon: '❔' };
}

// ---------- Exchange rate ----------

async function ensureRate() {
  const cached = state.settings.cachedRate;
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (cached && now - new Date(cached.fetchedAt).getTime() < ONE_DAY) {
    return cached;
  }
  try {
    const url = `https://api.frankfurter.dev/v1/latest?from=${RATE_BASE}&to=${RATE_QUOTES.join(',')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('rate fetch failed: ' + res.status);
    const data = await res.json();
    const fresh = { base: RATE_BASE, quotes: data.rates, fetchedAt: new Date().toISOString() };
    state.settings.cachedRate = fresh;
    saveState();
    return fresh;
  } catch (e) {
    console.warn('Exchange rate fetch failed, using cache/fallback', e);
    if (cached) return cached;
    const fallback = { base: RATE_BASE, quotes: FALLBACK_RATES, fetchedAt: null, estimated: true };
    state.settings.cachedRate = fallback;
    saveState();
    return fallback;
  }
}

async function ensureCurrencyList() {
  if (state.settings.currencyList) return state.settings.currencyList;
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/currencies');
    if (!res.ok) throw new Error('currency list fetch failed');
    const data = await res.json();
    state.settings.currencyList = data;
    saveState();
    return data;
  } catch (e) {
    console.warn('Currency list fetch failed, using fallback list', e);
    const fallback = {};
    ALL_CURRENCIES_FALLBACK.forEach((c) => (fallback[c] = c));
    return fallback;
  }
}

// Convert an amount from `fromCurrency` to `toCurrency` using the cached rate (base USD).
function convert(amount, fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) return amount;
  const rate = state.settings.cachedRate;
  const quotes = (rate && rate.quotes) || FALLBACK_RATES;
  const perUsd = (code) => (code === RATE_BASE ? 1 : quotes[code]);
  const fromPerUsd = perUsd(fromCurrency);
  const toPerUsd = perUsd(toCurrency);
  if (!fromPerUsd || !toPerUsd) return amount; // unknown currency, no-op
  const usd = amount / fromPerUsd;
  return usd * toPerUsd;
}

function formatMoney(amount, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] || currency + ' ';
  return `${symbol}${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// ---------- Chat state machine ----------

const chatState = {
  step: 'idle', // idle/amount -> awaiting-selection (category)
  amount: null,
};

const feedEl = document.getElementById('chat-feed');
const inputForm = document.getElementById('chat-input-form');
const inputEl = document.getElementById('chat-input');
const currencyBtn = document.getElementById('currency-btn');
const currencyPopover = document.getElementById('currency-popover');

function scrollFeedToBottom() {
  feedEl.scrollTop = feedEl.scrollHeight;
}

function addBubble(html, who = 'bot') {
  const div = document.createElement('div');
  div.className = who === 'bot' ? 'bubble-bot text-sm' : 'bubble-user text-sm';
  div.innerHTML = html;
  feedEl.appendChild(div);
  scrollFeedToBottom();
  return div;
}

// In-progress amount/category prompts are scratch UI, not a log entry — tracked here
// so they can be wiped once the expense is finalized, leaving only the confirmation.
let flowNodes = [];

function trackFlowNode(node) {
  flowNodes.push(node);
  return node;
}

function clearFlowNodes() {
  flowNodes.forEach((n) => n.remove());
  flowNodes = [];
}

function addChipsRow(chips, onPick, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'self-start flex flex-wrap gap-2 max-w-[92%]';
  chips.forEach((chip) => {
    const btn = document.createElement('button');
    btn.className = 'chip' + (chip.dashed ? ' dashed' : '');
    btn.textContent = chip.label;
    btn.addEventListener('click', () => {
      if (opts.singleUse) {
        Array.from(wrap.children).forEach((c) => (c.disabled = true));
        btn.classList.add('selected');
      }
      onPick(chip, wrap);
    });
    wrap.appendChild(btn);
  });
  feedEl.appendChild(wrap);
  scrollFeedToBottom();
  return wrap;
}

function resetChatIdle() {
  chatState.amount = null;
  inputEl.value = '';
  inputEl.disabled = false;
  inputEl.focus();
  startFlow();
}

function startFlow() {
  chatState.step = 'amount';
}

inputForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = inputEl.value.trim();
  if (!raw) return;
  if (chatState.step === 'amount') {
    const amount = parseFloat(raw.replace(',', '.'));
    if (isNaN(amount) || amount <= 0) {
      trackFlowNode(addBubble("That doesn't look like a valid amount — try a number like 42.50."));
      return;
    }
    clearFlowNodes();
    chatState.amount = amount;
    chatState.step = 'awaiting-selection';
    trackFlowNode(addBubble(formatMoney(amount, state.settings.defaultCurrency), 'user'));
    inputEl.value = '';
    inputEl.disabled = true;
    promptCategory();
  }
});

// ---------- Default currency selector (persistent, next to the input bar) ----------

function currencyLabel(code) {
  return `${CURRENCY_SYMBOLS[code] || ''} ${code}`.trim();
}

function updateCurrencyBtn() {
  currencyBtn.textContent = currencyLabel(state.settings.defaultCurrency);
}

function closeCurrencyPopover() {
  currencyPopover.classList.add('hidden');
  currencyPopover.innerHTML = '';
}

function setDefaultCurrency(code) {
  state.settings.defaultCurrency = code;
  saveState();
  updateCurrencyBtn();
  closeCurrencyPopover();
}

function popoverOptionBtn(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'text-left px-2.5 py-1.5 rounded-lg hover:bg-slate-100 text-sm';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderCurrencyPopoverQuick() {
  currencyPopover.innerHTML = '';
  QUICK_CURRENCIES.forEach((code) => {
    const btn = popoverOptionBtn(currencyLabel(code), () => setDefaultCurrency(code));
    if (code === state.settings.defaultCurrency) btn.classList.add('font-semibold');
    currencyPopover.appendChild(btn);
  });
  currencyPopover.appendChild(
    popoverOptionBtn('More…', async () => {
      currencyPopover.innerHTML = '<div class="text-xs text-slate-400 px-2 py-1">Loading…</div>';
      const list = await ensureCurrencyList();
      renderCurrencyPopoverSearch(list);
    })
  );
}

function renderCurrencyPopoverSearch(list) {
  currencyPopover.innerHTML = `
    <input type="text" placeholder="Search…" class="border border-slate-200 rounded-full px-2.5 py-1 text-xs mb-1 currency-search-input">
    <div class="flex flex-col max-h-48 overflow-y-auto currency-search-results"></div>
  `;
  const searchInput = currencyPopover.querySelector('.currency-search-input');
  const resultsEl = currencyPopover.querySelector('.currency-search-results');

  function renderResults(filter) {
    resultsEl.innerHTML = '';
    const f = filter.toLowerCase();
    Object.entries(list)
      .filter(([code, name]) => !f || code.toLowerCase().includes(f) || name.toLowerCase().includes(f))
      .slice(0, 30)
      .forEach(([code, name]) => {
        const btn = popoverOptionBtn(`${code} — ${name}`, () => setDefaultCurrency(code));
        btn.className += ' text-xs';
        resultsEl.appendChild(btn);
      });
  }
  renderResults('');
  searchInput.addEventListener('input', () => renderResults(searchInput.value));
  searchInput.focus();
}

currencyBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (currencyPopover.classList.contains('hidden')) {
    renderCurrencyPopoverQuick();
    currencyPopover.classList.remove('hidden');
  } else {
    closeCurrencyPopover();
  }
});
document.addEventListener('click', (e) => {
  if (!currencyPopover.classList.contains('hidden') && !currencyPopover.contains(e.target) && e.target !== currencyBtn) {
    closeCurrencyPopover();
  }
});

function promptCategory() {
  trackFlowNode(addBubble('What category?'));
  const wrap = document.createElement('div');
  wrap.className = 'self-start flex flex-wrap gap-2 max-w-[92%]';
  feedEl.appendChild(wrap);
  trackFlowNode(wrap);

  function renderChips() {
    wrap.innerHTML = '';
    orderedCategories().forEach((cat) => {
      const btn = document.createElement('button');
      btn.className = 'chip';
      btn.textContent = `${cat.icon} ${cat.label}`;
      btn.addEventListener('click', () => {
        Array.from(wrap.children).forEach((c) => (c.disabled = true));
        trackFlowNode(addBubble(`${cat.icon} ${cat.label}`, 'user'));
        finalizeExpense(cat.id);
      });
      wrap.appendChild(btn);
    });
    const addBtn = document.createElement('button');
    addBtn.className = 'chip dashed';
    addBtn.textContent = '+ Add';
    addBtn.addEventListener('click', () => showAddCategoryInline(renderChips));
    wrap.appendChild(addBtn);
  }
  renderChips();
  scrollFeedToBottom();
}

function showAddCategoryInline(onAdded) {
  const wrap = document.createElement('div');
  wrap.className = 'self-start max-w-[92%] bg-slate-50 border border-slate-200 rounded-xl p-3 flex flex-col gap-2';
  wrap.innerHTML = `
    <div class="flex gap-2">
      <input type="text" maxlength="4" placeholder="🏷️" class="w-14 border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-center emoji-input">
      <input type="text" placeholder="Category name" class="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm label-input">
    </div>
    <button class="chip self-start save-cat-btn">Add category</button>
  `;
  feedEl.appendChild(wrap);
  trackFlowNode(wrap);
  scrollFeedToBottom();
  const emojiInput = wrap.querySelector('.emoji-input');
  const labelInput = wrap.querySelector('.label-input');
  labelInput.focus();
  wrap.querySelector('.save-cat-btn').addEventListener('click', () => {
    const label = labelInput.value.trim();
    if (!label) { labelInput.focus(); return; }
    const icon = emojiInput.value.trim() || '🏷️';
    const id = 'c_' + uid();
    state.categories.push({ id, label, icon, isDefault: false });
    saveState();
    wrap.remove();
    onAdded();
  });
}

function finalizeExpense(categoryId) {
  const record = {
    id: uid(),
    amount: chatState.amount,
    currency: state.settings.defaultCurrency,
    categoryId,
    note: '',
    timestamp: new Date().toISOString(),
  };
  record.monthKey = monthKeyFromTimestamp(record.timestamp);
  state.expenses.push(record);
  saveState();

  clearFlowNodes();
  renderConfirmationBubble(record, { allowNote: true });
  runAlertChecks(record.monthKey, categoryId);
  resetChatIdle();
}

function renderConfirmationBubble(record, { allowNote } = {}) {
  const cat = getCategory(record.categoryId);
  const container = document.createElement('div');
  container.className = 'self-start max-w-[88%] flex flex-col gap-1';
  const bubble = document.createElement('div');
  bubble.className = 'bubble-bot text-sm';
  bubble.innerHTML = `Logged ${formatMoney(record.amount, record.currency)} for ${cat.icon} ${cat.label}`;
  container.appendChild(bubble);

  const footerRow = document.createElement('div');
  footerRow.className = 'flex items-center gap-3 pl-2';
  container.appendChild(footerRow);

  const noteLine = document.createElement('div');
  footerRow.appendChild(noteLine);

  const editBtn = document.createElement('button');
  editBtn.className = 'text-xs text-slate-400 underline shrink-0';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => openTransactionEdit(record.id));
  footerRow.appendChild(editBtn);

  function renderNoteLine() {
    if (record.note) {
      noteLine.innerHTML = `<span class="text-xs italic text-slate-500">${escapeHtml(record.note)}</span>`;
    } else if (allowNote) {
      noteLine.innerHTML = `<button class="text-xs text-slate-400 underline add-note-link">+ Add note</button>`;
      noteLine.querySelector('.add-note-link').addEventListener('click', () => {
        noteLine.innerHTML = `
          <div class="flex gap-1.5 mt-1">
            <input type="text" placeholder="Note…" class="flex-1 border border-slate-200 rounded-full px-3 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-slate-300 note-input">
            <button class="text-xs px-2 py-1 rounded-full bg-slate-900 text-white note-save-btn">Save</button>
          </div>`;
        const noteInput = noteLine.querySelector('.note-input');
        noteInput.focus();
        function saveNote() {
          const val = noteInput.value.trim();
          if (val) {
            record.note = val;
            const idx = state.expenses.findIndex((e) => e.id === record.id);
            if (idx !== -1) state.expenses[idx].note = val;
            saveState();
          }
          renderNoteLine();
        }
        noteLine.querySelector('.note-save-btn').addEventListener('click', saveNote);
        noteInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); saveNote(); } });
      });
    } else {
      noteLine.innerHTML = '';
    }
  }
  renderNoteLine();

  feedEl.appendChild(container);
  scrollFeedToBottom();
  return container;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Alerts: monthly limit + category anomaly ----------

function totalForMonthILS(monthKey) {
  return state.expenses
    .filter((e) => e.monthKey === monthKey)
    .reduce((sum, e) => sum + convert(e.amount, e.currency, 'ILS'), 0);
}

function runAlertChecks(monthKey, categoryId) {
  checkMonthlyLimit(monthKey);
  checkCategoryAnomaly(monthKey, categoryId);
}

function checkMonthlyLimit(monthKey) {
  const limit = state.settings.monthlyLimitILS;
  if (!limit) return;
  const total = totalForMonthILS(monthKey);
  const pct = total / limit;
  const shown = state.settings.alertsShownByMonth[monthKey] || { total90: false, total100: false };

  if (pct >= 1 && !shown.total100) {
    addBubble(`⚠️ You've crossed <strong>100%</strong> of your ₪${limit.toLocaleString()} monthly limit — total so far is ${formatMoney(total, 'ILS')}.`);
    shown.total100 = true;
    shown.total90 = true;
  } else if (pct >= 0.9 && !shown.total90) {
    addBubble(`⚠️ Heads up — you've hit <strong>90%</strong> of your ₪${limit.toLocaleString()} monthly limit (${formatMoney(total, 'ILS')} so far).`);
    shown.total90 = true;
  }
  state.settings.alertsShownByMonth[monthKey] = shown;
  saveState();
}

function priorMonthKeys(monthKey, count) {
  const keys = [];
  for (let i = 1; i <= count; i++) keys.push(shiftMonthKey(monthKey, -i));
  return keys;
}

function categoryTotalForMonthILS(monthKey, categoryId) {
  return state.expenses
    .filter((e) => e.monthKey === monthKey && e.categoryId === categoryId)
    .reduce((sum, e) => sum + convert(e.amount, e.currency, 'ILS'), 0);
}

// Returns { average, monthsWithData } for the trailing lookback window, or null if no prior data.
function categoryTrailingAverage(monthKey, categoryId, lookbackMonths) {
  const keys = priorMonthKeys(monthKey, lookbackMonths);
  const totals = keys
    .map((k) => categoryTotalForMonthILS(k, categoryId))
    .filter((t) => t > 0);
  if (totals.length === 0) return null;
  const average = totals.reduce((a, b) => a + b, 0) / totals.length;
  return { average, monthsWithData: totals.length };
}

function checkCategoryAnomaly(monthKey, categoryId) {
  const { anomalyLookbackMonths, anomalyThreshold } = state.settings;
  const trailing = categoryTrailingAverage(monthKey, categoryId, anomalyLookbackMonths);
  if (!trailing) return; // not enough history — skip silently
  const current = categoryTotalForMonthILS(monthKey, categoryId);
  if (current <= trailing.average * anomalyThreshold) return;
  const cat = getCategory(categoryId);
  const pctOver = Math.round(((current - trailing.average) / trailing.average) * 100);
  addBubble(
    `📈 ${cat.icon} ${cat.label} is <strong>${pctOver}% above</strong> your usual this month ` +
    `(${formatMoney(current, 'ILS')} vs your ~${formatMoney(trailing.average, 'ILS')} average).`
  );
}

// ---------- Reconstruct recent chat log on load ----------

function reconstructFeed() {
  feedEl.innerHTML = '';
  const recent = [...state.expenses]
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .slice(-25);
  recent.forEach((record) => renderConfirmationBubble(record, { allowNote: false }));
  startFlow();
}

// ---------- Tab navigation ----------

const views = { chat: 'view-chat', summary: 'view-summary', transactions: 'view-transactions', settings: 'view-settings' };

document.querySelectorAll('.tabbtn').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function switchView(name) {
  Object.entries(views).forEach(([key, id]) => {
    document.getElementById(id).classList.toggle('active', key === name);
  });
  document.querySelectorAll('.tabbtn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  if (name === 'summary') renderSummary();
  if (name === 'transactions') renderTransactions();
  if (name === 'settings') renderSettings();
}

// ---------- Summary screen ----------

let summaryMonthKey = monthKeyFromTimestamp(Date.now());
let summaryCurrency = 'ILS';

document.getElementById('summary-prev-month').addEventListener('click', () => {
  summaryMonthKey = shiftMonthKey(summaryMonthKey, -1);
  renderSummary();
});
document.getElementById('summary-next-month').addEventListener('click', () => {
  summaryMonthKey = shiftMonthKey(summaryMonthKey, 1);
  renderSummary();
});
document.querySelectorAll('.currency-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    summaryCurrency = btn.dataset.currency;
    renderSummary();
  });
});

function daysInMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function renderSummary() {
  document.getElementById('summary-month-label').textContent = monthLabel(summaryMonthKey);
  document.querySelectorAll('.currency-toggle-btn').forEach((btn) => {
    btn.classList.toggle('bg-white', btn.dataset.currency === summaryCurrency);
    btn.classList.toggle('shadow-sm', btn.dataset.currency === summaryCurrency);
    btn.classList.toggle('font-semibold', btn.dataset.currency === summaryCurrency);
  });

  const monthExpenses = state.expenses.filter((e) => e.monthKey === summaryMonthKey);
  const totalILS = totalForMonthILS(summaryMonthKey);
  const totalDisplay = convert(totalILS, 'ILS', summaryCurrency);
  const limit = state.settings.monthlyLimitILS;
  const limitDisplay = convert(limit, 'ILS', summaryCurrency);
  const pct = limit ? totalILS / limit : 0;

  const today = new Date();
  const isCurrentMonth = summaryMonthKey === monthKeyFromTimestamp(Date.now());
  const dim = daysInMonth(summaryMonthKey);
  const daysElapsed = isCurrentMonth ? today.getDate() : dim;
  const pace = daysElapsed > 0 ? (totalILS / daysElapsed) * dim : totalILS;
  const paceDisplay = convert(pace, 'ILS', summaryCurrency);

  const barColor = pct >= 1 ? 'bg-red-500' : pct >= 0.9 ? 'bg-amber-500' : 'bg-emerald-500';

  const catTotals = {};
  monthExpenses.forEach((e) => {
    catTotals[e.categoryId] = (catTotals[e.categoryId] || 0) + convert(e.amount, e.currency, 'ILS');
  });
  const catRows = Object.entries(catTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([catId, totalIls]) => {
      const cat = getCategory(catId);
      const displayAmt = convert(totalIls, 'ILS', summaryCurrency);
      const trailing = categoryTrailingAverage(summaryMonthKey, catId, state.settings.anomalyLookbackMonths);
      let badge;
      if (!trailing) {
        badge = `<span class="text-[11px] text-slate-400">Not enough history yet</span>`;
      } else {
        const pctOver = Math.round(((totalIls - trailing.average) / trailing.average) * 100);
        badge = totalIls > trailing.average * state.settings.anomalyThreshold
          ? `<span class="text-[11px] font-medium text-red-600">+${pctOver}% vs usual</span>`
          : '';
      }
      return `
        <div class="border-b border-slate-100">
          <button class="summary-cat-row w-full flex items-center justify-between py-2 text-left" data-category-id="${catId}">
            <div class="flex items-center gap-2">
              <span class="text-lg">${cat.icon}</span>
              <span class="text-sm">${cat.label}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <div class="text-right">
                <div class="text-sm font-medium">${formatMoney(displayAmt, summaryCurrency)}</div>
                ${badge}
              </div>
              <span class="summary-cat-chevron text-slate-300 text-xs">▾</span>
            </div>
          </button>
          <div class="summary-cat-detail-slot"></div>
        </div>`;
    })
    .join('');

  document.getElementById('summary-content').innerHTML = `
    <div class="px-4 py-3">
      <div class="flex items-baseline justify-between mb-1">
        <span class="text-2xl font-semibold">${formatMoney(totalDisplay, summaryCurrency)}</span>
        <span class="text-xs text-slate-400">of ${formatMoney(limitDisplay, summaryCurrency)} limit</span>
      </div>
      <div class="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
        <div class="h-full ${barColor}" style="width:${Math.min(pct, 1) * 100}%"></div>
      </div>
      <div class="text-xs text-slate-400 mt-1.5">Pace: ${formatMoney(paceDisplay, summaryCurrency)} projected this month</div>
    </div>
    <div class="px-4">
      ${catRows || '<div class="text-sm text-slate-400 py-6 text-center">No expenses this month yet.</div>'}
    </div>
  `;

  document.querySelectorAll('.summary-cat-row').forEach((btn) => {
    btn.addEventListener('click', () => toggleCategoryDetail(btn));
  });
}

// ---------- Category detail dropdown (Summary) ----------

function toggleCategoryDetail(btn) {
  const slot = btn.nextElementSibling;
  const chevron = btn.querySelector('.summary-cat-chevron');
  if (slot.children.length) {
    slot.innerHTML = '';
    chevron.classList.remove('rotate-180');
    return;
  }
  document.querySelectorAll('.summary-cat-detail-slot').forEach((s) => (s.innerHTML = ''));
  document.querySelectorAll('.summary-cat-chevron').forEach((c) => c.classList.remove('rotate-180'));

  const categoryId = btn.dataset.categoryId;
  const items = state.expenses
    .filter((e) => e.monthKey === summaryMonthKey && e.categoryId === categoryId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  slot.innerHTML = items.length
    ? items.map((item) => `
        <div class="flex items-center justify-between py-2 pl-6 pr-1 border-t border-slate-50">
          <div class="min-w-0">
            <div class="text-sm">${formatMoney(item.amount, item.currency)}</div>
            <div class="text-xs text-slate-400 truncate">${isoDateOnly(item.timestamp)}${item.note ? ' · ' + escapeHtml(item.note) : ''}</div>
          </div>
          <button class="text-xs text-slate-500 underline shrink-0 category-detail-edit-btn" data-id="${item.id}">Edit</button>
        </div>`).join('')
    : '<div class="text-xs text-slate-400 py-3 pl-6">No expenses in this category.</div>';

  slot.querySelectorAll('.category-detail-edit-btn').forEach((editBtn) => {
    editBtn.addEventListener('click', () => openTransactionEdit(editBtn.dataset.id));
  });

  chevron.classList.add('rotate-180');
}

// ---------- Transactions screen ----------

let txMonthKey = monthKeyFromTimestamp(Date.now());

document.getElementById('tx-prev-month').addEventListener('click', () => {
  txMonthKey = shiftMonthKey(txMonthKey, -1);
  renderTransactions();
});
document.getElementById('tx-next-month').addEventListener('click', () => {
  txMonthKey = shiftMonthKey(txMonthKey, 1);
  renderTransactions();
});
document.getElementById('add-expense-btn').addEventListener('click', () => openTxForm(null));

function isoDateOnly(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderTransactions() {
  document.getElementById('tx-month-label').textContent = monthLabel(txMonthKey);
  const list = document.getElementById('tx-list');
  const monthExpenses = state.expenses
    .filter((e) => e.monthKey === txMonthKey)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (monthExpenses.length === 0) {
    list.innerHTML = '<div class="text-sm text-slate-400 py-10 text-center">No expenses this month.</div>';
    return;
  }

  list.innerHTML = '';
  monthExpenses.forEach((record) => {
    const cat = getCategory(record.categoryId);
    const row = document.createElement('div');
    row.className = 'border-b border-slate-100';
    row.dataset.expenseId = record.id;
    row.innerHTML = `
      <button class="w-full flex items-center justify-between px-4 py-3 text-left tx-row-btn">
        <div class="flex items-center gap-3 min-w-0">
          <span class="text-lg shrink-0">${cat.icon}</span>
          <div class="min-w-0">
            <div class="text-sm truncate">${cat.label}</div>
            <div class="text-xs text-slate-400 truncate">${isoDateOnly(record.timestamp)}${record.note ? ' · ' + escapeHtml(record.note) : ''}</div>
          </div>
        </div>
        <div class="text-sm font-medium shrink-0">${formatMoney(record.amount, record.currency)}</div>
      </button>
      <div class="tx-edit-slot"></div>
    `;
    row.querySelector('.tx-row-btn').addEventListener('click', () => toggleTxRow(row, record));
    list.appendChild(row);
  });
}

function toggleTxRow(row, record, forceOpen = false) {
  const slot = row.querySelector('.tx-edit-slot');
  if (slot.children.length) {
    if (!forceOpen) slot.innerHTML = '';
    return;
  }
  slot.appendChild(buildTxForm(record));
}

// Switches to the Transactions tab, jumps to the expense's month, and expands its edit form.
function openTransactionEdit(expenseId) {
  const record = state.expenses.find((e) => e.id === expenseId);
  if (!record) return;
  txMonthKey = record.monthKey;
  switchView('transactions');
  const row = document.querySelector(`#tx-list [data-expense-id="${expenseId}"]`);
  if (row) {
    toggleTxRow(row, record, true);
    row.scrollIntoView({ block: 'center' });
  }
}

function openTxForm(record) {
  const list = document.getElementById('tx-list');
  const wrap = document.createElement('div');
  wrap.className = 'border-b border-slate-100';
  wrap.appendChild(buildTxForm(record));
  list.prepend(wrap);
}

function buildTxForm(existingRecord) {
  const isNew = !existingRecord;
  const defaultTimestamp = txMonthKey === monthKeyFromTimestamp(Date.now())
    ? new Date().toISOString()
    : firstOfMonthTimestamp(txMonthKey);
  const record = existingRecord || { amount: '', currency: 'ILS', categoryId: orderedCategories()[0].id, note: '', timestamp: defaultTimestamp };
  const form = document.createElement('div');
  form.className = 'px-4 py-3 bg-slate-50 flex flex-col gap-2';

  const catOptions = orderedCategories().map((c) => `<option value="${c.id}" ${c.id === record.categoryId ? 'selected' : ''}>${c.icon} ${c.label}</option>`).join('');
  const currOptions = QUICK_CURRENCIES.map((c) => `<option value="${c}" ${c === record.currency ? 'selected' : ''}>${c}</option>`).join('');

  form.innerHTML = `
    <div class="flex gap-2">
      <input type="number" step="0.01" value="${record.amount}" placeholder="Amount" class="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm f-amount">
      <select class="border border-slate-200 rounded-lg px-2 py-1.5 text-sm f-currency">${currOptions}</select>
    </div>
    <select class="border border-slate-200 rounded-lg px-2 py-1.5 text-sm f-category">${catOptions}</select>
    <input type="date" value="${isoDateOnly(record.timestamp)}" class="border border-slate-200 rounded-lg px-2 py-1.5 text-sm f-date">
    <input type="text" value="${record.note ? escapeHtml(record.note) : ''}" placeholder="Note (optional)" class="border border-slate-200 rounded-lg px-2 py-1.5 text-sm f-note">
    <div class="flex gap-2 mt-1">
      <button class="flex-1 text-xs px-3 py-2 rounded-lg bg-slate-900 text-white f-save">Save</button>
      ${isNew ? '' : '<button class="text-xs px-3 py-2 rounded-lg border border-red-200 text-red-600 f-delete">Delete</button>'}
    </div>
  `;

  form.querySelector('.f-save').addEventListener('click', () => {
    const amount = parseFloat(form.querySelector('.f-amount').value);
    if (isNaN(amount) || amount <= 0) { form.querySelector('.f-amount').focus(); return; }
    const currency = form.querySelector('.f-currency').value;
    const categoryId = form.querySelector('.f-category').value;
    const dateVal = form.querySelector('.f-date').value; // YYYY-MM-DD
    const note = form.querySelector('.f-note').value.trim();
    const existingTime = existingRecord ? new Date(existingRecord.timestamp) : new Date();
    const [y, m, d] = dateVal.split('-').map(Number);
    const timestamp = new Date(y, m - 1, d, existingTime.getHours(), existingTime.getMinutes(), existingTime.getSeconds()).toISOString();
    const monthKey = monthKeyFromTimestamp(timestamp);

    if (isNew) {
      state.expenses.push({ id: uid(), amount, currency, categoryId, note, timestamp, monthKey });
    } else {
      const idx = state.expenses.findIndex((e) => e.id === existingRecord.id);
      if (idx !== -1) state.expenses[idx] = { ...existingRecord, amount, currency, categoryId, note, timestamp, monthKey };
    }
    saveState();
    txMonthKey = monthKey;
    renderTransactions();
  });

  const deleteBtn = form.querySelector('.f-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      state.expenses = state.expenses.filter((e) => e.id !== existingRecord.id);
      saveState();
      renderTransactions();
    });
  }

  return form;
}

// ---------- Settings screen ----------

function renderSettings() {
  const s = state.settings;
  const content = document.getElementById('settings-content');
  content.innerHTML = `
    <div>
      <label class="text-xs font-medium text-slate-500">Monthly spending limit (₪ ILS)</label>
      <input type="number" id="set-limit" value="${s.monthlyLimitILS}" class="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm">
    </div>
    <div>
      <label class="text-xs font-medium text-slate-500">Anomaly lookback (months)</label>
      <input type="number" id="set-lookback" value="${s.anomalyLookbackMonths}" min="1" class="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm">
    </div>
    <div>
      <label class="text-xs font-medium text-slate-500">Anomaly threshold (× average)</label>
      <input type="number" id="set-threshold" value="${s.anomalyThreshold}" step="0.05" min="1" class="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm">
    </div>
    <button id="set-save" class="text-sm px-3 py-2 rounded-lg bg-slate-900 text-white">Save settings</button>
    <div class="border-t pt-4 mt-2">
      <div class="text-xs font-medium text-slate-500 mb-2">Categories</div>
      <div id="set-categories" class="flex flex-col gap-1"></div>
    </div>
  `;
  document.getElementById('set-save').addEventListener('click', () => {
    const limit = parseFloat(document.getElementById('set-limit').value);
    const lookback = parseInt(document.getElementById('set-lookback').value, 10);
    const threshold = parseFloat(document.getElementById('set-threshold').value);
    if (!isNaN(limit)) s.monthlyLimitILS = limit;
    if (!isNaN(lookback) && lookback > 0) s.anomalyLookbackMonths = lookback;
    if (!isNaN(threshold) && threshold >= 1) s.anomalyThreshold = threshold;
    saveState();
    document.getElementById('set-save').textContent = 'Saved ✓';
    setTimeout(() => { document.getElementById('set-save').textContent = 'Save settings'; }, 1200);
  });

  const catList = document.getElementById('set-categories');
  orderedCategories().forEach((cat) => {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between py-1.5';
    row.innerHTML = `
      <span class="text-sm">${cat.icon} ${cat.label}</span>
      ${cat.nonDeletable ? '' : '<button class="text-xs text-red-500 del-cat-btn">Remove</button>'}
    `;
    const delBtn = row.querySelector('.del-cat-btn');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        const inUse = state.expenses.some((e) => e.categoryId === cat.id);
        if (inUse) {
          alert('This category has expenses logged against it and cannot be removed.');
          return;
        }
        state.categories = state.categories.filter((c) => c.id !== cat.id);
        saveState();
        renderSettings();
      });
    }
    catList.appendChild(row);
  });
}

// ---------- Init ----------

async function init() {
  updateCurrencyBtn();
  await ensureRate();
  reconstructFeed();
  renderSummary();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}

init();
