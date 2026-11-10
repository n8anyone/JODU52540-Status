'use strict';
'require view';
'require poll';
'require fs';

/* ---------------------------------------------------------------
 * luci-app-jodu52540-status
 * Jio ODU 52540 — 5G NR Dashboard for OpenWrt / LuCI
 * API: POST https://192.168.225.1/cgi-bin/QCMAP_HFCL_CGI_Interface
 *      Pages: GetNetworkStatus, GetNeighbourStatus
 * ---------------------------------------------------------------*/

var ODU_HOST   = 'https://192.168.225.1';
var ODU_CGI    = ODU_HOST + '/cgi-bin/QCMAP_HFCL_CGI_Interface';
var sessionToken = null;
var sessionId    = null;

var lastRx = -1;
var lastTx = -1;
var lastTime = 0;
var dataHistory = [];
try {
    dataHistory = JSON.parse(localStorage.getItem('odu_data_history') || '[]');
} catch(e) {}

/* ── helpers ─────────────────────────────────────────────────── */
function safeVal(v) {
    return (!v || v === 'NA' || v === '') ? '—' : v;
}

function mkId() {
    return String(Date.now()) + String(Math.floor(Math.random() * 100000));
}

function oduPost(page, param, p2, p3, p4, p5, p6) {
    var args = [];
    if (page === 'GetNetworkStatus') args = ['network'];
    else if (page === 'GetNeighbourStatus') args = ['neighbour'];
    else if (page === 'reboot') args = ['reboot'];
    else if (page === 'stats') args = ['stats'];
    else if (page === 'GetDeviceInfo') args = ['deviceinfo'];
    else if (page === 'temperature') args = ['temperature'];
    else if (page === 'sms') args = ['sms'];
    else if (page === 'qcmap') args = ['qcmap', param || 'QCMAP_CLI'];
    else if (page === 'get_config') args = ['get_config'];
    else if (page === 'set_config') args = ['set_config', param, p2, p3, p4, p5, p6];
    else args = ['utilization'];

    return fs.exec('/usr/libexec/odu-data.sh', args).then(function(res) {
        if (res.code === 0 && res.stdout) {
            try {
                return JSON.parse(res.stdout.trim());
            } catch(e) {
                return { raw: res.stdout.trim() };
            }
        }
        return { error: 'Execution failed', code: res.code };
    }).catch(function(err) {
        return { error: String(err) };
    });
}

/* ── signal quality algorithm (weighted) ─────────────────────── */
function calcSignalBars(rsrp, rsrq, snr) {
    rsrp = parseFloat(rsrp); rsrq = parseFloat(rsrq); snr = parseFloat(snr);
    if (isNaN(rsrp) && isNaN(rsrq)) return 0;

    var score = 0, wt = 0;

    /* RSRP scoring (dBm) */
    if (!isNaN(rsrp)) {
        var rs = rsrp >= -65 ? 5 : rsrp >= -75 ? 4 : rsrp >= -85 ? 3 : rsrp >= -95 ? 2 : rsrp >= -105 ? 1 : 0;
        score += rs * 0.5; wt += 0.5;
    }
    /* RSRQ scoring (dB) */
    if (!isNaN(rsrq)) {
        var rq = rsrq >= -6 ? 5 : rsrq >= -9 ? 4 : rsrq >= -12 ? 3 : rsrq >= -15 ? 2 : rsrq >= -20 ? 1 : 0;
        score += rq * 0.3; wt += 0.3;
    }
    /* SNR scoring (dB) */
    if (!isNaN(snr)) {
        var sn = snr >= 25 ? 5 : snr >= 15 ? 4 : snr >= 7 ? 3 : snr >= 0 ? 2 : 1;
        score += sn * 0.2; wt += 0.2;
    }

    return wt > 0 ? Math.round(score / wt) : 0;
}

function renderBars(bars, color) {
    color = color || '#22d3ee';
    var heights = [20, 35, 50, 65, 80];
    var svg = '<svg width="28" height="22" viewBox="0 0 28 22" fill="none" xmlns="http://www.w3.org/2000/svg">';
    for (var i = 0; i < 5; i++) {
        var h = heights[i];
        var x = i * 6;
        var y = 22 - h * 0.22;
        var bh = h * 0.22;
        var fill = i < bars ? color : 'rgba(255,255,255,0.15)';
        svg += '<rect x="' + x + '" y="' + y.toFixed(1) + '" width="4" height="' + bh.toFixed(1) + '" rx="1" fill="' + fill + '"/>';
    }
    svg += '</svg>';
    return svg;
}

/* ── colour helpers ──────────────────────────────────────────── */
function rsrpColor(v) {
    v = parseFloat(v);
    if (isNaN(v)) return '#94a3b8';
    if (v >= -75) return '#22c55e';
    if (v >= -85) return '#84cc16';
    if (v >= -95) return '#eab308';
    if (v >= -105) return '#f97316';
    return '#ef4444';
}

function snrColor(v) {
    v = parseFloat(v);
    if (isNaN(v)) return '#94a3b8';
    if (v >= 25) return '#22c55e';
    if (v >= 15) return '#84cc16';
    if (v >= 7)  return '#eab308';
    if (v >= 0)  return '#f97316';
    return '#ef4444';
}

function blerColor(v) {
    v = parseFloat(v);
    if (isNaN(v)) return '#94a3b8';
    if (v <= 2)   return '#22c55e';
    if (v <= 5)   return '#84cc16';
    if (v <= 10)  return '#eab308';
    if (v <= 20)  return '#f97316';
    return '#ef4444';
}

function tempColor(v) {
    v = parseFloat(v);
    if (isNaN(v)) return '#94a3b8';
    if (v < 55) return '#22c55e';
    if (v < 70) return '#eab308';
    if (v < 85) return '#f97316';
    return '#ef4444';
}

function sigStrColor(s) {
    var map = { 'Excellent': '#22c55e', 'Very Good': '#84cc16', 'Good': '#eab308', 'Fair': '#f97316', 'Poor': '#ef4444', 'No Signal': '#ef4444' };
    return map[s] || '#94a3b8';
}

function drawPieChart(value, color, maxVal) {
    var radius = 9;
    var circumference = 2 * Math.PI * radius;
    var max = maxVal || 100;
    var percent = Math.min(Math.max(value / max, 0), 1);
    var strokeDasharray = (percent * circumference) + ' ' + circumference;
    
    return '<svg width="24" height="24" viewBox="0 0 24 24" class="sa-graph" style="transform: rotate(-90deg);"><circle cx="12" cy="12" r="' + radius + '" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="4"/><circle cx="12" cy="12" r="' + radius + '" fill="none" stroke="' + color + '" stroke-width="4" stroke-dasharray="' + strokeDasharray + '" style="transition: stroke-dasharray 0.5s ease-in-out;"/></svg>';
}

/* ── row builder ── */
function row(label, id, unit, hasDot) {
    unit = unit ? '<span class="sa-unit">' + unit + '</span>' : '';
    var dot = hasDot ? '<span class="sa-val-dot" id="' + id + '-dot"></span>' : '';
    return '<tr class="sa-tr">' +
        '<td class="sa-td left">' + label + '</td>' +
        '<td class="sa-td right" style="display:flex; justify-content:flex-end; align-items:center;">' +
        '<span id="' + id + '-graph" style="margin-right:8px; display:flex; align-items:center;"></span>' +
        '<span>' + dot + '<span id="' + id + '">—</span>' + unit + '</span></td>' +
        '</tr>';
}

function set(id, val, color) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (color) {
        el.style.color = color;
        var dot = document.getElementById(id + '-dot');
        if (dot) dot.style.background = color;
    }
}

function setHTML(id, html) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

