<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Download Development Guide</title>
<style>
  body {
    font-family: 'Segoe UI', sans-serif;
    background: #f5f7fa;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
  }
  .card {
    background: white;
    padding: 40px 50px;
    border-radius: 16px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.1);
    text-align: center;
    max-width: 500px;
  }
  h1 { color: #1e3a8a; margin-bottom: 12px; font-size: 22px; }
  p { color: #6b7280; margin-bottom: 24px; font-size: 14px; line-height: 1.6; }
  .file-info {
    background: #f3f4f6;
    padding: 14px 18px;
    border-radius: 10px;
    margin-bottom: 24px;
    font-size: 13px;
    color: #374151;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .file-info strong { color: #111827; font-family: monospace; }
  .btn {
    background: linear-gradient(135deg, #1e3a8a, #3b82f6);
    color: white;
    border: none;
    padding: 14px 32px;
    border-radius: 10px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    box-shadow: 0 4px 12px rgba(59,130,246,0.3);
  }
  .btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 18px rgba(59,130,246,0.4);
  }
  .btn:active { transform: translateY(0); }
  .status {
    margin-top: 18px;
    font-size: 13px;
    color: #10b981;
    font-weight: 600;
    opacity: 0;
    transition: opacity 0.3s;
  }
  .status.show { opacity: 1; }
</style>
</head>
<body>
  <div class="card">
    <h1>📘 Development Guide</h1>
    <p>IT Asset Management Dashboard အတွက် Development Guide ကို download လုပ်ပါ။</p>

    <div class="file-info">
      <span>📄 File name:</span>
      <strong>DashboardDesign_development.md</strong>
    </div>

    <button class="btn" onclick="downloadGuide()">⬇️ Download Markdown</button>
    <div class="status" id="status">✅ Download စတင်နေပါပြီ...</div>
  </div>

<script>
const GUIDE_CONTENT = `# 📘 IT Asset Management Dashboard — Development Guide

> Version 1.0.0 | Last updated: 2026

---

## 📑 Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [File Structure](#3-file-structure)
4. [Core Concepts](#4-core-concepts)
5. [CSS Variable System](#5-css-variable-system)
6. [Theme & Accent System](#6-theme--accent-system)
7. [JavaScript Modules](#7-javascript-modules)
8. [Chart Integration](#8-chart-integration)
9. [Adding New Features](#9-adding-new-features)
10. [Backend Integration](#10-backend-integration)
11. [Performance & Optimization](#11-performance--optimization)
12. [Accessibility](#12-accessibility)
13. [Testing](#13-testing)
14. [Deployment](#14-deployment)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Project Overview

### 1.1 ရည်ရွယ်ချက်

IT Asset Management Dashboard သည် organization တစ်ခုရဲ့ IT assets (laptops, desktops, servers, network devices) များကို **တစ်နေရာတည်းမှာ ကြည့်ရှု၊ စီမံ၊ ဆုံးဖြတ်** နိုင်ရန် ပြုလုပ်ထားတဲ့ web-based dashboard ဖြစ်သည်။

### 1.2 အဓိက Target Users

| User | လိုအပ်ချက် |
|------|-----------|
| IT Manager | Overview, KPI, Alerts |
| IT Admin | Asset list, Assignment, Maintenance |
| Finance | Asset value, Depreciation, Budget |
| Auditor | Compliance, Audit trail |

### 1.3 Tech Stack

\`\`\`
Frontend  : HTML5, CSS3, Vanilla JavaScript (ES6+)
Charting  : Chart.js v4
Storage   : localStorage (client-side preference)
Backend   : (Optional) Node.js / PHP / Python
Database  : (Optional) MySQL / PostgreSQL / MongoDB
\`\`\`

### 1.4 Design Principles

- **Summary first** — Detail ကို နောက်မှ
- **Progressive disclosure** — Tabs / drill-down နဲ့ ဖျောက်
- **Consistency** — CSS variables နဲ့ design token
- **Accessibility** — Keyboard, ARIA, contrast
- **Performance** — Vanilla JS, minimal dependencies

---

## 2. Architecture

### 2.1 High-Level Architecture

\`\`\`
┌─────────────────────────────────────────────────┐
│                   Browser                        │
│  ┌───────────────────────────────────────────┐  │
│  │          index.html (UI Shell)             │  │
│  │  ┌─────────┬─────────┬─────────┬────────┐ │  │
│  │  │ Header  │  KPI    │  Charts │ Table  │ │  │
│  │  └─────────┴─────────┴─────────┴────────┘ │  │
│  └───────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────┐  │
│  │      State Layer (localStorage)            │  │
│  │  - theme: light/dark                       │  │
│  │  - accent: blue/green/purple/...           │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
                        │
                        │ (Optional)
                        ▼
┌─────────────────────────────────────────────────┐
│              Backend API (REST)                  │
│  GET  /api/assets                                │
│  GET  /api/stats                                 │
│  POST /api/assets/:id/assign                     │
└─────────────────────────────────────────────────┘
\`\`\`

### 2.2 Data Flow

\`\`\`
User Action → Event Handler → State Update → Re-render → Chart Update
     │
     └─→ localStorage.setItem() → Persist
\`\`\`

---

## 3. File Structure

### 3.1 Single-File (Current)

\`\`\`
index.html
└── <style>  (CSS variables + components)
└── <body>   (HTML structure)
└── <script> (Theme, Accent, Tabs, Charts)
\`\`\`

### 3.2 Recommended Multi-File (Production)

\`\`\`
project/
├── index.html
├── assets/
│   ├── css/
│   │   ├── variables.css      # CSS variables (light + dark + accents)
│   │   ├── base.css           # Reset, typography
│   │   ├── components.css     # Cards, buttons, badges
│   │   └── layout.css         # Grid, responsive
│   ├── js/
│   │   ├── theme.js           # Theme toggle logic
│   │   ├── accent.js          # Accent color picker
│   │   ├── tabs.js            # Tab switching
│   │   ├── charts.js          # Chart.js setup
│   │   ├── api.js             # Backend fetch wrapper
│   │   └── main.js            # Entry point
│   └── img/
├── data/
│   └── mock.json              # Mock data for dev
├── package.json               # (Optional) build tools
└── README.md
\`\`\`

### 3.3 Build Tools (Optional)

\`\`\`bash
# Vite (recommended for modern dev)
npm create vite@latest it-asset-dashboard -- --template vanilla
cd it-asset-dashboard
npm install chart.js
npm run dev
\`\`\`

---

## 4. Core Concepts

### 4.1 State Management

Dashboard ရဲ့ state ကို **localStorage** မှာ သိမ်းသည် —

\`\`\`javascript
const AppState = {
  theme: 'light' | 'dark',
  accent: 'blue' | 'green' | 'purple' | 'orange' | 'pink' | 'teal',
  activeTab: 'overview',
  filters: { ... }
};
\`\`\`

**သိမ်းတဲ့ key များ:**

| Key | Type | Values |
|-----|------|--------|
| \`theme\` | string | \`light\`, \`dark\` |
| \`accent\` | string | \`blue\`, \`green\`, \`purple\`, \`orange\`, \`pink\`, \`teal\` |
| \`activeTab\` | string | \`overview\`, \`lifecycle\`, ... |

### 4.2 HTML Attributes စနစ်

Theme နဲ့ Accent ကို \`<html>\` element ရဲ့ attribute နဲ့ ထိန်းသည် —

\`\`\`html
<html data-theme="dark" data-accent="green">
\`\`\`

CSS မှာ selector နဲ့ ဖမ်းသည် —

\`\`\`css
[data-theme="dark"] { --bg-body: #0f172a; }
[data-accent="green"] { --accent: #10b981; }
\`\`\`

### 4.3 Initialization Order

\`\`\`
1. HTML parse
2. CSS load (variables apply)
3. Script load
   ↓
4. getInitialTheme()   → localStorage or system
5. getInitialAccent()  → localStorage or default
6. applyTheme()        → set <html data-theme>
7. applyAccent()       → set <html data-accent>
8. Init charts         → read computed CSS vars
9. Attach event listeners
\`\`\`

**⚠️ အရေးကြီး:** Chart ကို initialize လုပ်တဲ့အခါ **CSS variables apply ဖြစ်ပြီးမှ** ဖတ်ရမည်။

\`\`\`javascript
// ✅ Correct
applyTheme(getInitialTheme());
applyAccent(getInitialAccent());
const colors = getChartColors(); // CSS vars ဖတ်
new Chart(ctx, { ... });

// ❌ Wrong
new Chart(ctx, { ... }); // colors မရသေး
applyTheme(...);
\`\`\`

---

## 5. CSS Variable System

### 5.1 Variable Categories

| Category | ဥပမာ | ရည်ရွယ်ချက် |
|----------|------|-----------|
| **Background** | \`--bg-body\`, \`--bg-card\` | နောက်ခံအရောင် |
| **Text** | \`--text-primary\`, \`--text-muted\` | စာလုံးအရောင် |
| **Border** | \`--border-color\`, \`--border-table\` | ဘောင် |
| **Shadow** | \`--shadow-card\`, \`--shadow-header\` | အရိပ် |
| **Accent** | \`--accent\`, \`--accent-dark\`, \`--accent-light\` | အဓိကအရောင် |
| **Semantic** | \`--accent-red\`, \`--accent-green\` | အခြေအနေအရောင် |

### 5.2 Naming Convention

\`\`\`
--{category}-{element}-{modifier}

--bg-card              → background of card
--text-primary         → primary text
--border-color         → generic border
--accent-green         → semantic green
--accent-gradient-start → gradient start
\`\`\`

### 5.3 Variable အသစ် ထည့်နည်း

\`\`\`css
:root {
  --new-variable: #value;
}

[data-theme="dark"] {
  --new-variable: #dark-value;
}
\`\`\`

**Rule:** Light theme မှာ default သတ်မှတ်၊ Dark theme မှာ override လုပ်။

---

## 6. Theme & Accent System

### 6.1 Theme Toggle Flow

\`\`\`javascript
// 1. Initial theme determine
function getInitialTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches 
    ? 'dark' : 'light';
}

// 2. Apply
function applyTheme(theme) {
  htmlEl.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  updateAllCharts(); // Chart color update
}

// 3. Toggle
themeToggle.addEventListener('click', () => {
  const current = htmlEl.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});
\`\`\`

### 6.2 Accent Color Flow

\`\`\`javascript
function applyAccent(color) {
  htmlEl.setAttribute('data-accent', color);
  localStorage.setItem('accent', color);
  
  // Update active swatch
  swatches.forEach(s => {
    s.classList.toggle('active', s.dataset.color === color);
  });
  
  updateAllCharts();
}
\`\`\`

### 6.3 Accent အသစ် ထည့်နည်း

**Step 1:** CSS variable ထည့်

\`\`\`css
[data-accent="red"] {
  --accent: #dc2626;
  --accent-dark: #b91c1c;
  --accent-light: #fee2e2;
  --accent-gradient-start: #7f1d1d;
  --accent-gradient-end: #dc2626;
}
[data-theme="dark"][data-accent="red"] {
  --accent-light: #7f1d1d;
}
\`\`\`

**Step 2:** Swatch button ထည့်

\`\`\`html
<button class="color-swatch swatch-red" data-color="red" title="Red"></button>
\`\`\`

**Step 3:** Swatch CSS ထည့်

\`\`\`css
.swatch-red { background: linear-gradient(135deg, #7f1d1d, #dc2626); }
\`\`\`

**Step 4:** Chart update logic မှာ handle

\`\`\`javascript
chart.data.datasets[0].backgroundColor[0] = getComputedVar('--accent');
\`\`\`

### 6.4 Close-on-Outside-Click Pattern

\`\`\`javascript
colorToggle.addEventListener('click', (e) => {
  e.stopPropagation(); // Parent click ကို ရပ်
  colorMenu.classList.toggle('open');
});

document.addEventListener('click', (e) => {
  if (!colorMenu.contains(e.target) && e.target !== colorToggle) {
    colorMenu.classList.remove('open');
  }
});
\`\`\`

---

## 7. JavaScript Modules

### 7.1 Module Structure (Recommended)

\`\`\`javascript
// ---------- Theme Module ----------
const ThemeModule = (() => {
  const KEY = 'theme';
  const htmlEl = document.documentElement;
  
  function get() { return localStorage.getItem(KEY) || 'light'; }
  function set(theme) {
    htmlEl.setAttribute('data-theme', theme);
    localStorage.setItem(KEY, theme);
  }
  function toggle() { set(get() === 'dark' ? 'light' : 'dark'); }
  
  return { get, set, toggle };
})();
\`\`\`

### 7.2 Event Delegation

Dynamic elements (future table rows) အတွက် event delegation သုံးပါ —

\`\`\`javascript
document.querySelector('.table-wrap').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-asset-id]');
  if (row) openAssetDetail(row.dataset.assetId);
});
\`\`\`

### 7.3 Debounce / Throttle

Resize, search စတဲ့ event များအတွက် —

\`\`\`javascript
function debounce(fn, delay = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

window.addEventListener('resize', debounce(() => {
  chart.resize();
}, 200));
\`\`\`

---

## 8. Chart Integration

### 8.1 Chart.js Setup

\`\`\`html
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
\`\`\`

### 8.2 Chart Instance သိမ်း

\`\`\`javascript
// Global reference for update
window.categoryChartInstance = new Chart(ctx, { ... });
\`\`\`

**Rule:** Chart instance ကို **global** (window) သို့မဟုတ် **module scope** မှာ သိမ်းထားရမည်။ Theme/accent change ရင် update လုပ်ဖို့ လိုသည်။

### 8.3 Chart Color Update Pattern

\`\`\`javascript
function updateAllCharts() {
  const c = getChartColors();
  
  if (window.categoryChartInstance) {
    const chart = window.categoryChartInstance;
    chart.options.scales.y.grid.color = c.grid;
    chart.options.scales.y.ticks.color = c.tick;
    chart.options.scales.x.ticks.color = c.tick;
    chart.data.datasets[0].backgroundColor[0] = c.accent;
    chart.update('none'); // 'none' = animation မလို
  }
}
\`\`\`

### 8.4 Chart အသစ် ထည့်နည်း

\`\`\`javascript
const ctx3 = document.getElementById('myNewChart').getContext('2d');
window.myNewChartInstance = new Chart(ctx3, {
  type: 'pie',
  data: { ... },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { 
        labels: { color: getChartColors().legend }
      }
    }
  }
});

// updateAllCharts() ထဲ ထည့်
\`\`\`

### 8.5 Chart Container Size

\`\`\`css
.chart-container {
  position: relative;
  height: 240px; /* Fixed height လိုသည် */
}
\`\`\`

**⚠️** \`maintainAspectRatio: false\` သုံးရင် container မှာ **height** သတ်မှတ်ရမည်။

---

## 9. Adding New Features

### 9.1 New KPI Card ထည့်နည်း

\`\`\`html
<div class="kpi-card info">
  <div class="kpi-label">New Metric</div>
  <div class="kpi-value">123</div>
  <div class="kpi-meta up">▲ 5% this week</div>
</div>
\`\`\`

**Classes:**
- \`critical\` → 🔴 Red border
- \`warning\` → 🟠 Orange border
- \`success\` → 🟢 Green border
- \`info\` → 🔵 Accent border

### 9.2 New Tab ထည့်နည်း

\`\`\`html
<!-- 1. Tab button -->
<button class="tab-btn" data-tab="reports">Reports</button>

<!-- 2. Tab content -->
<div class="tab-content" id="tab-reports">
  <!-- Content -->
</div>
\`\`\`

JavaScript က auto handle လုပ်သည် (\`data-tab\` နဲ့ \`id="tab-..."\` match ရမည်)။

### 9.3 Click Drill-down ထည့်နည်း

\`\`\`html
<div class="kpi-card critical" onclick="showDetail('alerts')">
  ...
</div>
\`\`\`

\`\`\`javascript
function showDetail(type) {
  // Modal ဖွင့် သို့မဟုတ် page ပြောင်း
  window.location.href = \`/detail/\${type}\`;
}
\`\`\`

### 9.4 Filter Bar ထည့်နည်း

\`\`\`html
<div class="filter-bar">
  <select id="categoryFilter">
    <option value="">All Categories</option>
    <option value="laptop">Laptop</option>
    <option value="desktop">Desktop</option>
  </select>
  <input type="text" id="searchInput" placeholder="Search assets...">
</div>
\`\`\`

\`\`\`javascript
document.getElementById('categoryFilter').addEventListener('change', (e) => {
  filterTable({ category: e.target.value });
});
\`\`\`

---

## 10. Backend Integration

### 10.1 REST API Design

\`\`\`
GET    /api/assets              → List all assets
GET    /api/assets/:id          → Single asset
POST   /api/assets              → Create asset
PUT    /api/assets/:id          → Update asset
DELETE /api/assets/:id          → Delete asset

GET    /api/stats/summary       → KPI data
GET    /api/stats/categories    → Chart data
GET    /api/alerts              → Active alerts
\`\`\`

### 10.2 API Wrapper

\`\`\`javascript
const API = {
  baseURL: '/api',
  
  async get(endpoint) {
    const res = await fetch(\`\${this.baseURL}\${endpoint}\`);
    if (!res.ok) throw new Error(\`API error: \${res.status}\`);
    return res.json();
  },
  
  async post(endpoint, data) {
    const res = await fetch(\`\${this.baseURL}\${endpoint}\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  }
};

// Usage
const stats = await API.get('/stats/summary');
\`\`\`

### 10.3 Loading State

\`\`\`javascript
async function loadDashboard() {
  showSkeleton(); // Skeleton loader ပြ
  try {
    const [stats, assets] = await Promise.all([
      API.get('/stats/summary'),
      API.get('/assets?limit=10')
    ]);
    renderStats(stats);
    renderTable(assets);
  } catch (err) {
    showError(err.message);
  } finally {
    hideSkeleton();
  }
}
\`\`\`

### 10.4 Sample Backend (Node.js + Express)

\`\`\`javascript
// server.js
const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/api/stats/summary', (req, res) => {
  res.json({
    totalAssets: 1248,
    active: 1105,
    maintenance: 87,
    warrantyExpiring: 56
  });
});

app.get('/api/assets', (req, res) => {
  res.json([
    { id: 'AST-001', name: 'Dell Latitude 5540', category: 'Laptop', status: 'Active' },
  ]);
});

app.listen(3000, () => console.log('Server running on port 3000'));
\`\`\`

---

## 11. Performance & Optimization

### 11.1 Checklist

| Item | လုပ်ဆောင်ချက် |
|------|-------------|
| ✅ | CSS variables သုံး (repetition လျော့) |
| ✅ | Chart \`update('none')\` သုံး (animation မလို) |
| ✅ | Event delegation သုံး |
| ✅ | Debounce resize |
| ✅ | Lazy load images |
| ✅ | Minify CSS/JS (production) |
| ✅ | CDN သုံး (Chart.js) |
| ✅ | DOM query cache |

### 11.2 DOM Query Cache

\`\`\`javascript
// ❌ Slow — loop ထဲ query
for (let i = 0; i < 100; i++) {
  document.querySelector('.item').style.color = 'red';
}

// ✅ Fast — cache
const items = document.querySelectorAll('.item');
items.forEach(item => item.style.color = 'red');
\`\`\`

### 11.3 CSS Performance

\`\`\`css
/* ✅ Transform/opacity = GPU accelerated */
.card:hover { transform: translateY(-3px); }

/* ❌ top/left = layout reflow */
.card:hover { top: -3px; }
\`\`\`

### 11.4 Bundle Size

| Asset | Size (gzip) |
|-------|-------------|
| HTML | ~15 KB |
| CSS | ~8 KB |
| JS (inline) | ~6 KB |
| Chart.js | ~60 KB |
| **Total** | **~89 KB** |

---

## 12. Accessibility

### 12.1 Checklist

| Item | လုပ်ဆောင်ချက် |
|------|-------------|
| ✅ | Semantic HTML (\`<header>\`, \`<nav>\`, \`<table>\`) |
| ✅ | \`aria-label\` on icon buttons |
| ✅ | \`title\` attribute on hover |
| ✅ | Keyboard navigable (Tab, Enter, Esc) |
| ✅ | Color contrast ≥ 4.5:1 |
| ✅ | Focus visible outline |
| ✅ | \`alt\` on images |

### 12.2 Keyboard Support

\`\`\`javascript
// Esc နဲ့ menu ပိတ်
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    colorMenu.classList.remove('open');
  }
});
\`\`\`

### 12.3 ARIA Example

\`\`\`html
<button 
  class="icon-btn theme-toggle" 
  id="themeToggle"
  aria-label="Toggle dark mode"
  aria-pressed="false"
  title="Toggle theme">
  🌙
</button>
\`\`\`

\`\`\`javascript
function applyTheme(theme) {
  htmlEl.setAttribute('data-theme', theme);
  themeToggle.setAttribute('aria-pressed', theme === 'dark');
}
\`\`\`

### 12.4 Color Contrast

Dark mode မှာ text color ကို \`#f1f5f9\` (slate-100) သုံးပြီး background \`#0f172a\` (slate-900) နဲ့ contrast 15:1 ရှိသည်။ ✅

---

## 13. Testing

### 13.1 Manual Test Checklist

| Test | Expected |
|------|----------|
| Theme toggle | 🌙/☀️ ပြောင်း၊ localStorage သိမ်း |
| Accent picker | ၆ ရောင် ရွေး၊ header gradient ပြောင်း |
| Tab switch | Content ပြောင်း၊ chart resize |
| Reload page | Theme + accent မှတ်ထား |
| Mobile view | Grid 1 column ဖြစ် |
| Chart hover | Tooltip ပြ |

### 13.2 Automated Testing (Optional)

\`\`\`javascript
// Vitest / Jest
import { describe, it, expect } from 'vitest';

describe('Theme Module', () => {
  it('should default to light theme', () => {
    expect(ThemeModule.get()).toBe('light');
  });
  
  it('should toggle to dark', () => {
    ThemeModule.toggle();
    expect(ThemeModule.get()).toBe('dark');
  });
});
\`\`\`

### 13.3 Cross-browser Test

| Browser | Version |
|---------|---------|
| Chrome | ≥ 90 |
| Firefox | ≥ 88 |
| Safari | ≥ 14 |
| Edge | ≥ 90 |

---

## 14. Deployment

### 14.1 Static Hosting

| Platform | Command |
|----------|---------|
| **Netlify** | Drag & drop \`index.html\` |
| **Vercel** | \`vercel deploy\` |
| **GitHub Pages** | Push to \`gh-pages\` branch |
| **Cloudflare Pages** | Connect Git repo |

### 14.2 Production Checklist

- [ ] CSS/JS minify
- [ ] Remove \`console.log\`
- [ ] Compress images
- [ ] Enable gzip/brotli
- [ ] Set cache headers
- [ ] HTTPS only
- [ ] Add favicon
- [ ] Add meta description
- [ ] Test on mobile

### 14.3 Environment Config

\`\`\`javascript
// config.js
const CONFIG = {
  API_URL: window.location.hostname === 'localhost' 
    ? 'http://localhost:3000/api' 
    : 'https://api.example.com/api',
  VERSION: '1.0.0'
};
\`\`\`

---

## 15. Troubleshooting

### 15.1 Common Issues

| ပြဿနာ | အကြောင်းရင်း | ဖြေရှင်းချက် |
|--------|-------------|-------------|
| Chart မပြ | Container height မရှိ | \`height: 240px\` ထည့် |
| Theme မပြောင်း | CSS var apply မဖြစ် | \`[data-theme="dark"]\` selector စစ် |
| Chart color မပြောင်း | \`updateAllCharts()\` မခေါ် | \`applyTheme()\` ထဲ ခေါ် |
| localStorage မသိမ်း | Private mode | Normal mode သုံး |
| Mobile layout ပျက် | Viewport meta မရှိ | \`<meta name="viewport">\` ထည့် |
| Color picker မပိတ် | \`stopPropagation\` မရှိ | \`e.stopPropagation()\` ထည့် |

### 15.2 Debug Tips

\`\`\`javascript
// State ကို log
console.log('Current theme:', localStorage.getItem('theme'));
console.log('Current accent:', localStorage.getItem('accent'));

// CSS variable ဖတ်
const accent = getComputedStyle(document.documentElement)
  .getPropertyValue('--accent');
console.log('Computed accent:', accent);
\`\`\`

### 15.3 Reset to Default

\`\`\`javascript
// Console မှာ run
localStorage.removeItem('theme');
localStorage.removeItem('accent');
location.reload();
\`\`\`

---

## 📚 Appendix

### A. CSS Variables Reference

| Variable | Light | Dark |
|----------|-------|------|
| \`--bg-body\` | \`#f5f7fa\` | \`#0f172a\` |
| \`--bg-card\` | \`#ffffff\` | \`#1e293b\` |
| \`--text-primary\` | \`#111827\` | \`#f1f5f9\` |
| \`--text-muted\` | \`#6b7280\` | \`#94a3b8\` |
| \`--accent\` | (dynamic) | (dynamic) |

### B. Keyboard Shortcuts (Recommended)

| Key | Action |
|-----|--------|
| \`T\` | Toggle theme |
| \`C\` | Open color picker |
| \`1-4\` | Switch tab |
| \`Esc\` | Close menu |

### C. Resources

- [Chart.js Docs](https://www.chartjs.org/docs/)
- [MDN CSS Variables](https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties)
- [Web Content Accessibility Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [Can I Use](https://caniuse.com/)

### D. Glossary

| Term | အဓိပ္ပာယ် |
|------|----------|
| **Asset** | IT ပစ္စည်း (laptop, server, etc.) |
| **KPI** | Key Performance Indicator |
| **EOL** | End of Life |
| **YTD** | Year to Date |
| **Drill-down** | Summary → Detail ကြည့်ခြင်း |
| **Theme** | Light/Dark mode |
| **Accent** | အဓိကအရောင် |

---

## 🎯 Quick Start Guide

\`\`\`bash
# 1. Clone / download
git clone <repo-url>
cd it-asset-dashboard

# 2. Open in browser
open index.html

# 3. Or run local server
python -m http.server 8000# → http://localhost:8000
\`\`\`

**Developer အနေနဲ့ ပထမဆုံး လုပ်ရမည့်အရာ:**

1. Section 4 (Core Concepts) ဖတ်
2. Section 5 (CSS Variables) နားလည်
3. Section 6 (Theme & Accent) လေ့လာ
4. Section 9 (Adding Features) နဲ့ စမ်း

---

**End of Document**

_Generated for IT Asset Management Dashboard v1.0.0_
`;

function downloadGuide() {
  const blob = new Blob([GUIDE_CONTENT], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'DashboardDesign_development.md';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const status = document.getElementById('status');
  status.classList.add('show');
  setTimeout(() => status.classList.remove('show'), 3000);
}
</script>
</body>
</html>