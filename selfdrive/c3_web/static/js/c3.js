/**
 * C3 Web — 设备管理前端
 * 纯 vanilla JS SPA，零外部依赖
 */
(function () {
  'use strict';

  // ============================================================
  // Helpers
  // ============================================================

  /** Escape text for safe HTML insertion */
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** URL-encode a single path segment */
  function encSeg(s) {
    return encodeURIComponent(String(s));
  }

  /** Safe deep property access with default */
  function get(obj, path, def) {
    if (obj == null) return def;
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object') return def;
      cur = cur[parts[i]];
    }
    return cur != null ? cur : def;
  }

  /** Format bytes to human-readable */
  function fmtBytes(b) {
    if (b == null || isNaN(b)) return '--';
    b = Number(b);
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }

  /** Format seconds to mm:ss or hh:mm:ss */
  function fmtDuration(sec) {
    if (sec == null || isNaN(sec)) return '--';
    sec = Math.round(Number(sec));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }

  /** Format a route name for display: strip dongle prefix if present */
  function fmtRouteName(name) {
    if (!name) return '--';
    var parts = name.split('|');
    return esc(parts.length > 1 ? parts.slice(1).join('|') : name);
  }

  /** Extract display date from route id (e.g. "dongleid|2025-01-15--08-30-00" → "2025-01-15 08:30:00") */
  function routeDate(id) {
    if (!id) return '';
    var afterPipe = id.split('|').pop();
    var match = afterPipe.match(/^(\d{4})-(\d{2})-(\d{2})--(\d{2})-(\d{2})-(\d{2})$/);
    if (match) return match[1] + '-' + match[2] + '-' + match[3] + ' ' + match[4] + ':' + match[5] + ':' + match[6];
    return afterPipe;
  }

  /** Format timestamp (epoch or ISO string) */
  function fmtMtime(v) {
    if (v == null) return '';
    var d = new Date(v * 1000);
    if (isNaN(d.getTime())) { d = new Date(v); }
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // ============================================================
  // API Layer
  // ============================================================

  var API_BASE = '';

  function apiFetch(path) {
    return fetch(API_BASE + path).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function fetchStatus() {
    return apiFetch('/api/status').catch(function (e) { return { _error: e.message }; });
  }

  function fetchRoutes() {
    return apiFetch('/api/routes').then(function (data) {
      // Tolerate {routes:[...]} or bare array
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.routes)) return data.routes;
      return [];
    }).catch(function (e) { return { _error: e.message }; });
  }

  function fetchRouteDetail(route) {
    return apiFetch('/api/routes/' + encSeg(route)).catch(function (e) { return { _error: e.message }; });
  }

  function fileUrl(route, segment, filename) {
    return API_BASE + '/api/file/' + encSeg(route) + '/' + encSeg(segment) + '/' + encSeg(filename);
  }

  function previewEndpoint(route, segment) {
    return API_BASE + '/api/preview/' + encSeg(route) + '/' + encSeg(segment);
  }

  function fetchHealth() {
    return fetch(API_BASE + '/health').then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  // ============================================================
  // Toast
  // ============================================================

  var toastContainer = document.getElementById('toast-container');
  var TOAST_SVG = {
    err:  '<svg viewBox="0 0 16 16" fill="none" stroke="var(--err)" stroke-width="1.5" stroke-linecap="round" width="14" height="14"><circle cx="8" cy="8" r="6"/><line x1="5.5" y1="5.5" x2="10.5" y2="10.5"/><line x1="10.5" y1="5.5" x2="5.5" y2="10.5"/></svg>',
    warn: '<svg viewBox="0 0 16 16" fill="none" stroke="var(--warn)" stroke-width="1.5" stroke-linecap="round" width="14" height="14"><path d="M8 2L1.5 13h13z"/><line x1="8" y1="6" x2="8" y2="9"/><circle cx="8" cy="11" r="0.5" fill="var(--warn)"/></svg>',
    ok:   '<svg viewBox="0 0 16 16" fill="none" stroke="var(--ok)" stroke-width="1.5" stroke-linecap="round" width="14" height="14"><circle cx="8" cy="8" r="6"/><path d="M5 8l2 2 4-4"/></svg>',
    info: '<svg viewBox="0 0 16 16" fill="none" stroke="var(--info)" stroke-width="1.5" stroke-linecap="round" width="14" height="14"><circle cx="8" cy="8" r="6"/><line x1="8" y1="7" x2="8" y2="11.5"/><circle cx="8" cy="5" r="0.5" fill="var(--info)"/></svg>'
  };

  function toast(msg, type) {
    type = type || 'info';
    var el = document.createElement('div');
    el.className = 'c3-toast c3-toast--' + type;
    el.innerHTML = (TOAST_SVG[type] || '') + '<span>' + esc(msg) + '</span>';
    toastContainer.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s ease';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }, 4000);
  }

  // ============================================================
  // State
  // ============================================================

  var state = {
    currentView: 'home',
    statusData: null,
    routesList: null,
    selectedRoute: null,
    liveConnected: false,
    healthOk: false,
    expandedSegments: {}
  };

  // ============================================================
  // DOM refs
  // ============================================================

  var $id = function (id) { return document.getElementById(id); };

  var statusDot = $id('status-dot');
  var statusText = $id('status-text');
  var statusGrid = $id('status-grid');
  var routesContent = $id('routes-content');

  var camRoadImg = $id('cam-road-img');
  var camRoadPlaceholder = $id('cam-road-placeholder');
  var camRoadIndicator = $id('cam-road-indicator');
  var camRoadStatus = $id('cam-road-status');

  var camDriverImg = $id('cam-driver-img');
  var camDriverPlaceholder = $id('cam-driver-placeholder');
  var camDriverIndicator = $id('cam-driver-indicator');
  var camDriverStatus = $id('cam-driver-status');

  var btnConnect = $id('btn-live-connect');
  var btnDisconnect = $id('btn-live-disconnect');

  // ============================================================
  // Navigation
  // ============================================================

  var navTabs = document.querySelectorAll('.c3-nav__tab');
  var views = document.querySelectorAll('.c3-view');

  function switchView(name) {
    // Disconnect live when navigating away
    if (state.currentView === 'live' && name !== 'live') {
      liveDisconnect();
    }
    state.currentView = name;

    navTabs.forEach(function (tab) {
      var active = tab.getAttribute('data-view') === name;
      tab.classList.toggle('c3-nav__tab--active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    views.forEach(function (v) {
      v.classList.toggle('c3-view--active', v.id === 'view-' + name);
    });

    // Lazy-load
    if (name === 'home') loadStatus();
    if (name === 'routes' && !state.selectedRoute) loadRoutes();
  }

  navTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      switchView(tab.getAttribute('data-view'));
    });
  });

  // ============================================================
  // Health check
  // ============================================================

  function updateHealth(ok) {
    state.healthOk = ok;
    statusDot.className = 'c3-header__dot' + (ok ? ' c3-header__dot--ok' : ' c3-header__dot--err');
    statusText.textContent = ok ? '已连接' : '离线';
  }

  function checkHealth() {
    fetchHealth().then(updateHealth);
  }

  // ============================================================
  // Home / Status View
  // ============================================================

  function renderStatus(data) {
    if (!data || data._error) {
      statusGrid.innerHTML =
        '<div class="c3-state">' +
          SVG_CIRCLE_WARN +
          '<div class="c3-state__title">无法获取设备状态</div>' +
          '<div class="c3-state__desc">' + esc(data && data._error ? data._error : '设备可能离线或服务未启动') + '</div>' +
        '</div>';
      return;
    }

    var html = '';

    // Device info — handle both flat and nested shapes defensively
    var deviceKv = kvRow('设备类型', get(data, 'device_type', null) || get(data, 'deviceType', null));
    deviceKv += kvRow('序列号', get(data, 'serial', null));
    deviceKv += kvRow('Dongle ID', get(data, 'dongle_id', null));
    deviceKv += kvRow('版本', get(data, 'version', null));
    deviceKv += kvRow('Git 分支', get(data, 'git_branch', null) || get(data, 'gitBranch', null));
    var started = get(data, 'started', null);
    if (started != null) deviceKv += kvRow('启动状态', started ? '行驶中' : '停车', started ? 'ok' : 'warn');
    deviceKv += kvRow('录像数量', get(data, 'routes', null));

    if (deviceKv) {
      html += statusCard('chip', '设备信息', deviceKv);
    }

    // Thermal / system fields
    var sysKv = '';
    sysKv += kvRowHTML('CPU 温度', fmtTempList(get(data, 'cpuTempC', null)));
    sysKv += kvRowHTML('GPU 温度', fmtTemp(get(data, 'gpuTempC', null)));
    sysKv += kvRowHTML('最高温度', fmtTemp(get(data, 'maxTempC', null)));
    sysKv += kvRowHTML('内存温度', fmtTemp(get(data, 'memoryTempC', null)));
    sysKv += kvRowHTML('CPU 使用率', fmtPercentList(get(data, 'cpuUsagePercent', null)));
    sysKv += kvRowHTML('GPU 使用率', fmtPercent(get(data, 'gpuUsagePercent', null)));
    sysKv += kvRowHTML('内存使用率', fmtPercent(get(data, 'memoryUsagePercent', null)));
    sysKv += kvRowHTML('可用空间', fmtPercent(get(data, 'freeSpacePercent', null)));
    sysKv += kvRowHTML('功耗', fmtPower(get(data, 'powerDrawW', null)));
    sysKv += kvRowHTML('风扇转速', fmtPercent(get(data, 'fanSpeedPercentDesired', null)));
    sysKv += kvRowHTML('屏幕亮度', fmtPercent(get(data, 'screenBrightnessPercent', null)));
    sysKv += kvRow('热状态', get(data, 'thermalStatus', null));

    if (sysKv) {
      html += statusCard('clock', '系统状态', sysKv);
    }

    // Storage
    var storageKv = '';
    storageKv += kvRow('总空间', fmtBytes(get(data, 'total_space', null) || get(data, 'totalSpace', null)));
    storageKv += kvRow('已用空间', fmtBytes(get(data, 'used_space', null) || get(data, 'usedSpace', null)));
    storageKv += kvRow('可用空间', fmtBytes(get(data, 'free_space', null) || get(data, 'freeSpace', null)));
    storageKv += kvRowHTML('使用率', fmtPercent(get(data, 'space_used_percent', null) || get(data, 'spaceUsedPercent', null)));

    if (storageKv) {
      html += statusCard('storage', '存储', storageKv);
    }

    // Network
    var netKv = '';
    netKv += kvRow('网络类型', get(data, 'networkType', null));
    netKv += kvRow('信号强度', get(data, 'networkStrength', null));

    if (netKv) {
      html += statusCard('wifi', '网络', netKv);
    }

    // Car state (nested, if present)
    var cs = get(data, 'carState', null);
    if (cs && typeof cs === 'object') {
      var carKv = '';
      carKv += kvRowHTML('车速', fmtSpeed(get(cs, 'vEgo', null)));
      carKv += kvRowHTML('巡航速度', fmtSpeed(get(cs, 'vCruise', null)));
      carKv += kvRowHTML('方向盘角度', fmtDeg(get(cs, 'steeringAngleDeg', null)));
      var gas = get(cs, 'gasPressed', null);
      if (gas != null) carKv += kvRow('油门', gas ? '踩下' : '松开');
      var brake = get(cs, 'brakePressed', null);
      if (brake != null) carKv += kvRow('刹车', brake ? '踩下' : '松开');
      carKv += kvRow('档位', get(cs, 'gearShifter', null));
      var blinkers = formatBlinkers(get(cs, 'leftBlinker', false), get(cs, 'rightBlinker', false));
      if (blinkers) carKv += kvRow('转向灯', blinkers);
      carKv += kvRow('驻车', get(cs, 'standstill', null) != null ? (get(cs, 'standstill') ? '是' : '否') : null);

      if (carKv) {
        html += statusCard('car', '车辆状态', carKv, true);
      }
    }

    if (!html) {
      html = '<div class="c3-state">' + SVG_CIRCLE_WARN +
        '<div class="c3-state__title">状态数据为空</div>' +
        '<div class="c3-state__desc">后端返回了数据但未包含可识别字段</div></div>';
    }

    statusGrid.innerHTML = html;
  }

  /** Build a single key-value row with plain text value */
  function kvRow(key, val, semantic) {
    if (val == null || val === '' || val === '--') return '';
    var cls = semantic === 'ok' ? ' c3-kv__val--ok' : semantic === 'warn' ? ' c3-kv__val--warn' : semantic === 'err' ? ' c3-kv__val--err' : '';
    return '<span class="c3-kv__key">' + esc(key) + '</span><span class="c3-kv__val' + cls + '">' + esc(val) + '</span>';
  }

  /** Build a single key-value row with pre-rendered HTML value */
  function kvRowHTML(key, htmlVal) {
    if (!htmlVal) return '';
    return '<span class="c3-kv__key">' + esc(key) + '</span><span class="c3-kv__val">' + htmlVal + '</span>';
  }

  /** Build a status card */
  function statusCard(icon, title, kvHtml, wide) {
    return '<div class="c3-status__card' + (wide ? ' c3-status__card--wide' : '') + ' c3-animate-in">' +
      '<div class="c3-status__card-title">' + cardIcon(icon) + ' ' + esc(title) + '</div>' +
      '<div class="c3-status__card-body"><div class="c3-kv">' + kvHtml + '</div></div></div>';
  }

  function cardIcon(name) {
    var icons = {
      chip: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="14" height="14"><rect x="3" y="3" width="10" height="10" rx="1.5"/><line x1="3" y1="6" x2="1" y2="6"/><line x1="3" y1="10" x2="1" y2="10"/><line x1="13" y1="6" x2="15" y2="6"/><line x1="13" y1="10" x2="15" y2="10"/><line x1="6" y1="3" x2="6" y2="1"/><line x1="10" y1="3" x2="10" y2="1"/><line x1="6" y1="13" x2="6" y2="15"/><line x1="10" y1="13" x2="10" y2="15"/></svg>',
      clock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="14" height="14"><circle cx="8" cy="8" r="6"/><path d="M8 4.5v4l2.5 1.5"/></svg>',
      storage: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="14" height="14"><rect x="2" y="4" width="12" height="8" rx="1"/><line x1="5" y1="8" x2="11" y2="8"/></svg>',
      wifi: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="14" height="14"><path d="M1.5 11a10 10 0 0 1 13 0"/><path d="M4 8.5a6 6 0 0 1 8 0"/><circle cx="8" cy="11" r="1"/></svg>',
      car: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="14" height="14"><path d="M2 10l2-5h8l2 5"/><rect x="1" y="10" width="14" height="3" rx="1"/><circle cx="4.5" cy="13" r="1"/><circle cx="11.5" cy="13" r="1"/></svg>'
    };
    return icons[name] || '';
  }

  // ---- Status formatting helpers ----

  function fmtTemp(v) {
    if (v == null || isNaN(v)) return '';
    var n = Number(v);
    var cls = n > 85 ? 'c3-kv__val--err' : n > 70 ? 'c3-kv__val--warn' : '';
    return '<span class="' + cls + '">' + n.toFixed(0) + '°C</span>';
  }

  function fmtTempList(arr) {
    if (!Array.isArray(arr) || !arr.length) return '';
    var items = arr.map(fmtTemp).filter(Boolean);
    return items.length ? items.join(' / ') : '';
  }

  function fmtPercent(v) {
    if (v == null || isNaN(v)) return '';
    return Number(v).toFixed(1) + '%';
  }

  function fmtPercentList(arr) {
    if (!Array.isArray(arr) || !arr.length) return '';
    var items = arr.map(fmtPercent).filter(Boolean);
    return items.length ? items.join(' / ') : '';
  }

  function fmtPower(v) {
    if (v == null || isNaN(v)) return '';
    return Number(v).toFixed(1) + ' W';
  }

  function fmtSpeed(v) {
    if (v == null || isNaN(v)) return '';
    return (Number(v) * 3.6).toFixed(1) + ' km/h';
  }

  function fmtDeg(v) {
    if (v == null || isNaN(v)) return '';
    return Number(v).toFixed(1) + '°';
  }

  function formatBlinkers(l, r) {
    if (!l && !r) return null;
    if (l && r) return '左+右';
    return l ? '左' : '右';
  }

  function loadStatus() {
    statusGrid.innerHTML = '<div class="c3-state"><div class="c3-spinner"></div><div class="c3-state__title">加载中…</div></div>';
    fetchStatus().then(function (data) {
      state.statusData = data;
      renderStatus(data);
    });
  }

  // ============================================================
  // Live View
  // ============================================================

  /** The backend serves proper MJPEG multipart streams. Browsers
      render these natively in <img> — just set src once and the
      browser keeps the connection open. To stop: clear src. */

  function liveConnect() {
    if (state.liveConnected) return;
    state.liveConnected = true;

    btnConnect.disabled = true;
    btnDisconnect.disabled = false;

    // Road
    camRoadPlaceholder.style.display = 'none';
    camRoadImg.classList.add('c3-cam__img--visible');
    camRoadIndicator.classList.add('c3-cam__indicator--live');
    camRoadStatus.textContent = '连接中';
    camRoadStatus.style.color = 'var(--warn)';
    camRoadImg.onload = function () {
      camRoadStatus.textContent = '接收中';
      camRoadStatus.style.color = 'var(--ok)';
    };
    camRoadImg.onerror = function () {
      camRoadStatus.textContent = '信号丢失';
      camRoadStatus.style.color = 'var(--err)';
    };
    camRoadImg.src = API_BASE + '/api/live/road';

    // Driver
    camDriverPlaceholder.style.display = 'none';
    camDriverImg.classList.add('c3-cam__img--visible');
    camDriverIndicator.classList.add('c3-cam__indicator--live');
    camDriverStatus.textContent = '连接中';
    camDriverStatus.style.color = 'var(--warn)';
    camDriverImg.onload = function () {
      camDriverStatus.textContent = '接收中';
      camDriverStatus.style.color = 'var(--ok)';
    };
    camDriverImg.onerror = function () {
      camDriverStatus.textContent = '信号丢失';
      camDriverStatus.style.color = 'var(--err)';
    };
    camDriverImg.src = API_BASE + '/api/live/driver';
  }

  function liveDisconnect() {
    if (!state.liveConnected) return;
    state.liveConnected = false;

    btnConnect.disabled = false;
    btnDisconnect.disabled = true;

    // Road — clearing src terminates the MJPEG fetch
    camRoadImg.onload = null;
    camRoadImg.onerror = null;
    camRoadImg.classList.remove('c3-cam__img--visible');
    camRoadImg.removeAttribute('src');
    camRoadImg.src = '';
    camRoadPlaceholder.style.display = '';
    camRoadIndicator.classList.remove('c3-cam__indicator--live');
    camRoadStatus.textContent = '';

    // Driver
    camDriverImg.onload = null;
    camDriverImg.onerror = null;
    camDriverImg.classList.remove('c3-cam__img--visible');
    camDriverImg.removeAttribute('src');
    camDriverImg.src = '';
    camDriverPlaceholder.style.display = '';
    camDriverIndicator.classList.remove('c3-cam__indicator--live');
    camDriverStatus.textContent = '';
  }

  btnConnect.addEventListener('click', liveConnect);
  btnDisconnect.addEventListener('click', liveDisconnect);

  // ============================================================
  // Routes View
  // ============================================================

  // Inline SVG icon strings (reused across views)
  var SVG_FOLDER = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M2 4a1 1 0 0 1 1-1h3l1.5 2H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>';
  var SVG_ARROW = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="14" height="14"><path d="M6 3l5 5-5 5"/></svg>';
  var SVG_BACK  = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="14" height="14"><path d="M10 3L5 8l5 5"/></svg>';
  var SVG_CHEV  = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M6 4l4 4-4 4"/></svg>';
  var SVG_DL    = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M8 2v8m0 0l-3-3m3 3l3-3"/><path d="M2 12v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1"/></svg>';
  var SVG_EMPTY = '<svg class="c3-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>';
  var SVG_OFF   = '<svg class="c3-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 1l22 22"/><circle cx="12" cy="12" r="10"/></svg>';
  var SVG_CIRCLE_WARN = '<svg class="c3-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

  function renderRoutesList(routes) {
    if (routes._error) {
      routesContent.innerHTML =
        '<div class="c3-state">' + SVG_OFF +
        '<div class="c3-state__title">无法获取录像列表</div>' +
        '<div class="c3-state__desc">' + esc(routes._error) + '</div>' +
        '<button class="c3-btn c3-btn--ghost c3-mt-3" type="button" id="btn-retry-routes">重试</button></div>';
      var retryBtn = $id('btn-retry-routes');
      if (retryBtn) retryBtn.addEventListener('click', loadRoutes);
      return;
    }

    if (!routes.length) {
      routesContent.innerHTML =
        '<div class="c3-state">' + SVG_EMPTY +
        '<div class="c3-state__title">暂无录像</div>' +
        '<div class="c3-state__desc">设备上没有已录制的行为数据</div></div>';
      return;
    }

    var html = '<div class="c3-routes__header">' +
      '<span class="c3-routes__title">共 ' + routes.length + ' 条录像</span>' +
      '<button class="c3-btn c3-btn--ghost c3-btn--small" type="button" id="btn-refresh-routes">刷新</button></div>' +
      '<div class="c3-route-list">';

    routes.forEach(function (route, i) {
      // Backend: {id, segments, mtime, size, active}
      var rid = get(route, 'id', '');
      var segCount = get(route, 'segments', null);
      var mtime = get(route, 'mtime', null);
      var size = get(route, 'size', null);
      var active = get(route, 'active', false);

      var dateStr = routeDate(rid) || fmtMtime(mtime);
      var sizeStr = fmtBytes(size);

      var metaParts = [];
      if (dateStr) metaParts.push('<span>' + esc(dateStr) + '</span>');
      if (segCount != null) metaParts.push('<span>' + esc(segCount) + ' 段</span>');
      if (sizeStr !== '--') metaParts.push('<span>' + sizeStr + '</span>');
      if (active) metaParts.push('<span style="color:var(--ok)">录制中</span>');

      html += '<div class="c3-route-item c3-animate-in" data-route="' + esc(rid) + '" role="button" tabindex="0" style="animation-delay:' + Math.min(i * 40, 300) + 'ms">' +
        '<div class="c3-route-item__icon' + (active ? '" style="color:var(--ok)' : '') + '">' + SVG_FOLDER + '</div>' +
        '<div class="c3-route-item__info">' +
          '<div class="c3-route-item__name">' + fmtRouteName(rid) + '</div>' +
          '<div class="c3-route-item__meta">' + metaParts.join('') + '</div>' +
        '</div>' +
        '<div class="c3-route-item__arrow">' + SVG_ARROW + '</div>' +
      '</div>';
    });

    html += '</div>';
    routesContent.innerHTML = html;

    // Bind refresh
    $id('btn-refresh-routes').addEventListener('click', loadRoutes);

    // Bind route items
    document.querySelectorAll('.c3-route-item').forEach(function (el) {
      function openRoute() {
        var rid = el.getAttribute('data-route');
        if (rid) openRouteDetail(rid);
      }
      el.addEventListener('click', openRoute);
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRoute(); }
      });
    });
  }

  function loadRoutes() {
    state.selectedRoute = null;
    routesContent.innerHTML = '<div class="c3-state"><div class="c3-spinner"></div><div class="c3-state__title">加载录像列表…</div></div>';
    fetchRoutes().then(function (routes) {
      state.routesList = routes;
      renderRoutesList(routes);
    });
  }

  // ============================================================
  // Route Detail
  // ============================================================

  function openRouteDetail(routeName) {
    state.selectedRoute = routeName;
    routesContent.innerHTML = '<div class="c3-state"><div class="c3-spinner"></div><div class="c3-state__title">加载录像详情…</div></div>';

    fetchRouteDetail(routeName).then(function (data) {
      renderRouteDetail(routeName, data);
    });
  }

  function renderRouteDetail(routeName, data) {
    if (!data || data._error) {
      routesContent.innerHTML =
        '<div class="c3-detail">' +
          '<button class="c3-btn c3-btn--ghost c3-detail__back" type="button" id="btn-back-routes">' + SVG_BACK + ' 返回列表</button>' +
          '<div class="c3-state">' + SVG_OFF +
            '<div class="c3-state__title">无法加载录像详情</div>' +
            '<div class="c3-state__desc">' + esc(data && data._error ? data._error : '请求失败') + '</div>' +
          '</div>' +
        '</div>';
      bindBackButton();
      return;
    }

    // Backend: {id, segments: [{id, files, cameras, size, mtime, active}], segment_count, mtime, size, active}
    var segments = get(data, 'segments', []);
    if (!Array.isArray(segments)) segments = [];
    var routeSize = get(data, 'size', null);
    var routeActive = get(data, 'active', false);

    var html = '<div class="c3-detail">' +
      '<button class="c3-btn c3-btn--ghost c3-detail__back" type="button" id="btn-back-routes">' + SVG_BACK + ' 返回列表</button>' +
      '<div class="c3-detail__title">' + fmtRouteName(routeName) +
        (routeActive ? ' <span style="color:var(--ok);font-size:0.75rem;font-weight:500">录制中</span>' : '') +
      '</div>';

    // Route-level summary
    var summaryParts = [];
    summaryParts.push(segments.length + ' 段');
    if (routeSize != null) summaryParts.push(fmtBytes(routeSize));
    html += '<div style="font-size:0.8125rem;color:var(--fg-dim);margin-bottom:var(--s3)">' + esc(summaryParts.join(' · ')) + '</div>';

    if (segments.length === 0) {
      html += '<div class="c3-state">' + SVG_EMPTY +
        '<div class="c3-state__title">无分段数据</div></div>';
    } else {
      html += '<div class="c3-segment-list">';

      segments.forEach(function (seg, idx) {
        // Backend segment: {id, files: [{name, size}], cameras: [...], size, mtime, active}
        var segId = get(seg, 'id', idx);
        var segSize = get(seg, 'size', null);
        var segActive = get(seg, 'active', false);
        var files = get(seg, 'files', []);
        if (!Array.isArray(files)) files = [];
        var cameras = get(seg, 'cameras', []);
        var hasQcamera = cameras.indexOf('qcamera.ts') !== -1 || files.some(function (f) { return /qcamera\.ts$/i.test(get(f, 'name', '')); });

        var isExpanded = state.expandedSegments[routeName + ':' + segId];

        var infoParts = [];
        if (segSize != null) infoParts.push('<span class="c3-segment__info-item">' + fmtBytes(segSize) + '</span>');
        infoParts.push('<span class="c3-segment__info-item">' + files.length + ' 文件</span>');
        if (segActive) infoParts.push('<span class="c3-segment__info-item" style="color:var(--ok)">录制中</span>');

        html += '<div class="c3-segment c3-animate-in" data-seg="' + esc(segId) + '" style="animation-delay:' + Math.min(idx * 50, 300) + 'ms">' +
          '<div class="c3-segment__header" role="button" tabindex="0" aria-expanded="' + (isExpanded ? 'true' : 'false') + '">' +
            '<span class="c3-segment__num">' + esc(segId) + '</span>' +
            '<span class="c3-segment__info">' + infoParts.join('') + '</span>' +
            '<span class="c3-segment__toggle' + (isExpanded ? ' c3-segment__toggle--open' : '') + '">' + SVG_CHEV + '</span>' +
          '</div>' +
          '<div class="c3-segment__body' + (isExpanded ? ' c3-segment__body--open' : '') + '">';

        // Preview — only show if qcamera.ts exists
        if (hasQcamera) {
          var previewUrl = previewEndpoint(routeName, segId);
          html += '<div class="c3-preview">' +
            '<video class="c3-preview__video" controls preload="metadata" src="' + esc(previewUrl) + '">浏览器不支持视频播放</video>' +
            '<div class="c3-preview__label">qcamera.ts 预览</div>' +
          '</div>';
        }

        // File list with camera-labelled badges
        if (files.length > 0) {
          html += '<div class="c3-files">';
          files.forEach(function (f) {
            var fname = get(f, 'name', '') || get(f, 'filename', '') || '';
            var fsize = get(f, 'size', null);
            var furl = fileUrl(routeName, segId, fname);

            var badge, badgeLabel;
            if (/fcamera\.hevc$/i.test(fname))       { badge = 'road';    badgeLabel = '路'; }
            else if (/dcamera\.hevc$/i.test(fname))   { badge = 'driver'; badgeLabel = '驾'; }
            else if (/ecamera\.hevc$/i.test(fname))   { badge = 'wide';   badgeLabel = '广'; }
            else if (/qcamera\.ts$/i.test(fname))     { badge = 'preview'; badgeLabel = '预'; }
            else                                       { badge = 'preview'; badgeLabel = '?'; }

            html += '<div class="c3-file">' +
              '<div class="c3-file__icon c3-file__icon--' + badge + '">' + badgeLabel + '</div>' +
              '<div class="c3-file__info">' +
                '<div class="c3-file__name">' + esc(fname) + '</div>' +
                '<div class="c3-file__meta">' + (fsize != null ? fmtBytes(fsize) : '') + '</div>' +
              '</div>' +
              '<div class="c3-file__actions">' +
                '<a class="c3-btn c3-btn--ghost c3-btn--small" href="' + esc(furl) + '" download="' + esc(fname) + '" title="下载 ' + esc(fname) + '">' + SVG_DL + ' 下载</a>' +
              '</div>' +
            '</div>';
          });
          html += '</div>';
        } else {
          html += '<div style="font-size:0.8rem;color:var(--fg-muted);padding:var(--s2)">无文件</div>';
        }

        html += '</div></div>'; // body + segment
      });

      html += '</div>'; // segment-list
    }

    html += '</div>'; // detail
    routesContent.innerHTML = html;

    bindBackButton();

    // Segment expand/collapse
    document.querySelectorAll('.c3-segment__header').forEach(function (header) {
      function toggle() {
        var seg = header.closest('.c3-segment');
        var body = seg.querySelector('.c3-segment__body');
        var chevron = seg.querySelector('.c3-segment__toggle');
        var segId = seg.getAttribute('data-seg');
        var key = routeName + ':' + segId;
        var isOpen = body.classList.contains('c3-segment__body--open');

        body.classList.toggle('c3-segment__body--open', !isOpen);
        chevron.classList.toggle('c3-segment__toggle--open', !isOpen);
        header.setAttribute('aria-expanded', !isOpen ? 'true' : 'false');
        state.expandedSegments[key] = !isOpen;
      }
      header.addEventListener('click', toggle);
      header.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
  }

  function bindBackButton() {
    var btn = $id('btn-back-routes');
    if (btn) {
      btn.addEventListener('click', function () {
        state.selectedRoute = null;
        // Stop any playing video
        document.querySelectorAll('.c3-preview__video').forEach(function (v) { v.pause(); v.removeAttribute('src'); v.load(); });
        loadRoutes();
      });
    }
  }

  // ============================================================
  // Page lifecycle
  // ============================================================

  // Stop live streams on page unload
  window.addEventListener('beforeunload', liveDisconnect);

  // Pause MJPEG when tab is hidden, resume when visible
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.liveConnected) {
      // Clear src to stop the MJPEG fetch
      camRoadImg.removeAttribute('src');
      camDriverImg.removeAttribute('src');
    } else if (!document.hidden && state.liveConnected) {
      // Reconnect
      camRoadImg.src = API_BASE + '/api/live/road';
      camDriverImg.src = API_BASE + '/api/live/driver';
    }
  });

  // ============================================================
  // Init
  // ============================================================

  function init() {
    checkHealth();
    setInterval(checkHealth, 15000);
    loadStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