/* ── main update loop ─────────────────────────────────────────── */
function updateDashboard() {
    return Promise.all([
        oduPost('GetNetworkStatus'),
        oduPost('GetNeighbourStatus'),
        oduPost('GetDeviceUtilization1'),
        oduPost('stats'),
        oduPost('GetDeviceInfo'),
        oduPost('temperature')
    ]).then(function(results) {
        var d = results[0];
        var n = results[1];
        var u = results[2];
        var s = results[3];
        var info = results[4];
        var tempObj = results[5];

        /* ── header ── */
        set('ui-hostname', safeVal(d.hostname));
        set('ui-uptime',   safeVal(d.connection_duration));
        set('ui-conn-status', safeVal(d.connection_status),
            d.connection_status === 'Attached' ? '#22c55e' : '#ef4444');
        set('ui-rrc',      safeVal(d.rrc_state),
            d.rrc_state === 'Connected' ? '#22c55e' : '#f97316');

        /* ── top cards ── */
        var bars = calcSignalBars(d.ss_rsrp || d.rsrp, d.ss_rsrq || d.rsrq, d.ss_snr || d.snr);
        var sigColor = sigStrColor(d.signal_strength);
        setHTML('ui-bars', renderBars(bars, sigColor));
        set('ui-sig-str', safeVal(d.signal_strength), sigColor);
        set('ui-op-mode', safeVal(d.operating_mode));
        set('ui-op-band', safeVal(d.operating_band));
        set('ui-bandwidth', safeVal(d.bandwidth), '#60a5fa');
        set('ui-mimo',   safeVal(d.mimo_mode));

        /* ── primary cell metrics ── */
        set('ui-rsrp',  safeVal(d.ss_rsrp || d.rsrp),  rsrpColor(d.ss_rsrp || d.rsrp));
        set('ui-rsrq',  safeVal(d.ss_rsrq || d.rsrq));
        set('ui-snr',   safeVal(d.ss_snr  || d.snr),   snrColor(d.ss_snr || d.snr));
        set('ui-bler',  safeVal(d.bler),                blerColor(d.bler));
        set('ui-mod',   safeVal(d.modulation));
        set('ui-modul', safeVal(d.modulation_ul));

        /* ── cell info ── */
        set('ui-pci',     safeVal(d.pci));
        set('ui-earfcn',  safeVal(d.earfcn));
        set('ui-ecgi',    safeVal(d.ecgi));
        set('ui-plmn',    safeVal(d.plmn));
        set('ui-apn',     safeVal(d.default_apn));
        set('ui-operator',safeVal(d.operator_name));

        /* ── secondary cell ── */
        var scActive = (d.scell_operating_band && d.scell_operating_band !== 'NA');
        set('ui-sc-label', scActive ? 'Secondary Cell (CA Active)' : 'Secondary Cell (Carrier Aggregation)');
        set('ui-sc-band',  safeVal(d.scell_operating_band));
        set('ui-sc-mode',  safeVal(d.scell_operating_mode));
        set('ui-sc-bw',    safeVal(d.scell_bandwidth));
        set('ui-sc-mimo',  safeVal(d.scell_mimo_mode));
        set('ui-sc-pci',   safeVal(d.scell_pci));
        set('ui-sc-rsrp',  safeVal(d.scell_ss_rsrp), rsrpColor(d.scell_ss_rsrp));
        set('ui-sc-rsrq',  safeVal(d.scell_ss_rsrq));
        set('ui-sc-snr',   safeVal(d.scell_ss_snr),  snrColor(d.scell_ss_snr));
        set('ui-sc-bler',  safeVal(d.scell_bler),     blerColor(d.scell_bler));
        set('ui-sc-mod',   safeVal(d.scell_modulation));
        set('ui-sc-sigsz', safeVal(d.scell_signal_strength));

        /* ── neighbour cell ── */
        set('ui-nc-band',  safeVal(n.ncell_operating_band));
        set('ui-nc-mode',  safeVal(n.ncell_operating_mode));
        set('ui-nc-pci',   safeVal(n.ncell_pci));
        set('ui-nc-rsrp',  safeVal(n.ncell_ss_rsrp),  rsrpColor(n.ncell_ss_rsrp));
        set('ui-nc-rsrq',  safeVal(n.ncell_ss_rsrq));
        set('ui-nc-snr',   safeVal(n.ncell_ss_snr),   snrColor(n.ncell_ss_snr));
        set('ui-nc-sig',   safeVal(n.ncell_signal_strength), sigStrColor(n.ncell_signal_strength));

        /* ── system utilization ── */
        var cpu = parseFloat(u.cpu_usage) || 0;
        var mem = parseFloat(u.memory_usage) || 0;

        set('ui-cpu', safeVal(u.cpu_usage));
        setHTML('ui-cpu-graph', drawPieChart(cpu, '#eab308', 100));
        
        set('ui-mem', safeVal(u.memory_usage) !== '—' ? mem.toFixed(1) : '—');
        setHTML('ui-mem-graph', drawPieChart(mem, '#60a5fa', mem > 256 ? 512 : 256));
        
        set('ui-sys-uptime', safeVal(u.sys_uptime));

        /* ── data usage & speed ── */
        var curRx = parseInt(s.rx_bytes, 10);
        var curTx = parseInt(s.tx_bytes, 10);
        var curTime = Date.now();

        var rxSpeed = 0, txSpeed = 0;
        if (lastRx >= 0 && lastTime > 0) {
            var diffSecs = (curTime - lastTime) / 1000;
            if (diffSecs > 0) {
                rxSpeed = ((curRx - lastRx) * 8) / diffSecs;
                txSpeed = ((curTx - lastTx) * 8) / diffSecs;
            }
        }
        
        lastRx = curRx;
        lastTx = curTx;
        lastTime = curTime;

        function formatBytes(bytes) {
            if (isNaN(bytes) || bytes < 0) return '—';
            if (bytes < 1024) return bytes + ' B';
            else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
            else if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
            else return (bytes / 1073741824).toFixed(2) + ' GB';
        }

        function formatSpeed(bps) {
            if (isNaN(bps) || bps < 0) return '—';
            if (bps < 1000) return bps.toFixed(0) + ' bps';
            else if (bps < 1000000) return (bps / 1000).toFixed(1) + ' Kbps';
            else return (bps / 1000000).toFixed(1) + ' Mbps';
        }

        /* Update Local History */
        if (!isNaN(curRx) && !isNaN(curTx)) {
            dataHistory.push({ time: curTime, rx: curRx, tx: curTx });
            // Keep max 24 hours (24 * 60 * 6 = 8640 entries if polling every 10s. Let's keep array bounded to prevent bloat)
            var twentyFourHoursAgo = curTime - (24 * 60 * 60 * 1000);
            dataHistory = dataHistory.filter(function(h) { return h.time >= twentyFourHoursAgo; });
            try { localStorage.setItem('odu_data_history', JSON.stringify(dataHistory)); } catch(e) {}
        }

        function getUsageSince(minutes) {
            if (dataHistory.length === 0) return '—';
            var targetTime = curTime - (minutes * 60 * 1000);
            // Find closest entry after targetTime
            var startEntry = dataHistory[0];
            for (var i = 0; i < dataHistory.length; i++) {
                if (dataHistory[i].time >= targetTime) {
                    startEntry = dataHistory[i];
                    break;
                }
            }
            // If the startEntry is too recent (e.g. tracking just started), we'll only show what we have
            var usedRx = curRx - startEntry.rx;
            var usedTx = curTx - startEntry.tx;
            if (usedRx < 0 || usedTx < 0) return '—'; // Reboot detected
            return formatBytes(usedRx + usedTx);
        }

        set('ui-data-rx', formatBytes(curRx));
        set('ui-data-tx', formatBytes(curTx));
        set('ui-speed-rx', formatSpeed(rxSpeed));
        set('ui-speed-tx', formatSpeed(txSpeed));
        
        set('ui-data-5m', getUsageSince(5));
        set('ui-data-1h', getUsageSince(60));
        set('ui-data-5h', getUsageSince(300));
        set('ui-data-24h', getUsageSince(1440));

        /* ── Raw API dump ──
           Populate Device Info and Full Network Stats tables with
           every key-value the ODU actually returns.
           NOTE: uses a node reference passed in at call time */
        function dumpObj(obj, prefix) {
            var rows = '';
            var keys = Object.keys(obj || {}).sort();
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                var v = obj[k];
                if (v === null || v === undefined || v === '') v = '—';
                var label = (prefix ? prefix + '.' : '') + k;
                var valStr = String(v);
                /* Highlight non-dash values */
                var valStyle = (valStr === '—') ?
                    'color:#4b5563' :
                    'color:#f1f5f9;font-weight:600';
                rows += '<tr class="sa-tr">' +
                    '<td class="sa-td left" style="font-family:monospace;font-size:12px;word-break:break-all;color:#6366f1;">' + label + '</td>' +
                    '<td class="sa-td right" style="font-size:13px;word-break:break-all;' + valStyle + ';">' + valStr + '</td>' +
                    '</tr>';
            }
            return rows;
        }

        function fillDump(id, html) {
            /* Works on both attached (document) and detached (node) DOM */
            var el = document.getElementById(id);
            if (!el) el = node.querySelector('#' + id);
            if (el) el.innerHTML = html || '';
        }

        /* System Temperatures — format thermal zones */
        function isValidTemp(t) {
            var n = parseFloat(t);
            return !isNaN(n) && n > -50 && n < 150 && Math.abs(n - (-273.15)) > 1 && Math.abs(n - (-273)) > 1 && n !== 0;
        }

        function formatSensorName(name) {
            if (!name) return 'Thermal Sensor';
            var n = String(name).trim();
            if (n === 'cpu-thermal' || n === 'cpu') return 'CPU Temperature';
            if (n === 'soc-thermal' || n === 'soc') return 'SoC Temperature';
            if (n === 'wifi-thermal' || n === 'wifi') return 'Wi-Fi Chipset';
            return n.replace(/_/g, ' ').replace(/-/g, ' ');
        }

        var tempRows = '';
        if (tempObj) {
            if (Array.isArray(tempObj.zones) && tempObj.zones.length > 0) {
                tempObj.zones.forEach(function(z) {
                    if (!isValidTemp(z.temp)) return;
                    var label = formatSensorName(z.type || z.zone);
                    var val = parseFloat(z.temp).toFixed(1) + ' °C';
                    var color = tempColor(z.temp);
                    tempRows += '<tr class="sa-tr">' +
                        '<td class="sa-td left" style="display:flex;align-items:center;gap:8px;">' +
                        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color + ';box-shadow:0 0 6px ' + color + ';"></span>' +
                        '<span>' + label + '</span>' +
                        '</td>' +
                        '<td class="sa-td right" style="color:' + color + ';font-weight:700;">' + val + '</td>' +
                        '</tr>';
                });
            } else {
                var tKeys = Object.keys(tempObj).filter(function(k) { return k !== 'error' && k !== 'zones'; });
                if (tKeys.length > 0) {
                    tKeys.forEach(function(k) {
                        var valRaw = tempObj[k];
                        if (!isValidTemp(valRaw)) return;
                        var label = formatSensorName(k);
                        var val = parseFloat(valRaw).toFixed(1) + ' °C';
                        var color = tempColor(valRaw);
                        tempRows += '<tr class="sa-tr">' +
                            '<td class="sa-td left" style="display:flex;align-items:center;gap:8px;">' +
                            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color + ';box-shadow:0 0 6px ' + color + ';"></span>' +
                            '<span>' + label + '</span>' +
                            '</td>' +
                            '<td class="sa-td right" style="color:' + color + ';font-weight:700;">' + val + '</td>' +
                            '</tr>';
                    });
                }
            }
        }
        if (!tempRows) {
            tempRows = '<tr class="sa-tr"><td class="sa-td left" colspan="2" style="text-align:center;color:#64748b;font-size:13px;padding:16px;">No thermal sensors detected on this system.</td></tr>';
        }
        fillDump('ui-temp-dump', tempRows);

        /* Device Info — dump GetDeviceInfo */
        var devRows = dumpObj(info, '');
        if (!devRows) devRows = '<tr class="sa-tr"><td class="sa-td left" colspan="2" style="text-align:center;color:#ef4444;font-size:13px;padding:16px;">GetDeviceInfo returned no data.<br>Auth may have failed or the endpoint is unavailable.</td></tr>';
        fillDump('ui-dev-dump', devRows);

        /* Full Network Stats — dump GetNetworkStatus + Neighbour + Utilization */
        var netRows = dumpObj(d, 'network') + dumpObj(n, 'neighbour') + dumpObj(u, 'util');
        if (!netRows) netRows = '<tr class="sa-tr"><td class="sa-td left" colspan="2" style="text-align:center;color:#ef4444;font-size:13px;padding:16px;">No data</td></tr>';
        fillDump('ui-net-dump', netRows);

        /* ── last updated ── */
        var now = new Date();
        set('ui-last-update', now.toLocaleTimeString());
    }).catch(function(err) {
        set('ui-conn-status', 'Error — Check ODU reachability', '#ef4444');
    });
}

return view.extend({
    handleSaveApply: null,
    handleSave: null,
    handleReset: null,

    render: function() {
        var html = `
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,400;0,14..32,500;0,14..32,600;0,14..32,700;0,14..32,800&display=swap');

            /* ── Base ── */
            #cbi-jodu52540 {
                font-family: 'Inter', system-ui, -apple-system, sans-serif;
                color: #e2e8f0;
                position: relative;
                z-index: 1;
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
            }
            #cbi-jodu52540::before {
                content: ''; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
                background: linear-gradient(-45deg, #020617, #0f172a, #1e1b4b, #020617);
                background-size: 400% 400%;
                animation: bgShift 18s ease infinite;
                z-index: -2;
            }
            #cbi-jodu52540::after {
                content: ''; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
                background:
                    radial-gradient(circle at 15% 50%, rgba(139,92,246,0.2), transparent 50%),
                    radial-gradient(circle at 85% 30%, rgba(16,185,129,0.15), transparent 50%),
                    radial-gradient(circle at 50% 80%, rgba(56,189,248,0.2), transparent 50%);
                background-size: 200% 200%;
                animation: bgShift 25s ease infinite alternate;
                z-index: -1; pointer-events: none;
            }
            @keyframes bgShift {
                0%   { background-position: 0% 50%; }
                50%  { background-position: 100% 50%; }
                100% { background-position: 0% 50%; }
            }

            /* ── Liquid Glass ── */
            .sa-glass {
                background: linear-gradient(
                    135deg,
                    rgba(255,255,255,0.07) 0%,
                    rgba(255,255,255,0.03) 50%,
                    rgba(255,255,255,0.06) 100%
                );
                backdrop-filter: blur(32px) saturate(180%) brightness(1.05);
                -webkit-backdrop-filter: blur(32px) saturate(180%) brightness(1.05);
                border: 1px solid rgba(255,255,255,0.12);
                box-shadow:
                    0 8px 32px rgba(0,0,0,0.4),
                    inset 0 1px 0 rgba(255,255,255,0.15),
                    inset 0 -1px 0 rgba(0,0,0,0.1);
                position: relative;
                overflow: hidden;
                transform-style: preserve-3d;
                will-change: transform;
                transition: box-shadow 0.3s ease, border-color 0.3s ease;
            }
            /* Top shimmer edge */
            .sa-glass::before {
                content: '';
                position: absolute;
                top: 0; left: 0; right: 0;
                height: 1px;
                background: linear-gradient(90deg,
                    transparent 0%,
                    rgba(255,255,255,0.5) 30%,
                    rgba(255,255,255,0.8) 50%,
                    rgba(255,255,255,0.5) 70%,
                    transparent 100%);
                z-index: 2;
                pointer-events: none;
            }
            /* Spotlight cursor glow */
            .sa-hover-glow::after {
                content: ''; position: absolute; inset: 0;
                background: radial-gradient(
                    500px circle at var(--mouse-x,50%) var(--mouse-y,50%),
                    rgba(255,255,255,0.1),
                    rgba(255,255,255,0.03) 40%,
                    transparent 70%
                );
                opacity: 0;
                transition: opacity 0.4s ease;
                pointer-events: none;
                z-index: 1;
            }
            .sa-hover-glow:hover::after { opacity: 1; }
            /* 3D tilt effect handled via JS inline style */
            .sa-tilt {
                transition: transform 0.15s ease, box-shadow 0.15s ease;
            }
            .sa-tilt:hover {
                box-shadow:
                    0 20px 60px rgba(0,0,0,0.5),
                    inset 0 1px 0 rgba(255,255,255,0.2),
                    inset 0 -1px 0 rgba(0,0,0,0.15);
                border-color: rgba(255,255,255,0.22);
            }

            /* ── LIGHT THEME ── */
            #cbi-jodu52540.theme-light::before {
                background: linear-gradient(-45deg, #fef08a, #fed7aa, #ffedd5, #fca5a5);
                background-size: 400% 400%;
            }
            #cbi-jodu52540.theme-light::after {
                background:
                    radial-gradient(circle at 15% 50%, rgba(249,115,22,0.35), transparent 50%),
                    radial-gradient(circle at 85% 30%, rgba(236,72,153,0.25), transparent 50%),
                    radial-gradient(circle at 50% 80%, rgba(14,165,233,0.3), transparent 50%);
                background-size: 200% 200%;
            }
            #cbi-jodu52540.theme-light { color: #1e293b; }
            #cbi-jodu52540.theme-light .sa-title { color: #0f172a; }
            #cbi-jodu52540.theme-light .sa-subtitle,
            #cbi-jodu52540.theme-light .sa-uptime-label,
            #cbi-jodu52540.theme-light .sa-card-lbl,
            #cbi-jodu52540.theme-light .sa-td.left,
            #cbi-jodu52540.theme-light .sa-footer { color: #475569; }
            #cbi-jodu52540.theme-light .sa-uptime-val { color: #334155; }
            #cbi-jodu52540.theme-light .sa-card-val { color: #0f172a; }
            #cbi-jodu52540.theme-light .sa-td.right { color: #0f172a; }
            #cbi-jodu52540.theme-light .sa-unit { color: #64748b; }
            #cbi-jodu52540.theme-light .sa-glass {
                background: linear-gradient(
                    135deg,
                    rgba(255,255,255,0.55) 0%,
                    rgba(255,255,255,0.35) 50%,
                    rgba(255,255,255,0.5) 100%
                );
                border-color: rgba(255,255,255,0.75);
                box-shadow:
                    0 8px 32px rgba(100,120,160,0.18),
                    inset 0 1px 0 rgba(255,255,255,0.95),
                    inset 0 -1px 0 rgba(0,0,0,0.04);
            }
            #cbi-jodu52540.theme-light .sa-glass::before {
                background: linear-gradient(90deg,
                    transparent 0%,
                    rgba(255,255,255,0.9) 30%,
                    rgba(255,255,255,1) 50%,
                    rgba(255,255,255,0.9) 70%,
                    transparent 100%);
            }
            #cbi-jodu52540.theme-light .sa-section-head {
                background: rgba(255,255,255,0.45);
                border-bottom-color: rgba(255,255,255,0.6);
                color: #0f172a;
            }
            #cbi-jodu52540.theme-light .sa-tr { border-bottom-color: rgba(0,0,0,0.07); }
            #cbi-jodu52540.theme-light .sa-tr:hover { background: rgba(255,255,255,0.55); }
            #cbi-jodu52540.theme-light .sa-icon-btn {
                background: rgba(0,0,0,0.08) !important;
                border-color: rgba(0,0,0,0.15) !important;
                color: #0f172a !important;
            }
            #cbi-jodu52540.theme-light .sa-icon-btn:hover { background: rgba(0,0,0,0.15) !important; }
            #cbi-jodu52540.theme-light .sa-hover-glow::after {
                background: radial-gradient(600px circle at var(--mouse-x,50%) var(--mouse-y,50%), rgba(255,255,255,0.55), transparent 40%);
            }
            #cbi-jodu52540.theme-light .sa-container.phone-view {
                border-color: rgba(255,255,255,0.5);
                background: rgba(255,255,255,0.15);
            }

            /* ── PRO THEME ── */
            #cbi-jodu52540.theme-pro::before,
            #cbi-jodu52540.theme-pro::after { display: none; }
            #cbi-jodu52540.theme-pro {
                background: #070d1a;
                color: #e2e8f0;
            }
            #cbi-jodu52540.theme-pro .sa-container {
                background: transparent; border: none; box-shadow: none; padding: 0;
            }
            #cbi-jodu52540.theme-pro .sa-glass {
                background: #0d1629;
                border: 1px solid #1e2d4a;
                box-shadow: none;
                backdrop-filter: none; -webkit-backdrop-filter: none;
                border-radius: 10px;
            }
            #cbi-jodu52540.theme-pro .sa-glass::before,
            #cbi-jodu52540.theme-pro .sa-glass::after { display: none; }
            #cbi-jodu52540.theme-pro .sa-hover-glow::after { display: none; }
            #cbi-jodu52540.theme-pro .sa-card:hover {
                transform: none;
                background: #111e36;
                box-shadow: none;
            }
            #cbi-jodu52540.theme-pro .sa-card-icon { display: none; }
            #cbi-jodu52540.theme-pro .sa-card-val { font-size: 26px !important; color: #f1f5f9 !important; }
            #cbi-jodu52540.theme-pro .sa-card-lbl { color: #4b6a9a; font-size: 11px; }
            #cbi-jodu52540.theme-pro .sa-card { padding: 16px 10px; border-radius: 10px; }
            #cbi-jodu52540.theme-pro .sa-section-head {
                background: #0d1629;
                border-bottom: 1px solid #1e2d4a;
                font-size: 13px; color: #7ea8d8; font-weight: 600;
                padding: 12px 16px;
            }
            #cbi-jodu52540.theme-pro .sa-section-head-dot { display: none; }
            #cbi-jodu52540.theme-pro .sa-title { color: #e2e8f0; font-size: 22px; }
            #cbi-jodu52540.theme-pro .sa-subtitle,
            #cbi-jodu52540.theme-pro .sa-uptime-label { color: #4b6a9a; }
            #cbi-jodu52540.theme-pro .sa-uptime-val { color: #7ea8d8; }
            #cbi-jodu52540.theme-pro .sa-tr { border-bottom-color: #1e2d4a; }
            #cbi-jodu52540.theme-pro .sa-td { padding: 11px 16px; font-size: 14px; }
            #cbi-jodu52540.theme-pro .sa-td.left { color: #4b6a9a; font-weight: 400; }
            #cbi-jodu52540.theme-pro .sa-td.right { color: #c8d9ef; }
            #cbi-jodu52540.theme-pro .sa-footer { color: #1e2d4a; }
            #cbi-jodu52540.theme-pro .sa-icon-btn {
                background: #0d1629 !important;
                border-color: #1e2d4a !important;
                color: #7ea8d8 !important;
            }
            #cbi-jodu52540.theme-pro .sa-icon-btn:hover { background: #111e36 !important; }
            #cbi-jodu52540.theme-pro #sa-reboot-btn { background: rgba(239,68,68,0.15) !important; border-color: rgba(239,68,68,0.35) !important; color: #f87171 !important; }
            #cbi-jodu52540.theme-pro #sa-reboot-btn:hover { background: rgba(239,68,68,0.3) !important; }

            /* ── Layout ── */
            .sa-container { transition: all 0.35s cubic-bezier(0.4,0,0.2,1); }
            .sa-container.phone-view {
                max-width: 393px; /* iPhone 14 Pro width */
                margin: 0 auto;
                /* Liquid glass phone shell */
                background: linear-gradient(
                    180deg,
                    rgba(255,255,255,0.09) 0%,
                    rgba(255,255,255,0.04) 100%
                );
                backdrop-filter: blur(40px) saturate(200%);
                -webkit-backdrop-filter: blur(40px) saturate(200%);
                padding: 28px 20px 20px;
                padding-top: calc(28px + env(safe-area-inset-top, 0px));
                padding-bottom: calc(32px + env(safe-area-inset-bottom, 0px));
                padding-left: calc(20px + env(safe-area-inset-left, 0px));
                padding-right: calc(20px + env(safe-area-inset-right, 0px));
                border-radius: 44px;
                box-shadow:
                    0 30px 80px rgba(0,0,0,0.6),
                    0 0 0 1px rgba(255,255,255,0.12),
                    inset 0 1px 0 rgba(255,255,255,0.2),
                    inset 0 -1px 0 rgba(0,0,0,0.15);
                border: none;
                position: relative;
            }
            /* Phone notch shimmer */
            .sa-container.phone-view::before {
                content: '';
                position: absolute;
                top: 0; left: 10%; right: 10%;
                height: 1px;
                background: linear-gradient(90deg,
                    transparent,
                    rgba(255,255,255,0.7) 30%,
                    rgba(255,255,255,1) 50%,
                    rgba(255,255,255,0.7) 70%,
                    transparent
                );
                pointer-events: none;
                z-index: 10;
            }
            .sa-header-bar {
                display: flex; justify-content: space-between; align-items: center;
                margin-bottom: 20px; flex-wrap: wrap; gap: 12px;
            }
            .sa-container.phone-view .sa-header-bar {
                flex-direction: column; align-items: stretch; gap: 14px;
            }
            .sa-container.phone-view .sa-header-actions {
                justify-content: center;
            }
            .sa-title-row   { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
            .sa-header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

            /* ── Typography ── */
            .sa-title {
                margin: 0; font-size: 28px; font-weight: 800;
                color: #f8fafc; white-space: nowrap;
                letter-spacing: -0.5px;
            }
            .sa-subtitle { font-size: 15px; color: #94a3b8; font-weight: 500; margin-top: 2px; }
            .sa-uptime-label { font-size: 14px; color: #94a3b8; }
            .sa-uptime-val   { font-size: 14px; font-weight: 600; color: #cbd5e1; }
            .sa-card-val  { font-size: 26px; font-weight: 700; margin: 6px 0 4px; color: #f8fafc; line-height: 1.1; }
            .sa-card-lbl  { font-size: 11px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.8px; color: #64748b; }
            .sa-section-head {
                padding: 14px 18px;
                background: rgba(255,255,255,0.03);
                border-bottom: 1px solid rgba(255,255,255,0.07);
                font-size: 14px; font-weight: 700; color: #f1f5f9;
                display: flex; align-items: center; gap: 10px;
                letter-spacing: 0.1px;
            }
            .sa-td.left  { font-size: 14px; font-weight: 500; color: #94a3b8; width: 45%; }
            .sa-td.right { font-size: 15px; text-align: right; font-weight: 600; color: #f1f5f9; }
            .sa-tr { border-bottom: 1px solid rgba(255,255,255,0.05); transition: background 0.15s; }
            .sa-tr:hover { background: rgba(255,255,255,0.04); }

            /* ── Section Grid ── */
            .sa-grid-sections {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
                gap: 14px;
            }
            .sa-container.phone-view .sa-grid-sections { grid-template-columns: 1fr; }
            .sa-section { border-radius: 16px; overflow: hidden; }
            .sa-section-head-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }

            /* ── Table ── */
            .sa-table { width: 100%; border-collapse: collapse; }
            .sa-tr:last-child { border-bottom: none; }
            .sa-td { padding: 13px 18px; }

            /* ── Dot ── */
            .sa-dot {
                width: 9px; height: 9px; border-radius: 50%; background: #22c55e;
                box-shadow: 0 0 6px #22c55e; display: inline-block; flex-shrink: 0;
                animation: dotPulse 2.5s ease infinite;
            }
            @keyframes dotPulse {
                0%,100% { opacity: 1; transform: scale(1); }
                50%      { opacity: 0.6; transform: scale(0.85); }
            }

            /* ── Action Buttons ── */
            .action-btn {
                margin: 0 !important;
                display: inline-flex; align-items: center; justify-content: center;
                cursor: pointer; transition: all 0.2s ease;
                border: none !important;
                backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
            }
            .sa-icon-btn {
                padding: 0 !important;
                width: 40px !important; height: 40px !important;
                border-radius: 50% !important;
                background: rgba(255,255,255,0.07) !important;
                border: 1px solid rgba(255,255,255,0.12) !important;
                color: #e2e8f0 !important;
            }
            .sa-icon-btn:hover { background: rgba(255,255,255,0.14) !important; transform: scale(1.08); }
            .sa-icon-btn:active { transform: scale(0.95); }
            #sa-reboot-btn {
                background: rgba(239,68,68,0.15) !important;
                border-color: rgba(239,68,68,0.35) !important;
                color: #f87171 !important;
            }
            #sa-reboot-btn:hover { background: rgba(239,68,68,0.3) !important; box-shadow: 0 0 14px rgba(239,68,68,0.3) !important; }
            #sa-theme-pro-btn {
                background: rgba(139,92,246,0.15) !important;
                border-color: rgba(139,92,246,0.35) !important;
                color: #c4b5fd !important;
            }
            #sa-theme-pro-btn:hover { background: rgba(139,92,246,0.3) !important; }
            #sa-login-btn {
                background: rgba(14,165,233,0.15) !important;
                border-color: rgba(14,165,233,0.35) !important;
                color: #7dd3fc !important;
            }
            #sa-login-btn:hover { background: rgba(14,165,233,0.3) !important; }
            #sa-toggle-view-btn {
                background: rgba(52,211,153,0.15) !important;
                border-color: rgba(52,211,153,0.35) !important;
                color: #6ee7b7 !important;
            }
            #sa-toggle-view-btn:hover { background: rgba(52,211,153,0.3) !important; }

            /* ── Stat Cards ── */
            .sa-grid-top {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 12px; margin-bottom: 16px;
            }
            .sa-container.phone-view .sa-grid-top { grid-template-columns: repeat(2, 1fr); gap: 10px; }
            .sa-card {
                padding: 18px 12px 14px; text-align: center; border-radius: 16px;
                transition: box-shadow 0.2s ease;
            }
            /* tap bounce on mobile */
            .sa-card:active { transform: scale(0.96) !important; transition: transform 0.1s !important; }
            .sa-card-icon { width: 40px; height: 40px; margin: 0 auto 10px; display: flex; align-items: center; justify-content: center; }
            .sa-uptime-bar { display: flex; align-items: center; gap: 6px; margin-top: 3px; }
            .sa-unit { font-size: 11px; color: #475569; margin-left: 2px; font-weight: 500; }
            .sa-graph { filter: drop-shadow(0 2px 4px rgba(0,0,0,0.25)); }
            .sa-val-dot {
                display: inline-block; width: 8px; height: 8px; border-radius: 50%;
                margin-right: 5px; background: transparent; transition: background 0.4s;
                flex-shrink: 0;
            }

            /* ── Footer ── */
            .sa-footer { margin-top: 20px; text-align: right; font-size: 12px; color: #334155; }
            .sa-data-note { font-size: 12px; color: #475569; padding: 10px 18px 12px; text-align: center; font-style: italic; }

            /* ── Phone UI extras ── */
            .sa-container.phone-view .sa-title { font-size: 22px; }
            .sa-container.phone-view .sa-card-val { font-size: 20px; }
            .sa-container.phone-view .sa-section-head { font-size: 13px; padding: 13px 16px; }
            .sa-container.phone-view .sa-td { padding: 11px 16px; }
            .sa-container.phone-view .sa-td.left { font-size: 13px; }
            .sa-container.phone-view .sa-td.right { font-size: 14px; }
            .sa-container.phone-view .sa-footer { text-align: center; }

            /* ── Responsive ── */
            @media (max-width: 680px) {
                .sa-grid-top { grid-template-columns: repeat(3, 1fr); }
                .sa-grid-sections { grid-template-columns: 1fr; }
                .sa-title { font-size: 20px; }
            }
            @media (max-width: 420px) {
                .sa-grid-top { grid-template-columns: repeat(2, 1fr); }
                .sa-title { font-size: 20px; }
            }

            /* ── Drawer ── */
            .sa-drawer-overlay {
                position: fixed; inset: 0;
                background: rgba(0,0,0,0.55);
                backdrop-filter: blur(6px);
                -webkit-backdrop-filter: blur(6px);
                z-index: 900;
                opacity: 0; pointer-events: none;
                transition: opacity 0.35s ease;
            }
            .sa-drawer-overlay.open { opacity: 1; pointer-events: all; }

            .sa-drawer {
                position: fixed; top: 0; right: 0;
                width: min(380px, 92vw);
                height: 100dvh;
                z-index: 901;
                display: flex; flex-direction: column;
                background: linear-gradient(160deg, rgba(15,23,42,0.97) 0%, rgba(8,12,28,0.99) 100%);
                backdrop-filter: blur(40px) saturate(180%);
                -webkit-backdrop-filter: blur(40px) saturate(180%);
                border-left: 1px solid rgba(255,255,255,0.1);
                box-shadow: -20px 0 80px rgba(0,0,0,0.6), inset 1px 0 0 rgba(255,255,255,0.06);
                transform: translateX(110%);
                transition: transform 0.4s cubic-bezier(0.32, 0.72, 0, 1);
                overflow: hidden;
            }
            .sa-drawer.open { transform: translateX(0); }

            /* Drawer shimmer top edge */
            .sa-drawer::before {
                content: '';
                position: absolute; top: 0; left: 0; right: 0; height: 1px;
                background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3) 40%, rgba(255,255,255,0.6) 60%, transparent);
                pointer-events: none;
            }

            .sa-drawer-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 20px 22px 16px;
                border-bottom: 1px solid rgba(255,255,255,0.07);
                flex-shrink: 0;
            }
            .sa-drawer-title {
                font-size: 18px; font-weight: 800; color: #f1f5f9; letter-spacing: -0.3px;
            }
            .sa-drawer-close {
                width: 32px; height: 32px; border-radius: 50%;
                background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12);
                color: #94a3b8; cursor: pointer; display: flex; align-items: center; justify-content: center;
                transition: all 0.2s; flex-shrink: 0;
            }
            .sa-drawer-close:hover { background: rgba(255,255,255,0.14); color: #f1f5f9; transform: scale(1.08); }

            .sa-drawer-body {
                flex: 1; overflow-y: auto; padding: 14px 16px 32px;
                scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.12) transparent;
            }
            .sa-drawer-body::-webkit-scrollbar { width: 4px; }
            .sa-drawer-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }

            /* Drawer section label */
            .sa-dr-label {
                font-size: 10px; font-weight: 700; text-transform: uppercase;
                letter-spacing: 1.2px; color: #475569; padding: 16px 6px 8px;
            }
            .sa-dr-label:first-child { padding-top: 4px; }

            /* Drawer item row */
            .sa-dr-item {
                display: flex; align-items: center; justify-content: space-between;
                padding: 13px 14px;
                border-radius: 12px;
                margin-bottom: 4px;
                cursor: pointer;
                transition: background 0.15s ease, transform 0.12s ease;
                border: 1px solid transparent;
                position: relative; overflow: hidden;
                -webkit-tap-highlight-color: transparent;
            }
            .sa-dr-item:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.08); }
            .sa-dr-item:active { transform: scale(0.98); background: rgba(255,255,255,0.1); }

            .sa-dr-item-left { display: flex; align-items: center; gap: 12px; }
            .sa-dr-icon {
                width: 36px; height: 36px; border-radius: 10px; display: flex;
                align-items: center; justify-content: center; flex-shrink: 0;
            }
            .sa-dr-item-title { font-size: 14px; font-weight: 600; color: #e2e8f0; }
            .sa-dr-item-sub   { font-size: 11px; color: #64748b; margin-top: 1px; }

            /* Toggle switch */
            .sa-dr-toggle {
                width: 44px; height: 24px; border-radius: 12px;
                background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15);
                position: relative; cursor: pointer; transition: background 0.25s ease, border-color 0.25s;
                flex-shrink: 0;
            }
            .sa-dr-toggle::after {
                content: ''; position: absolute;
                top: 2px; left: 2px;
                width: 18px; height: 18px; border-radius: 50%;
                background: #94a3b8;
                transition: transform 0.25s cubic-bezier(0.32, 0.72, 0, 1), background 0.25s;
            }
            .sa-dr-toggle.on { background: rgba(34,197,94,0.35); border-color: rgba(34,197,94,0.5); }
            .sa-dr-toggle.on::after { transform: translateX(20px); background: #22c55e; box-shadow: 0 0 8px rgba(34,197,94,0.6); }

            /* Experimental section */
            .sa-dr-exp-label {
                display: flex; align-items: center; gap: 8px;
                font-size: 10px; font-weight: 700; text-transform: uppercase;
                letter-spacing: 1.2px; color: #f97316; padding: 20px 6px 8px;
            }
            .sa-dr-exp-label::before, .sa-dr-exp-label::after {
                content: ''; flex: 1; height: 1px; background: rgba(249,115,22,0.2);
            }
            .sa-dr-exp-label span { white-space: nowrap; }
            .sa-dr-exp-badge {
                display: inline-flex; align-items: center; gap: 4px;
                font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
                background: rgba(249,115,22,0.15); border: 1px solid rgba(249,115,22,0.3);
                color: #fb923c; padding: 2px 7px; border-radius: 20px; margin-left: 6px;
            }
            .sa-dr-exp-item {
                background: rgba(249,115,22,0.04);
                border-color: rgba(249,115,22,0.1) !important;
            }
            .sa-dr-exp-item:hover { background: rgba(249,115,22,0.1) !important; border-color: rgba(249,115,22,0.2) !important; }
            .sa-dr-danger-item {
                background: rgba(239,68,68,0.05);
                border-color: rgba(239,68,68,0.12) !important;
            }
            .sa-dr-danger-item:hover { background: rgba(239,68,68,0.12) !important; border-color: rgba(239,68,68,0.25) !important; }

            /* Drawer interval input */
            .sa-dr-input {
                background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
                border-radius: 8px; color: #f1f5f9; font-size: 13px; font-weight: 600;
                padding: 4px 8px; width: 54px; text-align: center; outline: none;
                font-family: 'Inter', sans-serif;
            }
            .sa-dr-input:focus { border-color: rgba(99,102,241,0.5); background: rgba(99,102,241,0.1); }

            /* Menu open button in header */
            #sa-menu-btn {
                background: rgba(255,255,255,0.07) !important;
                border-color: rgba(255,255,255,0.12) !important;
                color: #e2e8f0 !important;
            }
            #sa-menu-btn:hover { background: rgba(255,255,255,0.14) !important; }

            /* ── QCMAP Terminal Modal ── */
            .sa-modal-overlay {
                position: fixed; inset: 0;
                background: rgba(0,0,0,0.7);
                backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
                z-index: 1000;
                display: none; align-items: center; justify-content: center;
                padding: 16px;
            }
            .sa-modal-overlay.open { display: flex; animation: saFadeIn 0.2s ease; }
            @keyframes saFadeIn { from { opacity: 0; } to { opacity: 1; } }

            .sa-modal {
                width: min(780px, 96vw);
                max-height: 92vh;
                display: flex; flex-direction: column;
                background: linear-gradient(160deg, rgba(15,23,42,0.98) 0%, rgba(8,12,28,0.99) 100%);
                border: 1px solid rgba(255,255,255,0.15);
                border-radius: 20px;
                box-shadow: 0 25px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.08);
                overflow: hidden;
            }

            .sa-modal-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 16px 20px;
                border-bottom: 1px solid rgba(255,255,255,0.08);
                background: rgba(255,255,255,0.02);
            }
            .sa-modal-title {
                font-size: 15px; font-weight: 700; color: #f1f5f9; display: flex; align-items: center; gap: 8px;
            }
            .sa-modal-close {
                width: 32px; height: 32px; border-radius: 50%;
                background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12);
                color: #94a3b8; cursor: pointer; display: flex; align-items: center; justify-content: center;
                transition: all 0.2s;
            }
            .sa-modal-close:hover { background: rgba(255,255,255,0.15); color: #fff; transform: scale(1.08); }

            .sa-modal-body {
                padding: 16px 20px;
                display: flex; flex-direction: column; gap: 14px;
                overflow-y: auto;
            }

            .sa-qc-btn {
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 12px;
                padding: 10px 12px;
                text-align: left;
                cursor: pointer;
                transition: all 0.2s ease;
                display: flex; flex-direction: column; gap: 3px;
                backdrop-filter: blur(10px);
            }
            .sa-qc-btn:hover {
                background: rgba(99,102,241,0.15);
                border-color: rgba(99,102,241,0.35);
                transform: translateY(-2px);
                box-shadow: 0 4px 14px rgba(0,0,0,0.3);
            }
            .sa-qc-btn:active {
                transform: scale(0.98);
            }
            .sa-qc-title {
                font-size: 12px; font-weight: 700; color: #f1f5f9;
            }
            .sa-qc-sub {
                font-size: 10px; font-family: monospace; color: #64748b;
            }

            .sa-term-pill {
                background: rgba(99,102,241,0.12);
                border: 1px solid rgba(99,102,241,0.25);
                color: #a5b4fc; font-size: 11px; font-weight: 600;
                padding: 4px 10px; border-radius: 12px; cursor: pointer;
                transition: all 0.15s; font-family: monospace;
            }
            .sa-term-pill:hover {
                background: rgba(99,102,241,0.25); border-color: rgba(99,102,241,0.5); color: #fff; transform: translateY(-1px);
            }

            .sa-term-window {
                background: #040714;
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 12px;
                padding: 12px 14px;
                font-family: 'SF Mono', Monaco, Consolas, 'Courier New', monospace;
                font-size: 12px;
                line-height: 1.5;
                color: #38bdf8;
                height: 220px;
                overflow-y: auto;
                white-space: pre-wrap;
                word-break: break-all;
                box-shadow: inset 0 2px 8px rgba(0,0,0,0.6);
            }

            .sa-term-input-row {
                display: flex; gap: 8px; align-items: center;
            }
            .sa-term-prompt {
                font-family: monospace; font-size: 13px; color: #22c55e; font-weight: 700; white-space: nowrap;
            }
            .sa-term-input {
                flex: 1;
                background: rgba(255,255,255,0.06);
                border: 1px solid rgba(255,255,255,0.15);
                border-radius: 10px;
                padding: 9px 12px;
                color: #f1f5f9;
                font-family: monospace;
                font-size: 13px;
                outline: none;
            }
            .sa-term-input:focus {
                border-color: #818cf8; background: rgba(99,102,241,0.1);
            }
            .sa-term-send-btn {
                background: linear-gradient(135deg, #6366f1, #4f46e5);
                border: none; border-radius: 10px;
                color: #fff; font-weight: 600; font-size: 13px;
                padding: 9px 18px; cursor: pointer; transition: all 0.2s;
                display: flex; align-items: center; gap: 6px;
            }
            .sa-term-send-btn:hover { background: linear-gradient(135deg, #4f46e5, #4338ca); transform: translateY(-1px); }
            .sa-term-send-btn:active { transform: translateY(0); }

            /* ── Config Modal Inputs ── */
            .sa-cfg-trigger-btn {
                background: linear-gradient(135deg, rgba(99,102,241,0.25) 0%, rgba(79,70,229,0.35) 100%) !important;
                border: 1px solid rgba(129,140,248,0.5) !important;
                color: #e0e7ff !important;
                padding: 7px 14px !important;
                border-radius: 10px !important;
                font-weight: 700 !important;
                font-size: 13px !important;
                display: inline-flex !important;
                align-items: center !important;
                gap: 8px !important;
                cursor: pointer !important;
                transition: all 0.2s ease !important;
                box-shadow: 0 4px 12px rgba(99,102,241,0.2) !important;
            }
            .sa-cfg-trigger-btn:hover {
                background: linear-gradient(135deg, rgba(99,102,241,0.5) 0%, rgba(79,70,229,0.6) 100%) !important;
                border-color: rgba(165,180,252,0.8) !important;
                color: #ffffff !important;
                transform: translateY(-1px) scale(1.02) !important;
                box-shadow: 0 6px 18px rgba(99,102,241,0.35) !important;
            }
            .sa-cfg-group {
                display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px;
            }
            .sa-cfg-label {
                font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #94a3b8;
            }
            .sa-cfg-input-wrap {
                position: relative; display: flex; align-items: center;
            }
            .sa-cfg-input {
                width: 100%;
                background: rgba(15,23,42,0.85);
                border: 1px solid rgba(255,255,255,0.14);
                border-radius: 10px;
                padding: 10px 14px;
                color: #f1f5f9;
                font-size: 13px;
                outline: none;
                transition: all 0.2s ease;
                box-sizing: border-box;
            }
            .sa-cfg-input:focus {
                border-color: #818cf8;
                box-shadow: 0 0 0 3px rgba(129,140,248,0.25);
                background: rgba(15,23,42,0.95);
            }
            .sa-cfg-eye-btn {
                position: absolute; right: 10px;
                background: none; border: none; cursor: pointer;
                color: #94a3b8; padding: 4px; display: flex; align-items: center; justify-content: center;
                transition: color 0.2s;
            }
            .sa-cfg-eye-btn:hover { color: #f1f5f9; }
            .sa-cfg-hint {
                font-size: 11px; color: #64748b; line-height: 1.4;
            }
            .sa-cfg-btn {
                padding: 10px 18px; border-radius: 10px; font-size: 13px; font-weight: 600;
                cursor: pointer; transition: all 0.2s; border: none; display: inline-flex; align-items: center; gap: 6px;
            }
            .sa-cfg-btn-primary {
                background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
                color: #fff; box-shadow: 0 4px 14px rgba(99,102,241,0.35);
            }
            .sa-cfg-btn-primary:hover {
                background: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%);
                box-shadow: 0 6px 18px rgba(99,102,241,0.5); transform: translateY(-1px);
            }
            .sa-cfg-btn-sec {
                background: rgba(255,255,255,0.07); color: #cbd5e1; border: 1px solid rgba(255,255,255,0.12);
            }
            .sa-cfg-btn-sec:hover { background: rgba(255,255,255,0.14); color: #fff; }
        </style>

        <div class="cbi-map" id="cbi-jodu52540">
            <div class="sa-container">
            <!-- ── HEADER ── -->
            <div class="sa-header-bar">
                <div class="sa-title-row">
                    <div>
                        <h2 class="sa-title">
                            <span class="sa-dot"></span>&nbsp;5G Dashboard
                        </h2>
                        <div class="sa-subtitle">
                            <span id="ui-hostname">—</span> &nbsp;·&nbsp;
                            <span id="ui-operator">—</span>
                        </div>
                    </div>
                    <div>
                        <div class="sa-uptime-bar">
                            <span class="sa-uptime-label">Status:</span>
                            <span id="ui-conn-status" style="font-size:14px;font-weight:600;">—</span>
                        </div>
                        <div class="sa-uptime-bar">
                            <span class="sa-uptime-label">RRC:</span>
                            <span id="ui-rrc" style="font-size:14px;font-weight:600;">—</span>
                        </div>
                    </div>
                    <div>
                        <div class="sa-uptime-bar">
                            <span class="sa-uptime-label">Uptime:</span>
                            <span id="ui-uptime" class="sa-uptime-val">—</span>
                        </div>
                    </div>
                    <div>
                        <div class="sa-uptime-bar" style="cursor:pointer;border-color:rgba(129,140,248,0.4);" id="sa-config-badge" title="Click to configure ODU Credentials">
                            <span class="sa-uptime-label">ODU Auth:</span>
                            <span style="font-size:13px;font-weight:700;color:#818cf8;text-decoration:underline;">⚙️ Configure</span>
                        </div>
                    </div>
                </div>

                <div class="sa-header-actions">
                    <button class="btn action-btn sa-cfg-trigger-btn" id="sa-config-btn" title="Configure ODU &amp; Telnet Credentials">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                        <span>ODU Credentials</span>
                    </button>
                    <button class="btn action-btn sa-icon-btn" id="sa-refresh-btn" title="Refresh">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                    </button>
                    <button class="btn action-btn sa-icon-btn" id="sa-menu-btn" title="Open Menu">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                    </button>
                </div>
            </div>

            <!-- ── TOP CARDS ── -->
            <div class="sa-grid-top">

                <!-- Signal Bars -->
                <div class="sa-card sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-card-icon" id="ui-bars">
                        <svg width="28" height="22" viewBox="0 0 28 22" fill="none"><rect x="0" y="17" width="4" height="5" rx="1" fill="rgba(255,255,255,0.15)"/><rect x="6" y="13" width="4" height="9" rx="1" fill="rgba(255,255,255,0.15)"/><rect x="12" y="9" width="4" height="13" rx="1" fill="rgba(255,255,255,0.15)"/><rect x="18" y="5" width="4" height="17" rx="1" fill="rgba(255,255,255,0.15)"/><rect x="24" y="0" width="4" height="22" rx="1" fill="rgba(255,255,255,0.15)"/></svg>
                    </div>
                    <div class="sa-card-val" id="ui-sig-str" style="font-size:18px;">—</div>
                    <div class="sa-card-lbl">Signal Quality</div>
                </div>

                <!-- Band -->
                <div class="sa-card sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-card-icon">
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="1.8" stroke-linecap="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                    </div>
                    <div class="sa-card-val" id="ui-op-band" style="color:#818cf8;">—</div>
                    <div class="sa-card-lbl">Operating Band</div>
                </div>

                <!-- Mode -->
                <div class="sa-card sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-card-icon">
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
                    </div>
                    <div class="sa-card-val" id="ui-op-mode" style="color:#34d399;">—</div>
                    <div class="sa-card-lbl">Mode (SA/NSA)</div>
                </div>

                <!-- Bandwidth -->
                <div class="sa-card sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-card-icon">
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 3H8"/></svg>
                    </div>
                    <div class="sa-card-val" id="ui-bandwidth" style="color:#60a5fa;">—</div>
                    <div class="sa-card-lbl">Bandwidth (MHz)</div>
                </div>

                <!-- MIMO -->
                <div class="sa-card sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-card-icon">
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="1.8" stroke-linecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                    </div>
                    <div class="sa-card-val" id="ui-mimo" style="color:#f59e0b;">—</div>
                    <div class="sa-card-lbl">MIMO Config</div>
                </div>

                <!-- APN -->
                <div class="sa-card sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-card-icon">
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.8" stroke-linecap="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                    </div>
                    <div class="sa-card-val" id="ui-apn" style="color:#a78bfa;font-size:18px;">—</div>
                    <div class="sa-card-lbl">Default APN</div>
                </div>

            </div>

            <!-- ── DETAIL SECTIONS ── -->
            <div class="sa-grid-sections">

                <!-- Serving Cell Signal -->
                <div class="sa-section sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-section-head">
                        <div class="sa-section-head-dot" style="background:#22c55e;box-shadow:0 0 5px #22c55e;"></div>
                        Primary Cell — Signal Metrics
                    </div>
                    <table class="sa-table">
                        <tbody>
                            ${row('SS-RSRP', 'ui-rsrp', 'dBm', true)}
                            ${row('SS-RSRQ', 'ui-rsrq', 'dB', true)}
                            ${row('SS-SNR / SINR', 'ui-snr', 'dB', true)}
                            ${row('BLER', 'ui-bler', '%', true)}
                            ${row('Modulation DL', 'ui-mod')}
                            ${row('Modulation UL', 'ui-modul')}
                        </tbody>
                    </table>
                </div>

                <!-- Serving Cell Info -->
                <div class="sa-section sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-section-head">
                        <div class="sa-section-head-dot" style="background:#60a5fa;box-shadow:0 0 5px #60a5fa;"></div>
                        Primary Cell — Cell Information
                    </div>
                    <table class="sa-table">
                        <tbody>
                            ${row('PCI', 'ui-pci')}
                            ${row('NR-ARFCN', 'ui-earfcn')}
                            ${row('ECGI', 'ui-ecgi')}
                            ${row('PLMN', 'ui-plmn')}
                            ${row('Operator', 'ui-operator')}
                        </tbody>
                    </table>
                </div>

                <!-- Secondary Cell (CA) -->
                <div class="sa-section sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-section-head">
                        <div class="sa-section-head-dot" style="background:#f59e0b;box-shadow:0 0 5px #f59e0b;"></div>
                        <span id="ui-sc-label">Secondary Cell (Carrier Aggregation)</span>
                    </div>
                    <table class="sa-table">
                        <tbody>
                            ${row('Band', 'ui-sc-band')}
                            ${row('Mode', 'ui-sc-mode')}
                            ${row('Bandwidth', 'ui-sc-bw', 'MHz')}
                            ${row('MIMO', 'ui-sc-mimo')}
                            ${row('PCI', 'ui-sc-pci')}
                            ${row('SS-RSRP', 'ui-sc-rsrp', 'dBm', true)}
                            ${row('SS-RSRQ', 'ui-sc-rsrq', 'dB', true)}
                            ${row('SS-SNR', 'ui-sc-snr', 'dB', true)}
                            ${row('BLER', 'ui-sc-bler', '%', true)}
                            ${row('Modulation DL', 'ui-sc-mod')}
                            ${row('Signal', 'ui-sc-sigsz')}
                        </tbody>
                    </table>
                </div>

                <!-- Neighbour Cell -->
                <div class="sa-section sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-section-head">
                        <div class="sa-section-head-dot" style="background:#a78bfa;box-shadow:0 0 5px #a78bfa;"></div>
                        Neighbour Cell
                    </div>
                    <table class="sa-table">
                        <tbody>
                            ${row('Band', 'ui-nc-band')}
                            ${row('Mode', 'ui-nc-mode')}
                            ${row('PCI', 'ui-nc-pci')}
                            ${row('SS-RSRP', 'ui-nc-rsrp', 'dBm', true)}
                            ${row('SS-RSRQ', 'ui-nc-rsrq', 'dB', true)}
                            ${row('SS-SNR', 'ui-nc-snr', 'dB', true)}
                            ${row('Signal', 'ui-nc-sig', '', true)}
                        </tbody>
                    </table>
                </div>

                <!-- System Utilization -->
                <div class="sa-section sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-section-head">
                        <div class="sa-section-head-dot" style="background:#eab308;box-shadow:0 0 5px #eab308;"></div>
                        System Utilization
                    </div>
                    <table class="sa-table">
                        <tbody>
                            ${row('CPU Usage', 'ui-cpu', '%')}
                            ${row('Memory Usage', 'ui-mem', 'MB')}
                            ${row('System Uptime', 'ui-sys-uptime')}
                        </tbody>
                    </table>
                </div>

                <!-- Data Usage -->
                <div class="sa-section sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-section-head">
                        <div class="sa-section-head-dot" style="background:#14b8a6;box-shadow:0 0 5px #14b8a6;"></div>
                        Data Usage Over Time
                    </div>
                    <table class="sa-table">
                        <tbody>
                            ${row('Current Download Speed', 'ui-speed-rx')}
                            ${row('Current Upload Speed', 'ui-speed-tx')}
                            ${row('Total Downloaded (Since Boot)', 'ui-data-rx')}
                            ${row('Total Uploaded (Since Boot)', 'ui-data-tx')}
                            ${row('Used Last 5 Mins', 'ui-data-5m')}
                            ${row('Used Last 1 Hour', 'ui-data-1h')}
                            ${row('Used Last 5 Hours', 'ui-data-5h')}
                            ${row('Used Last 24 Hours', 'ui-data-24h')}
                        </tbody>
                    </table>
                    <div class="sa-data-note">Data usage tracked locally in browser. Resets on browser clear.</div>
                </div>

                <!-- System Temperatures -->
                <div class="sa-section sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-section-head">
                        <div class="sa-section-head-dot" style="background:#f97316;box-shadow:0 0 5px #f97316;"></div>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>
                        System Temperatures
                    </div>
                    <table class="sa-table">
                        <tbody id="ui-temp-dump">
                            <tr class="sa-tr"><td class="sa-td left" colspan="2" style="text-align:center;color:#64748b;font-size:13px;">Loading temperatures…</td></tr>
                        </tbody>
                    </table>
                </div>

                <!-- Device Info — raw dump from GetDeviceInfo -->
                <div class="sa-section sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-section-head">
                        <div class="sa-section-head-dot" style="background:#f472b6;box-shadow:0 0 5px #f472b6;"></div>
                        Device Information
                    </div>
                    <table class="sa-table">
                        <tbody id="ui-dev-dump">
                            <tr class="sa-tr"><td class="sa-td left" colspan="2" style="text-align:center;color:#64748b;font-size:13px;">Loading…</td></tr>
                        </tbody>
                    </table>
                </div>

                <!-- Full Network Stats — raw dump from GetNetworkStatus + Neighbour + Utilization -->
                <div class="sa-section sa-glass sa-hover-glow sa-tilt">
                    <div class="sa-section-head">
                        <div class="sa-section-head-dot" style="background:#38bdf8;box-shadow:0 0 5px #38bdf8;"></div>
                        Full Network Stats
                    </div>
                    <table class="sa-table">
                        <tbody id="ui-net-dump">
                            <tr class="sa-tr"><td class="sa-td left" colspan="2" style="text-align:center;color:#64748b;font-size:13px;">Loading…</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- ── FOOTER ── -->
            <div class="sa-footer">
                Last updated: <span id="ui-last-update">—</span> &nbsp;·&nbsp;
                Auto-refresh every <span id="ui-refresh-interval-display">10</span>s &nbsp;·&nbsp;
                luci-app-jodu52540-status v1.0.0
            </div>

        </div>
        </div>

        <!-- ── DRAWER OVERLAY ── -->
        <div class="sa-drawer-overlay" id="sa-drawer-overlay"></div>

        <!-- ── DRAWER PANEL ── -->
        <div class="sa-drawer" id="sa-drawer">
            <div class="sa-drawer-header">
                <div>
                    <div class="sa-drawer-title">⚙️ Control Centre</div>
                    <div style="font-size:11px;color:#475569;margin-top:2px;">Jio ODU 52540 &nbsp;·&nbsp; All Features</div>
                </div>
                <button class="sa-drawer-close" id="sa-drawer-close">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>

            <div class="sa-drawer-body">

                <!-- QUICK ACTIONS -->
                <div class="sa-dr-label">Quick Actions</div>

                <div class="sa-dr-item" id="dr-refresh">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(99,102,241,0.15);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">Refresh Now</div>
                            <div class="sa-dr-item-sub">Fetch latest data from ODU</div>
                        </div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>

                <div class="sa-dr-item" id="dr-odu-login">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(14,165,233,0.15);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">ODU Login Portal</div>
                            <div class="sa-dr-item-sub">Open 192.168.225.1 in new tab</div>
                        </div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>

                <div class="sa-dr-item" id="dr-copy-stats">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(16,185,129,0.15);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">Copy Stats to Clipboard</div>
                            <div class="sa-dr-item-sub">Export signal &amp; network info as text</div>
                        </div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>

                <div class="sa-dr-item" id="dr-odu-config">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(99,102,241,0.15);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">ODU &amp; Telnet Credentials</div>
                            <div class="sa-dr-item-sub">Configure web login &amp; telnet password</div>
                        </div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>

                <!-- DISPLAY -->
                <div class="sa-dr-label">Display</div>

                <div class="sa-dr-item" id="dr-theme-glass-dark">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(139,92,246,0.15);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">Glass Dark Mode</div>
                            <div class="sa-dr-item-sub">Deep blue animated glass</div>
                        </div>
                    </div>
                    <div class="sa-dr-toggle on" id="tog-dark"></div>
                </div>

                <div class="sa-dr-item" id="dr-theme-glass-light">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(251,191,36,0.15);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">Glass Light Mode</div>
                            <div class="sa-dr-item-sub">Warm orange sunset glass</div>
                        </div>
                    </div>
                    <div class="sa-dr-toggle" id="tog-light"></div>
                </div>

                <div class="sa-dr-item" id="dr-theme-pro">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(30,41,59,0.6);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7ea8d8" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">Pro Dashboard</div>
                            <div class="sa-dr-item-sub">Classic navy terminal look</div>
                        </div>
                    </div>
                    <div class="sa-dr-toggle" id="tog-pro"></div>
                </div>

                <div class="sa-dr-item" id="dr-phone-view">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(52,211,153,0.15);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6ee7b7" stroke-width="2" stroke-linecap="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">Phone View</div>
                            <div class="sa-dr-item-sub">Narrow iPhone-style layout</div>
                        </div>
                    </div>
                    <div class="sa-dr-toggle" id="tog-phone"></div>
                </div>

                <!-- DATA -->
                <div class="sa-dr-label">Data &amp; Polling</div>

                <div class="sa-dr-item">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(20,184,166,0.15);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">Refresh Interval</div>
                            <div class="sa-dr-item-sub">Seconds between auto-polls</div>
                        </div>
                    </div>
                    <input class="sa-dr-input" id="dr-interval-input" type="number" min="5" max="300" value="10">
                </div>

                <div class="sa-dr-item" id="dr-clear-history">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(100,116,139,0.2);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">Clear Usage History</div>
                            <div class="sa-dr-item-sub">Wipes stored data from localStorage</div>
                        </div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>

                <div class="sa-dr-item" id="dr-export-json">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(99,102,241,0.15);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">Export History as JSON</div>
                            <div class="sa-dr-item-sub">Download all usage data as a file</div>
                        </div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>

                <!-- EXPERIMENTAL -->
                <div class="sa-dr-exp-label"><span>⚠️ Experimental</span></div>

                <div class="sa-dr-item sa-dr-exp-item" id="dr-ping-test">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(249,115,22,0.15);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fb923c" stroke-width="2" stroke-linecap="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">Ping ODU <span class="sa-dr-exp-badge">BETA</span></div>
                            <div class="sa-dr-item-sub">Test latency to 192.168.225.1</div>
                        </div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fb923c" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>

                <div class="sa-dr-item sa-dr-exp-item" id="dr-qcmap-cli">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(99,102,241,0.15);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">QCMAP CLI <span class="sa-dr-exp-badge" style="background:rgba(99,102,241,0.2);border-color:rgba(99,102,241,0.4);color:#a5b4fc;">TELNET</span></div>
                            <div class="sa-dr-item-sub">Qualcomm CLI via Telnet (192.168.225.1)</div>
                        </div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>

                <div class="sa-dr-item sa-dr-exp-item" id="dr-sms-inbox">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(249,115,22,0.15);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fb923c" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">SMS Inbox <span class="sa-dr-exp-badge">UNSTABLE</span></div>
                            <div class="sa-dr-item-sub">Fetch inbox via GetInboxSMS API</div>
                        </div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fb923c" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>

                <div class="sa-dr-item sa-dr-exp-item" id="dr-force-reauth">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(249,115,22,0.15);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fb923c" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title">Force Re-Auth <span class="sa-dr-exp-badge">BETA</span></div>
                            <div class="sa-dr-item-sub">Clear session &amp; re-authenticate ODU</div>
                        </div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fb923c" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>

                <div class="sa-dr-item sa-dr-danger-item" id="dr-reboot">
                    <div class="sa-dr-item-left">
                        <div class="sa-dr-icon" style="background:rgba(239,68,68,0.15);">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
                        </div>
                        <div>
                            <div class="sa-dr-item-title" style="color:#f87171;">Reboot ODU <span class="sa-dr-exp-badge" style="background:rgba(239,68,68,0.15);border-color:rgba(239,68,68,0.3);color:#f87171;">DANGER</span></div>
                            <div class="sa-dr-item-sub">Restarts the 5G unit — causes ~30s outage</div>
                        </div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>

            </div>
        </div>

        <!-- ── ODU CREDENTIALS MODAL ── -->
        <div class="sa-modal-overlay" id="sa-config-modal">
            <div class="sa-modal" style="width:min(580px, 96vw); max-height:92vh;">
                <div class="sa-modal-header">
                    <div class="sa-modal-title">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                        <span>ODU &amp; Telnet Credentials</span>
                    </div>
                    <button class="sa-modal-close" id="sa-config-close" title="Close">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
                <div class="sa-modal-body" style="padding:20px; gap:18px;">
                    <!-- Web Portal Credentials -->
                    <div>
                        <div style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; color:#38bdf8; margin-bottom:12px; display:flex; align-items:center; gap:6px;">
                            <span>🌐 ODU Web Portal (HTTP/CGI)</span>
                        </div>
                        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                            <div class="sa-cfg-group">
                                <label class="sa-cfg-label">ODU Host / IP</label>
                                <input class="sa-cfg-input" id="cfg-host" type="text" placeholder="192.168.225.1" />
                            </div>
                            <div class="sa-cfg-group">
                                <label class="sa-cfg-label">Web Username</label>
                                <input class="sa-cfg-input" id="cfg-web-user" type="text" placeholder="Admin" />
                            </div>
                        </div>
                        <div class="sa-cfg-group">
                            <label class="sa-cfg-label">Web Password</label>
                            <div class="sa-cfg-input-wrap">
                                <input class="sa-cfg-input" id="cfg-web-pass" type="password" placeholder="Enter ODU web password" />
                                <button type="button" class="sa-cfg-eye-btn" id="cfg-web-eye" title="Toggle visibility">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                </button>
                            </div>
                            <div class="sa-cfg-hint">Used for 5G RF metrics, cell scan, SMS, and reboot commands via CGI.</div>
                        </div>
                    </div>

                    <div style="border-top:1px solid rgba(255,255,255,0.08); padding-top:16px;">
                        <div style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; color:#a5b4fc; margin-bottom:12px; display:flex; align-items:center; gap:6px;">
                            <span>📟 Telnet CLI Access (Modem / Sensors)</span>
                        </div>
                        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                            <div class="sa-cfg-group">
                                <label class="sa-cfg-label">Telnet Port</label>
                                <input class="sa-cfg-input" id="cfg-telnet-port" type="number" placeholder="23" />
                            </div>
                            <div class="sa-cfg-group">
                                <label class="sa-cfg-label">Telnet Username</label>
                                <input class="sa-cfg-input" id="cfg-telnet-user" type="text" placeholder="root" />
                            </div>
                        </div>
                        <div class="sa-cfg-group">
                            <label class="sa-cfg-label">Telnet Password</label>
                            <div class="sa-cfg-input-wrap">
                                <input class="sa-cfg-input" id="cfg-telnet-pass" type="password" placeholder="Enter Telnet password (if any)" />
                                <button type="button" class="sa-cfg-eye-btn" id="cfg-telnet-eye" title="Toggle visibility">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                </button>
                            </div>
                            <div class="sa-cfg-hint">Used for thermal zone temperature monitoring, QCMAP CLI, and AT commands.</div>
                        </div>
                    </div>

                    <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:8px;">
                        <button type="button" class="sa-cfg-btn sa-cfg-btn-sec" id="sa-config-cancel">Cancel</button>
                        <button type="button" class="sa-cfg-btn sa-cfg-btn-primary" id="sa-config-save">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                            <span>Save Configuration</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <!-- ── QCMAP & MODEM ACTION HUB MODAL ── -->
        <div class="sa-modal-overlay" id="sa-qcmap-modal">
            <div class="sa-modal" style="width:min(820px, 96vw); max-height:92vh;">
                <div class="sa-modal-header">
                    <div class="sa-modal-title">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                        <span>Qualcomm QCMAP &amp; Modem Hub</span>
                        <span class="sa-dr-exp-badge" style="background:rgba(99,102,241,0.2);border-color:rgba(99,102,241,0.4);color:#a5b4fc;">TELNET 192.168.225.1</span>
                    </div>
                    <button class="sa-modal-close" id="sa-qcmap-close" title="Close">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
                <div class="sa-modal-body" style="padding:18px; gap:16px;">
                    
                    <!-- ACTION BUTTONS GRID -->
                    <div style="display:flex; flex-direction:column; gap:12px;">
                        
                        <!-- 1. Cellular & Radio Actions -->
                        <div>
                            <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#818cf8; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
                                <span>📡 5G Radio &amp; Baseband Queries</span>
                            </div>
                            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:8px;">
                                <button class="sa-qc-btn" data-action="imei">
                                    <div class="sa-qc-title">Read IMEI</div>
                                    <div class="sa-qc-sub">AT+CGSN</div>
                                </button>
                                <button class="sa-qc-btn" data-action="firmware">
                                    <div class="sa-qc-title">Firmware Version</div>
                                    <div class="sa-qc-sub">AT+CGMR</div>
                                </button>
                                <button class="sa-qc-btn" data-action="signal_csq">
                                    <div class="sa-qc-title">Signal Quality</div>
                                    <div class="sa-qc-sub">AT+CSQ</div>
                                </button>
                                <button class="sa-qc-btn" data-action="operator_info">
                                    <div class="sa-qc-title">Operator Info</div>
                                    <div class="sa-qc-sub">AT+COPS?</div>
                                </button>
                            </div>
                        </div>

                        <!-- 2. Qualcomm QCMAP Connection Manager Actions -->
                        <div>
                            <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#34d399; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
                                <span>🌐 Qualcomm QCMAP Services (Interactive)</span>
                            </div>
                            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:8px;">
                                <button class="sa-qc-btn" data-action="qcmap_1">
                                    <div class="sa-qc-title">MobileAP Config</div>
                                    <div class="sa-qc-sub">Menu Option 1</div>
                                </button>
                                <button class="sa-qc-btn" data-action="qcmap_2">
                                    <div class="sa-qc-title">LAN Config</div>
                                    <div class="sa-qc-sub">Menu Option 2</div>
                                </button>
                                <button class="sa-qc-btn" data-action="qcmap_3">
                                    <div class="sa-qc-title">NAT/ALG/VPN Config</div>
                                    <div class="sa-qc-sub">Menu Option 3</div>
                                </button>
                                <button class="sa-qc-btn" data-action="qcmap_4">
                                    <div class="sa-qc-title">WLAN Config</div>
                                    <div class="sa-qc-sub">Menu Option 4</div>
                                </button>
                                <button class="sa-qc-btn" data-action="qcmap_5">
                                    <div class="sa-qc-title">Firewall Config</div>
                                    <div class="sa-qc-sub">Menu Option 5</div>
                                </button>
                                <button class="sa-qc-btn" data-action="qcmap_6">
                                    <div class="sa-qc-title">Backhaul Config</div>
                                    <div class="sa-qc-sub">Menu Option 6</div>
                                </button>
                                <button class="sa-qc-btn" data-action="qcmap_7">
                                    <div class="sa-qc-title">Tethering Config</div>
                                    <div class="sa-qc-sub">Menu Option 7</div>
                                </button>
                                <button class="sa-qc-btn" data-action="qcmap_8">
                                    <div class="sa-qc-title">Media Service Config</div>
                                    <div class="sa-qc-sub">Menu Option 8</div>
                                </button>
                                <button class="sa-qc-btn" data-action="qcmap_9">
                                    <div class="sa-qc-title">Generic SW Bridge</div>
                                    <div class="sa-qc-sub">Menu Option 9</div>
                                </button>
                                <button class="sa-qc-btn" data-action="qcmap_10">
                                    <div class="sa-qc-title">V2X Service Config</div>
                                    <div class="sa-qc-sub">Menu Option 10</div>
                                </button>
                                <button class="sa-qc-btn" data-action="qcmap_11">
                                    <div class="sa-qc-title">Modem Throughput Est.</div>
                                    <div class="sa-qc-sub">Menu Option 11</div>
                                </button>
                            </div>
                        </div>

                        <!-- 3. Tethering Sub-Commands -->
                        <div>
                            <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#c084fc; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
                                <span>🔗 Tethering Config (Sub-Menu)</span>
                            </div>
                            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:8px;">
                                <button class="sa-qc-btn" data-action="qcmap_7_2">
                                    <div class="sa-qc-title">Get Cradle Mode</div>
                                    <div class="sa-qc-sub">Sends 7, then 2</div>
                                </button>
                                <button class="sa-qc-btn" data-action="qcmap_7_5">
                                    <div class="sa-qc-title">Get BT Tethering Status</div>
                                    <div class="sa-qc-sub">Sends 7, then 5</div>
                                </button>
                            </div>
                        </div>

                        <!-- 4. Cellular Device Manager (CDM) -->
                        <div>
                            <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#f472b6; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
                                <span>📱 Cellular Device Manager Demo</span>
                            </div>
                            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:8px;">
                                <button class="sa-qc-btn" data-action="cdm_1">
                                    <div class="sa-qc-title">DM Register</div>
                                    <div class="sa-qc-sub">Menu Option 01</div>
                                </button>
                                <button class="sa-qc-btn" data-action="cdm_2">
                                    <div class="sa-qc-title">DM Deregister</div>
                                    <div class="sa-qc-sub">Menu Option 02</div>
                                </button>
                                <button class="sa-qc-btn" data-action="cdm_3">
                                    <div class="sa-qc-title">Set Indication</div>
                                    <div class="sa-qc-sub">Menu Option 03</div>
                                </button>
                                <button class="sa-qc-btn" data-action="cdm_4">
                                    <div class="sa-qc-title">Get Indication Count</div>
                                    <div class="sa-qc-sub">Menu Option 04</div>
                                </button>
                                <button class="sa-qc-btn" data-action="cdm_5">
                                    <div class="sa-qc-title">Get Indication List</div>
                                    <div class="sa-qc-sub">Menu Option 05</div>
                                </button>
                                <button class="sa-qc-btn" data-action="cdm_6">
                                    <div class="sa-qc-title">Clear Indication List</div>
                                    <div class="sa-qc-sub">Menu Option 06</div>
                                </button>
                                <button class="sa-qc-btn" data-action="cdm_7">
                                    <div class="sa-qc-title">Get LTE/5G/GPS Metric</div>
                                    <div class="sa-qc-sub">Menu Option 07</div>
                                </button>
                                <button class="sa-qc-btn" data-action="cdm_8">
                                    <div class="sa-qc-title">Get LTE/5G/GPS List</div>
                                    <div class="sa-qc-sub">Menu Option 08</div>
                                </button>
                                <button class="sa-qc-btn" data-action="cdm_9">
                                    <div class="sa-qc-title">Set LTE/5G/GPS Metric</div>
                                    <div class="sa-qc-sub">Menu Option 09</div>
                                </button>
                                <button class="sa-qc-btn" data-action="cdm_10">
                                    <div class="sa-qc-title">Options Usage</div>
                                    <div class="sa-qc-sub">Menu Option 10</div>
                                </button>
                                <button class="sa-qc-btn" id="sa-cdm-manual-btn" style="border-color:rgba(236,72,153,0.3); background:rgba(236,72,153,0.06);">
                                    <div class="sa-qc-title" style="color:#f472b6;">Manual Menu Input</div>
                                    <div class="sa-qc-sub">Type custom option #</div>
                                </button>
                            </div>
                        </div>

                        <!-- 5. System Diagnostics -->
                        <div>
                            <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#f59e0b; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
                                <span>⚡ Diagnostics &amp; Health</span>
                            </div>
                            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:8px;">
                                <button class="sa-qc-btn" data-action="ping_test">
                                    <div class="sa-qc-title">Ping 1.1.1.1 (ODU WAN)</div>
                                    <div class="sa-qc-sub">Test direct Internet latency</div>
                                </button>
                                <button class="sa-qc-btn" data-action="uptime">
                                    <div class="sa-qc-title">ODU Uptime &amp; Load</div>
                                    <div class="sa-qc-sub">uptime (CPU average)</div>
                                </button>
                                <button class="sa-qc-btn" data-action="conntrack">
                                    <div class="sa-qc-title">Active NAT Streams</div>
                                    <div class="sa-qc-sub">conntrack connections</div>
                                </button>
                            </div>
                        </div>

                    </div>

                    <!-- CONSOLE / OUTPUT DISPLAY -->
                    <div>
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                            <div style="font-size:12px; font-weight:700; color:#e2e8f0; display:flex; align-items:center; gap:8px;">
                                <span>Execution Output</span>
                                <span id="sa-qc-status-badge" style="font-size:10px; font-weight:600; padding:2px 8px; border-radius:12px; background:rgba(255,255,255,0.08); color:#94a3b8;">Idle</span>
                            </div>
                            <div style="display:flex; gap:6px;">
                                <button id="sa-qc-copy-btn" class="sa-term-pill" style="font-size:10px; padding:3px 8px;">📋 Copy</button>
                                <button id="sa-qc-clear-btn" class="sa-term-pill" style="font-size:10px; padding:3px 8px; background:rgba(239,68,68,0.1); border-color:rgba(239,68,68,0.3); color:#f87171;">Clear</button>
                            </div>
                        </div>

                        <div class="sa-term-window" id="sa-qc-output" style="height:220px;">Click any option button above to run the command on Jio ODU 52540 via Telnet (192.168.225.1:23).
Results will appear here in real-time.</div>
                    </div>

                    <!-- CUSTOM COMMAND ACCORDION -->
                    <details style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.07); border-radius:12px; padding:8px 12px;">
                        <summary style="cursor:pointer; font-size:12px; font-weight:600; color:#94a3b8; outline:none;">
                            <span>🛠 Custom Terminal Command (Optional)</span>
                        </summary>
                        <div class="sa-term-input-row" style="margin-top:10px;">
                            <span class="sa-term-prompt">root@jodu52540:~#</span>
                            <input type="text" class="sa-term-input" id="sa-term-in" placeholder="e.g. QCMAP_CLI, help, lux_atc 'AT+CSQ'..." autocomplete="off">
                            <button class="sa-term-send-btn" id="sa-term-send">
                                <span>Run</span>
                            </button>
                        </div>
                    </details>

                </div>
            </div>
        </div>`;


        var node = E('div');
        node.innerHTML = html;

        /* ── State ── */
        var isPhone = false;
        var isPro   = false;
        var isLight = false;
        var pollInterval = 10;

        /* ── Helpers ── */
        function wrapper()  { return document.getElementById('cbi-jodu52540'); }
        function container(){ return node.querySelector('.sa-container'); }
        function setToggle(id, on) {
            var t = node.querySelector('#' + id);
            if (t) { if (on) t.classList.add('on'); else t.classList.remove('on'); }
        }
        function closeDrawer() {
            node.querySelector('#sa-drawer').classList.remove('open');
            node.querySelector('#sa-drawer-overlay').classList.remove('open');
        }
        function openDrawer() {
            node.querySelector('#sa-drawer').classList.add('open');
            node.querySelector('#sa-drawer-overlay').classList.add('open');
        }
        function toast(msg, color) {
            var t = document.createElement('div');
            t.textContent = msg;
            t.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(20px);' +
                'background:' + (color || 'rgba(30,41,59,0.96)') + ';color:#f1f5f9;padding:10px 22px;border-radius:999px;' +
                'font-size:13px;font-weight:600;font-family:Inter,sans-serif;z-index:9999;' +
                'box-shadow:0 8px 32px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.1);' +
                'opacity:0;transition:all 0.3s ease;pointer-events:none;white-space:nowrap;';
            document.body.appendChild(t);
            requestAnimationFrame(function() {
                t.style.opacity = '1'; t.style.transform = 'translateX(-50%) translateY(0)';
                setTimeout(function() {
                    t.style.opacity = '0'; t.style.transform = 'translateX(-50%) translateY(10px)';
                    setTimeout(function() { t.parentNode && t.parentNode.removeChild(t); }, 350);
                }, 2400);
            });
        }

        /* ── Header: Refresh ── */
        node.querySelector('#sa-refresh-btn').addEventListener('click', function() {
            updateDashboard();
            toast('↻ Refreshed');
        });

        /* ── Header: Menu open ── */
        node.querySelector('#sa-menu-btn').addEventListener('click', openDrawer);
        node.querySelector('#sa-drawer-close').addEventListener('click', closeDrawer);
        node.querySelector('#sa-drawer-overlay').addEventListener('click', closeDrawer);

        /* ── Drawer: Quick Actions ── */
        node.querySelector('#dr-refresh').addEventListener('click', function() {
            closeDrawer(); updateDashboard(); toast('↻ Refreshed');
        });
        node.querySelector('#dr-odu-login').addEventListener('click', function() {
            window.open('https://192.168.225.1', '_blank'); closeDrawer();
        });
        node.querySelector('#dr-copy-stats').addEventListener('click', function() {
            var fields = [
                'Signal:',    document.getElementById('ui-sig-str')   ? document.getElementById('ui-sig-str').textContent   : '—',
                'Band:',      document.getElementById('ui-op-band')   ? document.getElementById('ui-op-band').textContent   : '—',
                'Mode:',      document.getElementById('ui-op-mode')   ? document.getElementById('ui-op-mode').textContent   : '—',
                'RSRP:',      document.getElementById('ui-rsrp')      ? document.getElementById('ui-rsrp').textContent      : '—',
                'RSRQ:',      document.getElementById('ui-rsrq')      ? document.getElementById('ui-rsrq').textContent      : '—',
                'SNR:',       document.getElementById('ui-snr')       ? document.getElementById('ui-snr').textContent       : '—',
                'BLER:',      document.getElementById('ui-bler')      ? document.getElementById('ui-bler').textContent      : '—',
                'Mod DL:',    document.getElementById('ui-mod')       ? document.getElementById('ui-mod').textContent       : '—',
                'PCI:',       document.getElementById('ui-pci')       ? document.getElementById('ui-pci').textContent       : '—',
                'Status:',    document.getElementById('ui-conn-status') ? document.getElementById('ui-conn-status').textContent : '—',
                'RRC:',       document.getElementById('ui-rrc')       ? document.getElementById('ui-rrc').textContent       : '—',
                'Uptime:',    document.getElementById('ui-uptime')    ? document.getElementById('ui-uptime').textContent    : '—',
                'DL Speed:',  document.getElementById('ui-speed-rx')  ? document.getElementById('ui-speed-rx').textContent  : '—',
                'UL Speed:',  document.getElementById('ui-speed-tx')  ? document.getElementById('ui-speed-tx').textContent  : '—',
            ];
            var txt = 'Jio ODU 52540 Status \n' + new Date().toLocaleString() + '\n\n';
            for (var i = 0; i < fields.length; i += 2) txt += fields[i] + ' ' + fields[i+1] + '\n';
            try {
                navigator.clipboard.writeText(txt).then(function() { toast('✓ Copied to clipboard'); });
            } catch(e) { toast('✗ Clipboard not available'); }
            closeDrawer();
        });

        /* ── Drawer: Display toggles ── */
        node.querySelector('#dr-theme-glass-dark').addEventListener('click', function() {
            var w = wrapper();
            if (isPro)   { w.classList.remove('theme-pro');   isPro   = false; setToggle('tog-pro',   false); }
            if (isLight) { w.classList.remove('theme-light'); isLight = false; setToggle('tog-light', false); }
            setToggle('tog-dark', true);
        });
        node.querySelector('#dr-theme-glass-light').addEventListener('click', function() {
            var w = wrapper();
            if (isPro) { w.classList.remove('theme-pro'); isPro = false; setToggle('tog-pro', false); }
            isLight = !isLight;
            if (isLight) { w.classList.add('theme-light'); setToggle('tog-dark', false); setToggle('tog-light', true); }
            else          { w.classList.remove('theme-light'); setToggle('tog-dark', true);  setToggle('tog-light', false); }
        });
        node.querySelector('#dr-theme-pro').addEventListener('click', function() {
            var w = wrapper();
            if (isLight) { w.classList.remove('theme-light'); isLight = false; setToggle('tog-light', false); }
            isPro = !isPro;
            if (isPro) { w.classList.add('theme-pro');    setToggle('tog-pro', true);  setToggle('tog-dark', false); }
            else       { w.classList.remove('theme-pro'); setToggle('tog-pro', false); setToggle('tog-dark', true); }
        });
        node.querySelector('#dr-phone-view').addEventListener('click', function() {
            isPhone = !isPhone;
            if (isPhone) container().classList.add('phone-view');
            else         container().classList.remove('phone-view');
            setToggle('tog-phone', isPhone);
        });

        /* ── Drawer: Data & Polling ── */
        node.querySelector('#dr-interval-input').addEventListener('change', function() {
            var v = parseInt(this.value, 10);
            if (isNaN(v) || v < 5) v = 5;
            if (v > 300) v = 300;
            this.value = v;
            pollInterval = v;
            var disp = document.getElementById('ui-refresh-interval-display');
            if (disp) disp.textContent = v;
            toast('⏱ Interval set to ' + v + 's');
        });
        node.querySelector('#dr-clear-history').addEventListener('click', function() {
            if (confirm('Clear all locally stored data usage history?')) {
                try { localStorage.removeItem('odu_data_history'); } catch(e) {}
                dataHistory = [];
                toast('🗑 Usage history cleared');
                closeDrawer();
            }
        });
        node.querySelector('#dr-export-json').addEventListener('click', function() {
            try {
                var blob = new Blob([JSON.stringify(dataHistory, null, 2)], { type: 'application/json' });
                var url  = URL.createObjectURL(blob);
                var a    = document.createElement('a');
                a.href = url; a.download = 'odu-usage-' + Date.now() + '.json';
                document.body.appendChild(a); a.click();
                setTimeout(function() { URL.revokeObjectURL(url); a.remove(); }, 1000);
                toast('↓ Downloading JSON…');
            } catch(e) { toast('✗ Export failed: ' + e.message); }
            closeDrawer();
        });

        /* ── Drawer: Experimental ── */
        node.querySelector('#dr-ping-test').addEventListener('click', function() {
            toast('📡 Pinging ODU…');
            var t0 = Date.now();
            fetch('https://192.168.225.1/', { mode: 'no-cors', cache: 'no-store' })
                .then(function() { toast('📡 RTT ≈ ' + (Date.now() - t0) + 'ms'); })
                .catch(function() { toast('📡 RTT ≈ ' + (Date.now() - t0) + 'ms (no-cors)'); });
            closeDrawer();
        });
        node.querySelector('#dr-sms-inbox').addEventListener('click', function() {
            toast('📱 Fetching SMS inbox… (may fail)');
            oduPost('sms').then(function(res) {
                var msg = (res && Object.keys(res).length > 0)
                    ? '📱 SMS: ' + JSON.stringify(res).slice(0, 80)
                    : '⚠️ SMS inbox returned empty (endpoint may be restricted)';
                toast(msg);
            }).catch(function() { toast('✗ SMS fetch failed'); });
            closeDrawer();
        });
        /* ── QCMAP & Modem Control Hub Controller ── */
        var qcmapModal   = node.querySelector('#sa-qcmap-modal');
        var qcOutput     = node.querySelector('#sa-qc-output');
        var qcStatus     = node.querySelector('#sa-qc-status-badge');
        var termIn       = node.querySelector('#sa-term-in');
        var termSend     = node.querySelector('#sa-term-send');
        var qcCopyBtn    = node.querySelector('#sa-qc-copy-btn');
        var qcClearBtn   = node.querySelector('#sa-qc-clear-btn');

        function setQcStatus(txt, bg, color) {
            if (!qcStatus) return;
            qcStatus.textContent = txt;
            qcStatus.style.background = bg || 'rgba(255,255,255,0.08)';
            qcStatus.style.color = color || '#94a3b8';
        }

        function appendToTerminal(type, text) {
            if (!qcOutput) return null;
            // Clear default message on first output
            if (qcOutput.textContent.indexOf('Click any option') > -1) {
                qcOutput.innerHTML = '';
            }
            var div = document.createElement('div');
            div.style.marginBottom = '6px';
            if (type === 'cmd') {
                div.innerHTML = '<span style="color:#a5b4fc; font-weight:700;">root@jodu52540:~# </span><span style="color:#f8fafc;">' + text + '</span>';
            } else if (type === 'wait') {
                div.innerHTML = '<span style="color:#94a3b8; font-style:italic;">' + text + '</span>';
            } else if (type === 'err') {
                div.innerHTML = '<span style="color:#f87171;">' + text + '</span>';
            } else {
                div.innerHTML = '<pre style="margin:0; padding:4px 0; color:#e2e8f0; white-space:pre-wrap; font-family:monospace; font-size:12px; line-height:1.4;">' + text + '</pre>';
            }
            qcOutput.appendChild(div);
            qcOutput.scrollTop = qcOutput.scrollHeight;
            return div;
        }

        function runQcAction(actionKey, customLabel, extraParam) {
            if (!actionKey) return;
            var label = customLabel || actionKey;
            setQcStatus('⏳ Running...', 'rgba(245,158,11,0.2)', '#fbbf24');
            
            appendToTerminal('cmd', label);
            var waitNode = appendToTerminal('wait', '⏱ Connecting to 192.168.225.1:23...');

            if (termSend) termSend.disabled = true;

            oduPost('qcmap', actionKey, extraParam).then(function(res) {
                if (termSend) termSend.disabled = false;
                if (waitNode && waitNode.parentNode) waitNode.parentNode.removeChild(waitNode);

                if (res && res.output && res.status === 'OK') {
                    setQcStatus('🟢 Done', 'rgba(34,197,94,0.2)', '#4ade80');
                    appendToTerminal('out', res.output.trim() || '(No output)');
                } else if (res && res.raw) {
                    setQcStatus('🟢 Done (Raw)', 'rgba(34,197,94,0.2)', '#4ade80');
                    appendToTerminal('out', res.raw);
                } else if (res && res.error) {
                    setQcStatus('🔴 Error', 'rgba(239,68,68,0.2)', '#f87171');
                    appendToTerminal('err', '❌ Error executing command:\n' + res.error);
                } else {
                    setQcStatus('⚠️ Empty', 'rgba(249,115,22,0.2)', '#fb923c');
                    appendToTerminal('err', '⚠️ No response received from ODU at 192.168.225.1:23.');
                }
            }).catch(function(err) {
                if (termSend) termSend.disabled = false;
                if (waitNode && waitNode.parentNode) waitNode.parentNode.removeChild(waitNode);
                setQcStatus('🔴 Failed', 'rgba(239,68,68,0.2)', '#f87171');
                appendToTerminal('err', '❌ Connection failed: ' + String(err));
            });
        }

        // Attach click listeners to all action buttons
        node.querySelectorAll('.sa-qc-btn[data-action]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var action = this.getAttribute('data-action');
                var titleEl = this.querySelector('.sa-qc-title');
                var title = titleEl ? titleEl.textContent : action;
                runQcAction(action, title);
            });
        });

        // Special listener for CDM manual input
        var cdmManualBtn = node.querySelector('#sa-cdm-manual-btn');
        if (cdmManualBtn) {
            cdmManualBtn.addEventListener('click', function() {
                var opt = prompt("Enter Cellular Device Manager option manually (e.g., 07, 10):");
                if (opt && opt.trim()) {
                    runQcAction('cdm_manual', 'CDM (Option ' + opt.trim() + ')', opt.trim());
                }
            });
        }

        // Copy button
        if (qcCopyBtn) {
            qcCopyBtn.addEventListener('click', function() {
                if (!qcOutput || !qcOutput.textContent) return;
                try {
                    navigator.clipboard.writeText(qcOutput.innerText).then(function() {
                        toast('📋 Terminal output copied');
                    });
                } catch(e) {
                    toast('❌ Clipboard write failed');
                }
            });
        }

        // Clear button
        if (qcClearBtn) {
            qcClearBtn.addEventListener('click', function() {
                if (qcOutput) qcOutput.innerHTML = '<span style="color:#64748b; font-style:italic;">Terminal cleared. Type a command or click an action button to start.</span>';
                setQcStatus('Idle', 'rgba(255,255,255,0.08)', '#94a3b8');
            });
        }

        // Custom command input with history
        var cmdHistory = [];
        var cmdHistoryIdx = -1;

        if (termSend) {
            termSend.addEventListener('click', function() {
                if (termIn && termIn.value.trim()) {
                    var val = termIn.value.trim();
                    cmdHistory.push(val);
                    cmdHistoryIdx = cmdHistory.length;
                    runQcAction(val, val);
                    termIn.value = '';
                }
            });
        }

        if (termIn) {
            termIn.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (termIn.value.trim()) {
                        var val = termIn.value.trim();
                        cmdHistory.push(val);
                        cmdHistoryIdx = cmdHistory.length;
                        runQcAction(val, val);
                        termIn.value = '';
                    }
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (cmdHistoryIdx > 0) {
                        cmdHistoryIdx--;
                        termIn.value = cmdHistory[cmdHistoryIdx];
                    }
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (cmdHistoryIdx < cmdHistory.length - 1) {
                        cmdHistoryIdx++;
                        termIn.value = cmdHistory[cmdHistoryIdx];
                    } else {
                        cmdHistoryIdx = cmdHistory.length;
                        termIn.value = '';
                    }
                }
            });
        }

        // Drawer open/close triggers
        node.querySelector('#dr-qcmap-cli').addEventListener('click', function() {
            closeDrawer();
            if (qcmapModal) qcmapModal.classList.add('open');
        });

        node.querySelector('#sa-qcmap-close').addEventListener('click', function() {
            if (qcmapModal) qcmapModal.classList.remove('open');
        });

        if (qcmapModal) {
            qcmapModal.addEventListener('click', function(e) {
                if (e.target === qcmapModal) qcmapModal.classList.remove('open');
            });
        }

        /* ── ODU Configuration Modal Controller ── */
        var configModal  = node.querySelector('#sa-config-modal');
        var configClose  = node.querySelector('#sa-config-close');
        var configCancel = node.querySelector('#sa-config-cancel');
        var configSave   = node.querySelector('#sa-config-save');

        var inHost       = node.querySelector('#cfg-host');
        var inWebUser    = node.querySelector('#cfg-web-user');
        var inWebPass    = node.querySelector('#cfg-web-pass');
        var inTelnetPort = node.querySelector('#cfg-telnet-port');
        var inTelnetUser = node.querySelector('#cfg-telnet-user');
        var inTelnetPass = node.querySelector('#cfg-telnet-pass');

        function openConfigModal() {
            closeDrawer();
            if (configModal) configModal.classList.add('open');
            oduPost('get_config').then(function(cfg) {
                if (cfg && !cfg.error) {
                    if (inHost) inHost.value = cfg.host || '192.168.225.1';
                    if (inWebUser) inWebUser.value = cfg.username || 'Admin';
                    if (inWebPass) inWebPass.value = cfg.password || '';
                    if (inTelnetPort) inTelnetPort.value = cfg.telnet_port || '23';
                    if (inTelnetUser) inTelnetUser.value = cfg.telnet_user || 'root';
                    if (inTelnetPass) inTelnetPass.value = cfg.telnet_password || '';
                }
            });
        }

        function closeConfigModal() {
            if (configModal) configModal.classList.remove('open');
        }

        var cfgBtn = node.querySelector('#sa-config-btn');
        if (cfgBtn) cfgBtn.addEventListener('click', openConfigModal);

        var cfgBadge = node.querySelector('#sa-config-badge');
        if (cfgBadge) cfgBadge.addEventListener('click', openConfigModal);

        var drCfgBtn = node.querySelector('#dr-odu-config');
        if (drCfgBtn) drCfgBtn.addEventListener('click', openConfigModal);

        if (configClose)  configClose.addEventListener('click', closeConfigModal);
        if (configCancel) configCancel.addEventListener('click', closeConfigModal);
        if (configModal) {
            configModal.addEventListener('click', function(e) {
                if (e.target === configModal) closeConfigModal();
            });
        }

        // Toggle password visibility
        function setupEyeToggle(btnId, inputEl) {
            var btn = node.querySelector('#' + btnId);
            if (btn && inputEl) {
                btn.addEventListener('click', function() {
                    inputEl.type = inputEl.type === 'password' ? 'text' : 'password';
                });
            }
        }
        setupEyeToggle('cfg-web-eye', inWebPass);
        setupEyeToggle('cfg-telnet-eye', inTelnetPass);

        // Save configuration
        if (configSave) {
            configSave.addEventListener('click', function() {
                var host = (inHost && inHost.value.trim()) || '192.168.225.1';
                var webUser = (inWebUser && inWebUser.value.trim()) || 'Admin';
                var webPass = (inWebPass && inWebPass.value) || '';
                var telnetPort = (inTelnetPort && inTelnetPort.value.trim()) || '23';
                var telnetUser = (inTelnetUser && inTelnetUser.value.trim()) || 'root';
                var telnetPass = (inTelnetPass && inTelnetPass.value) || '';

                configSave.disabled = true;
                configSave.innerHTML = '<span>Saving…</span>';

                oduPost('set_config', host, webUser, webPass, telnetPass, telnetUser, telnetPort).then(function(res) {
                    configSave.disabled = false;
                    configSave.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg><span>Save Configuration</span>';

                    if (res && res.status === 'OK') {
                        toast('✓ Credentials saved successfully', 'rgba(16,185,129,0.9)');
                        closeConfigModal();
                        sessionToken = null;
                        sessionId = null;
                        updateDashboard();
                    } else {
                        toast('✗ Failed to save: ' + (res.error || 'Unknown error'), 'rgba(239,68,68,0.9)');
                    }
                }).catch(function(err) {
                    configSave.disabled = false;
                    configSave.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg><span>Save Configuration</span>';
                    toast('✗ Error: ' + err, 'rgba(239,68,68,0.9)');
                });
            });
        }

        node.querySelector('#dr-force-reauth').addEventListener('click', function() {
            sessionToken = null; sessionId = null;
            toast('🔒 Session cleared — will re-auth on next poll');
            updateDashboard();
            closeDrawer();
        });
        node.querySelector('#dr-reboot').addEventListener('click', function() {
            if (confirm('\u26A0\uFE0F REBOOT ODU?\n\nThis will cause ~30 seconds of internet outage.')) {
                oduPost('reboot').then(function() { toast('🔄 Reboot sent — ODU restarting…', 'rgba(239,68,68,0.9)'); });
            }
            closeDrawer();
        });

        /* ── Liquid Glass: Spotlight + 3D Tilt ── */
        node.addEventListener('mousemove', function(e) {
            var glowEls = node.querySelectorAll('.sa-hover-glow');
            var tiltEls = node.querySelectorAll('.sa-tilt');
            for (var i = 0; i < glowEls.length; i++) {
                var rect = glowEls[i].getBoundingClientRect();
                glowEls[i].style.setProperty('--mouse-x', (e.clientX - rect.left) + 'px');
                glowEls[i].style.setProperty('--mouse-y', (e.clientY - rect.top) + 'px');
            }
            for (var j = 0; j < tiltEls.length; j++) {
                var r = tiltEls[j].getBoundingClientRect();
                if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
                    var rotY =  ((e.clientX - (r.left + r.width/2))  / (r.width/2))  * 6;
                    var rotX = -((e.clientY - (r.top  + r.height/2)) / (r.height/2)) * 4;
                    tiltEls[j].style.transform = 'perspective(800px) rotateX(' + rotX + 'deg) rotateY(' + rotY + 'deg) translateY(-3px) scale(1.01)';
                } else {
                    tiltEls[j].style.transform = '';
                }
            }
        });
        node.addEventListener('mouseleave', function() {
            node.querySelectorAll('.sa-tilt').forEach(function(el) { el.style.transform = ''; });
        });
        node.addEventListener('touchmove', function(e) {
            var t = e.touches[0];
            node.querySelectorAll('.sa-hover-glow').forEach(function(el) {
                var r = el.getBoundingClientRect();
                el.style.setProperty('--mouse-x', (t.clientX - r.left) + 'px');
                el.style.setProperty('--mouse-y', (t.clientY - r.top)  + 'px');
            });
        }, { passive: true });

        /* ── Start polling ── */
        updateDashboard();
        poll.add(function() { return updateDashboard(); }, pollInterval);

        return node;
    }
});
