// proclist-core.js — Procedure 清單共用模組（opd.html 🗂 tab + index.html 🗂 面板共用）
// 設計約束：
//   ① 頂層零 import —— Firebase 函式由 createProcList(deps) 注入，node 可直接 import 本檔跑迴歸測試
//   ② deriveProcRows / buildSchedRows 是純函數（export），推導規則只住這裡一份
//   ③ 樣式由 injectStyles() 自注入（proc 專屬樣式的唯一來源；opd.css 已移除該區塊）
//   ④ 純函數 helper（escapeHtml/normalizeTag/isRealDate…）是 opd.html 的「私有複本」——
//      opd.html 其餘功能仍用自己那份；改 helper 語義時兩邊都要看（見 CLAUDE.md 模組邊界）

// ===== 私有純函數 =====
function formatDate(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}
function isRealDate(y, mo, dd) {
    const dt = new Date(y, mo - 1, dd);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === dd;
}
function normalizeTag(t) {
    if (t === 'follow up') return 'f/u';
    if (t === 'NB') return 'CT NB';
    if (t === 'MRI') return 'CT/MRI';
    if (/^CT\s*(?:biopsy|bx)$/i.test(t)) return 'CT Bx';
    return t;
}
function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) {
    return String(s ?? '').replace(/"/g, '&quot;');
}
const DISCUSS_PATTERN = /\b(consider|may|discuss|favor|build|建議|考慮|可能|可考慮|商量|討論)\b/i;
function lineHasInvalidDate(line) {
    const re = /(^|[^\d./])(?:(\d{2,4})\/)?(\d{1,2})\/(\d{1,2})(?![\d./])/g;
    let m;
    while ((m = re.exec(line)) !== null) {
        const mo = parseInt(m[3], 10), dd = parseInt(m[4], 10);
        const y = m[2] ? (m[2].length === 2 ? 2000 + parseInt(m[2], 10) : parseInt(m[2], 10)) : 2024;
        if (!isRealDate(y, mo, dd)) return true;
    }
    return false;
}
function pickBadgeClass(c) {
    if (/^(本次|today|本日)$/i.test(c)) return 'ib-anchor';
    if (/自費|self[\s-]?pa[iy]d/i.test(c)) return 'ib-selfpay';
    if (/^BMA$/i.test(c)) return 'ib-bma';
    if (/鬆.*已|鬆.*done/i.test(c)) return 'ib-songyi';
    if (/鬆.*待|鬆.*pending/i.test(c)) return 'ib-pending';
    if (/MRI.*已/i.test(c)) return 'ib-mriyi';
    if (/MRI.*待/i.test(c)) return 'ib-pending';
    if (/CT\s*NB.*已/i.test(c)) return 'ib-ctnbyi';
    if (/CT\s*NB.*待/i.test(c)) return 'ib-pending';
    if (/SONO.*PM/i.test(c)) return 'ib-sonopm';
    if (/SONO.*約/i.test(c)) return 'ib-sonoyue';
    if (/TAME.*已/i.test(c)) return 'ib-done';
    if (/TAME.*待/i.test(c)) return 'ib-pending';
    if (/^已$|^done$/i.test(c)) return 'ib-done';
    if (/^待$|^pending$/i.test(c)) return 'ib-pending';
    if (/^PM$/i.test(c)) return 'ib-pm';
    if (/^AM$/i.test(c)) return 'ib-am';
    if (/^約$|^appt$/i.test(c)) return 'ib-appt';
    if (/已$|done$/i.test(c)) return 'ib-done';
    if (/待$|pending$/i.test(c)) return 'ib-pending';
    if (/PM$/i.test(c)) return 'ib-pm';
    if (/AM$/i.test(c)) return 'ib-am';
    if (/約$/i.test(c)) return 'ib-appt';
    return 'ib-gray';
}
function highlightPlanLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return '';
    let cls = '';
    if (trimmed.startsWith('*')) cls = 'plan-line done';
    else if (trimmed.startsWith('-')) cls = 'plan-line plan';
    else if (/RTC/i.test(trimmed)) cls = 'plan-line rtc-line';
    const escaped = escapeHtml(trimmed);
    const withBadges = escaped.replace(/\[([^\]\n]{1,16})\]/g, (_, content) => {
        const c = content.trim();
        return `<span class="inline-badge ${pickBadgeClass(c)}">${escapeHtml(c)}</span>`;
    });
    if (lineHasInvalidDate(trimmed)) {
        return `<span class="${cls} date-invalid" title="此行含不存在的日期（如 4/31），不會被當作 RTC / 排程日期">⚠ ${withBadges}</span>`;
    }
    return `<span class="${cls}">${withBadges}</span>`;
}
// 規律門診日 = 該月第 2 / 第 4 個週三（user 的雙週三門診）——deterministic，不受資料污染
function getNthWednesdayOfMonth(year, month, n) {
    const d = new Date(year, month - 1, 1);
    let count = 0;
    while (d.getMonth() === month - 1) {
        if (d.getDay() === 3) { count++; if (count === n) return new Date(d); }
        d.setDate(d.getDate() + 1);
    }
    return null;
}
function isRegularClinicDate(dateStr) {
    const [y, m] = dateStr.split('-').map(Number);
    const dt = new Date(dateStr + 'T00:00');
    if (dt.getDay() !== 3) return false;
    const w2 = getNthWednesdayOfMonth(y, m, 2);
    const w4 = getNthWednesdayOfMonth(y, m, 4);
    return (w2 && formatDate(w2) === dateStr) || (w4 && formatDate(w4) === dateStr);
}
function displayAgeSex(patient, refDate) {
    if (patient?.birthYear) {
        const refYear = refDate ? new Date(refDate).getFullYear() : new Date().getFullYear();
        return `${refYear - patient.birthYear}/${patient.sex || ''}`;
    }
    return patient?.ageSex || '';
}
const ANTICOAG_HOLD_DAYS = {
    'Aspirin':      '1–2d',
    'Plavix':       '5d',
    'Lixiana':      '2–3d',
    'Eliquis':      '2–3d',
    'Xarelto':      '2–3d',
    'Pradaxa':      '2–3d',
    'Warfarin':     '依 INR',
    'Dipyridamole': '2d'
};
function getAnticoagHold(name) {
    const key = Object.keys(ANTICOAG_HOLD_DAYS).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? ANTICOAG_HOLD_DAYS[key] : '?';
}
const EGFR_PATTERN = /^\s*[><=]?\s*\d+(\.\d+)?\s*$/;
function isValidEGFR(val) { return EGFR_PATTERN.test(val || ''); }
function extractLabsStructured(text) {
    let rest = String(text || '');
    const cut = (m) => { rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length); };
    let eGFR = '', eGFRDate = '', INR = '', INRDate = '';
    const egM = rest.match(/\beGFR[:：]?\s*([><=]?\s*\d+(?:\.\d+)?)(?:\s*[（(]((?:\d{2}\/)?\d{1,2}\/\d{1,2})[)）]|\s+((?:\d{2}\/)?\d{1,2}\/\d{1,2})\b)?/i);
    if (egM) { eGFR = egM[1].replace(/\s+/g, ''); eGFRDate = egM[2] || egM[3] || ''; cut(egM); }
    const inrM = rest.match(/\bINR[:：]?\s*(\d+(?:\.\d+)?)(?:\s*[（(]((?:\d{2}\/)?\d{1,2}\/\d{1,2})[)）]|\s+((?:\d{2}\/)?\d{1,2}\/\d{1,2})\b)?/i);
    if (inrM) { INR = inrM[1]; INRDate = inrM[2] || inrM[3] || ''; cut(inrM); }
    rest = rest.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').replace(/^[\s/、,，;；]+|[\s/、,，;；]+$/g, '').trim();
    return { eGFR, eGFRDate, INR, INRDate, rest };
}
function buildLabsDisplay(p) {
    if (!p) return '';
    const lifted = extractLabsStructured(p.labs || '');
    const eg = (isValidEGFR(p.eGFR) ? p.eGFR : '') || lifted.eGFR;
    const inr = p.INR || lifted.INR;
    const egDt = p.eGFRDate || lifted.eGFRDate || p.labsDate || '';
    const inrDt = p.INRDate || lifted.INRDate || p.labsDate || '';
    const bits = [];
    if (eg) bits.push(`eGFR ${eg}${egDt ? ` (${egDt})` : ''}`);
    if (inr) bits.push(`INR ${inr}${inrDt ? ` (${inrDt})` : ''}`);
    const head = bits.join(' · ');
    const other = (lifted.eGFR || lifted.INR) ? lifted.rest : (p.labs || '');
    return [head, other].filter(Boolean).join('\n');
}
// 抽血顯示的日期縮小淡化（「eGFR 55 (6/24)」的 (6/24)）——配角，不搶版面；吃已 escape 的字串
function fmtLabDates(escapedText) {
    return escapedText.replace(/\(((?:\d{2}\/)?\d{1,2}\/\d{1,2})\)/g, '<span class="plc-lab-date">($1)</span>');
}
// 「[本次] → 回診」切段（跟 index.html 舊 caselist 的 slicePlanThisVisit 同款）
function slicePlanThisVisit(plan) {
    const lines = (plan || '').split(/\r?\n/);
    const start = lines.findIndex(l => /\[本次\]/.test(l));
    if (start < 0) return (plan || '').trim();
    let end = lines.length - 1;
    for (let i = start + 1; i < lines.length; i++) {
        if (/回診/.test(lines[i])) { end = i; break; }
    }
    return lines.slice(start, end + 1).join('\n').trim();
}

// ===== 常量 =====
const PROC_LINE_RES = [
    { name: 'CT Bx', re: /\bCT\s*(?:biopsy|bx)\b/i },
    { name: 'CT NB', re: /\bCT\s*NB\b/i },
    { name: 'pRF',   re: /\bp?RF\b/ },
    { name: 'SONO',  re: /\bSONO\b/i },
    { name: 'cTAME', re: /\bcTAME\b/i },
    { name: 'sTAME', re: /\bsTAME\b/i },
    { name: 'TAME',  re: /\bTAME\b/i }   // generic 殿後；c/sTAME 命中就不收
];
const PROC_ST_META = {
    pending: { label: '⏳ 待做', next: 'done' },
    done:    { label: '✅ 完成', next: 'dc' },
    dc:      { label: '⊘ DC',   next: 'pending' }
};
const PROC_MED_META = { '': '－', pending: '🟠 未領', collected: '🟢 已領' };
const PROC_FAMILIES = [['CT NB', 'pRF'], ['TAME', 'cTAME', 'sTAME'], ['SONO'], ['CT Bx']];
const SCHED_TYPE_TAGS = { 'sono': ['SONO'], 'ct-nb': ['CT NB'], 'ct-nb-prf': ['CT NB', 'pRF'], 'stame': ['sTAME'], 'ctame': ['cTAME'], 'arthro': ['Arthro'], 'mri': ['MRI'], 'ct': ['CT'] };

// ===== 純推導（export：opd buildProcHistory + 迴歸測試用）=====
// 核心規則（第三版「錨點段落法」，決策見 DECISION_LOG 2026-07-08）：只掃「最後一個本次錨點起」的段落。
// 錨點三訊號：① [本次] 標記 ② visit 自身日期的 RTC 行 ③ 行首是 visit 自身日期的行。都沒有 → 整份 fallback。
// tag 家族閘 = 軟標 ⚠；era 錨（行內帶年日期定同行年代）；無年無 era 早逾半年 → 補明年。
export function deriveProcRows(allByDate) {
    const todayStr = formatDate(new Date());
    const undated = new Map();
    const datedGlobal = new Set();
    const recent60 = formatDate(new Date(Date.now() - 60 * 86400000));
    const candidates = [];

    Object.keys(allByDate).forEach(vDate => {
        Object.values(allByDate[vDate] || {}).forEach(v => {
            if (!v || v.noShow || !v.recordNumber) return;
            const vTags = new Set((v.tags || []).map(normalizeTag));
            const tagAllowed = (t) => (PROC_FAMILIES.find(f => f.includes(t)) || [t]).some(x => vTags.has(x));
            const planLines = (v.plan || '').split(/\r?\n/);
            let anchorIdx = -1;
            const vYr = parseInt(vDate.slice(0, 4), 10), vMo = parseInt(vDate.slice(5, 7), 10), vDd = parseInt(vDate.slice(8, 10), 10);
            const selfDateHead = new RegExp(`^[-*\\s]*(?:${String(vYr).slice(2)}\\/)?0?${vMo}\\/0?${vDd}\\b`);
            planLines.forEach((l, i) => {
                if (/\[本次\]/.test(l)) { anchorIdx = i; return; }
                const m = l.match(/(?:(\d{2})\/)?(\d{1,2})\/(\d{1,2})\s*RTC/i);
                if (m && parseInt(m[2], 10) === vMo && parseInt(m[3], 10) === vDd && (!m[1] || 2000 + parseInt(m[1], 10) === vYr)) {
                    anchorIdx = i;
                    return;
                }
                if (selfDateHead.test(l.trim())) anchorIdx = i;
            });
            const scanLines = anchorIdx >= 0 ? planLines.slice(anchorIdx) : planLines;
            scanLines.forEach(line => {
                const t = line.trim();
                if (!t) return;
                if (t.startsWith('-') && DISCUSS_PATTERN.test(t)) return; // 討論/規劃行不算排定
                const tags = [];
                for (const k of PROC_LINE_RES) {
                    if (!k.re.test(t)) continue;
                    if (k.name === 'TAME' && (tags.includes('cTAME') || tags.includes('sTAME'))) continue;
                    tags.push(k.name);
                }
                if (!tags.length) return;
                // 先剝掉「X/Y RTC」的日期 —— 「07/09 RTC, 07/18 15:00 SONO」要取 07/18 不是回診日
                const tForDate = t.replace(/(?:\d{2}\/)?\d{1,2}\/\d{1,2}\s*RTC\??/gi, '');
                let eraYear = null;
                const eraRe = /\b(\d{2})\/(\d{1,2})\/(\d{1,2})\b/g;
                let em;
                while ((em = eraRe.exec(tForDate)) !== null) {
                    const y = 2000 + parseInt(em[1], 10);
                    if (eraYear === null || y < eraYear) eraYear = y;
                }
                const futureDates = [];
                const dre = /\b(?:(\d{2})\/)?(\d{1,2})\/(\d{1,2})\b/g;
                let dm;
                while ((dm = dre.exec(tForDate)) !== null) {
                    const yy0 = dm[1] ? 2000 + parseInt(dm[1], 10) : (eraYear ?? parseInt(vDate.slice(0, 4), 10));
                    const mo = parseInt(dm[2], 10), dd = parseInt(dm[3], 10);
                    if (!isRealDate(yy0, mo, dd)) continue;
                    let iso = `${yy0}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
                    // 無年份、無 era 錨、比 visit 日早逾半年 → 視為明年（系列治療跨年）
                    if (!dm[1] && eraYear === null && iso < vDate && (parseInt(vDate.slice(5, 7), 10) - mo) >= 6) {
                        iso = `${yy0 + 1}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
                    }
                    if (iso > vDate && !futureDates.includes(iso)) futureDates.push(iso);
                }
                const gated = tags.filter(tagAllowed);
                if (futureDates.length) {
                    tags.forEach(tg => datedGlobal.add(v.recordNumber + '|' + tg));
                    const autoDone = /^\*/.test(t) || /\[[^\]]*已\s*\]/.test(t);
                    const tm = tForDate.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
                    const lineTime = tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : '';
                    futureDates.forEach(ld => candidates.push({
                        rec: v.recordNumber, procDate: ld,
                        tags: gated.length ? [...gated] : [...tags],
                        noTag: !gated.length, time: lineTime,
                        srcDate: vDate, srcVisit: v, line: t, autoDone
                    }));
                } else if (v.status === 'confirmed' && vDate >= recent60 && /待|約/.test(t) && !/已/.test(t)) {
                    // 漏網偵測：門診看完（確）應該都約好了 → 還有「待/約」無日期 = 掉出流程
                    gated.forEach(tg => {
                        const uk = v.recordNumber + '|' + tg;
                        const prev = undated.get(uk);
                        if (!prev || vDate > prev.srcDate) {
                            undated.set(uk, { rec: v.recordNumber, procDate: null, tags: [tg], srcDate: vDate, srcVisit: v, line: t });
                        }
                    });
                }
            });
        });
    });

    // 合併（同病人同日多來源）
    const rows = new Map();
    candidates.forEach(c => {
        const key = c.rec + '|' + c.procDate;
        const prev = rows.get(key);
        if (!prev) {
            rows.set(key, c);
        } else {
            if (c.srcDate > prev.srcDate) { prev.srcDate = c.srcDate; prev.srcVisit = c.srcVisit; prev.line = c.line; prev.autoDone = c.autoDone; }
            if (!prev.time && c.time) prev.time = c.time;
            prev.tags = [...new Set([...prev.tags, ...c.tags])];
            prev.noTag = prev.noTag && c.noTag;
        }
    });
    const undatedRows = [...undated.values()].filter(r => !datedGlobal.has(r.rec + '|' + r.tags[0]));
    return { dated: [...rows.values()].sort((a, b) => a.procDate.localeCompare(b.procDate) || a.rec.localeCompare(b.rec)), undated: undatedRows, todayStr };
}

// 排程原生 rows（SONO INJ 等常只排在排程格，OPD plan 無對應行）。唯讀鏡射 scheduler 節點；
// 舊 caselist 的 status/planScratch/Arthro 四欄位經 cellCaseId 連結當 fallback
export function buildSchedRows(sched) {
    const clByCaseId = {};
    Object.values(sched.caseList || {}).forEach(tabRows => {
        Object.values(tabRows || {}).forEach(r => { if (r && r.cellCaseId) clByCaseId[r.cellCaseId] = r; });
    });
    const rows = [];
    Object.entries(sched.cells || {}).forEach(([cellKey, cell]) => {
        const m = cellKey.match(/^(\d{4}-\d{2}-\d{2})-(AM|PM)$/);
        if (!m || !cell) return;
        const cases = Array.isArray(cell.cases) ? cell.cases : Object.values(cell.cases || {});
        cases.forEach(c => {
            if (!c || c.isEmpty || !c.type || c.type === 'slot' || c.type === 'note') return;
            let tags = SCHED_TYPE_TAGS[c.type];
            if (!tags) {
                if (c.type === 'other') tags = [c.otherSubtype || 'Other'];
                else return;
            }
            const cl = c.id ? clByCaseId[c.id] : null;
            rows.push({
                rec: String(c.chartNo || '').trim().toUpperCase(),
                procDate: m[1],
                time: c.time || '',
                tags: [...tags], noTag: false, autoDone: false,
                tentative: c.status === 'tentative', // 排程暫定 → 「待排」視圖專屬，不進主清單
                sched: true, schedCase: c, cellKey,
                fallbackStatus: cl?.status === 'done' ? 'done' : (cl?.status === 'dc' ? 'dc' : null),
                planScratch: (cl?.planScratch || '').trim(),
                // Arthro 四欄位住在舊 caselist row 上（不在排程 case）——當 fallback 顯示；編輯走 procTrackSched overlay
                arthro: c.type === 'arthro' && cl ? { region: cl.arthroRegion || '', weight: cl.arthroWeight || '', mriTime: cl.arthroMriTime || '', contrast: cl.arthroContrast || '' } : null,
                srcDate: m[1], srcVisit: null, line: c.note || ''
            });
        });
    });
    return rows;
}

// ===== 樣式自注入（proc 專屬樣式唯一來源 + index 頁需要的共用視覺子集複本）=====
// CSS 變數全帶 fallback（opd 暗色預設值）：host 頁有同名變數就跟主題走，沒有也不破版
const PLC_CSS = `
/* --- Procedure 清單（proclist-core.js 注入；勿在 host CSS 重複定義） --- */
.pv-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.pv-chip { padding: 6px 14px; background: var(--bg-secondary,#1e293b); border: 1px solid var(--border,#475569); color: var(--text-secondary,#94a3b8); border-radius: 16px; font-family: inherit; font-size: 0.85rem; cursor: pointer; }
.pv-chip.active { background: rgba(99,102,241,0.2); border-color: var(--color-tag-default,#6366f1); color: var(--text-primary,#f1f5f9); font-weight: 600; }
.proc-table-wrapper { overflow-x: auto; }
.proc-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 0.85rem; }
.proc-table col.pc-c-date { width: 82px; }
.proc-table col.pc-c-rec { width: 118px; }
.proc-table col.pc-c-labs { width: 170px; }
.proc-table col.pc-c-tags { width: 130px; }
.proc-table col.pc-c-st { width: 86px; }
.proc-table col.pc-c-med { width: 74px; }
/* pc-c-plan 不設寬 → 自動吃剩餘空間 */
.proc-table th { background: var(--bg-tertiary,#334155); color: var(--text-primary,#f1f5f9); padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border,#475569); position: sticky; top: 0; z-index: 1; }
.proc-table td { padding: 6px 8px; border-bottom: 1px solid var(--border,#475569); vertical-align: top; word-break: break-word; }
.proc-table .pc-c-labs { white-space: pre-line; font-size: 0.78rem; color: var(--text-secondary,#94a3b8); }
.pc-plan-body { line-height: 1.5; font-size: 0.82rem; }
.pc-ac { margin-top: 3px; font-size: 0.7rem; }
.pc-notag { background: rgba(251,191,36,0.2); border: 1px solid rgba(251,191,36,0.5); color: #fbbf24; padding: 0 5px; border-radius: 6px; font-size: 0.7rem; cursor: help; }
.pc-time { display: block; font-size: 0.78rem; font-weight: 600; color: var(--color-info,#3b82f6); font-variant-numeric: tabular-nums; }
/* 類別列色（沿用舊 caselist 語彙）：檢查紫 / Arthro 黃；完成時保留類別色只淡化（不變綠） */
.pc-row.pc-cat-image td { background: rgba(196,181,253,0.16); }
.pc-row.pc-cat-arthro td { background: rgba(253,224,71,0.13); }
.pc-row.pc-cat-image.pc-done td { background: rgba(196,181,253,0.16); opacity: 0.75; }
.pc-row.pc-cat-arthro.pc-done td { background: rgba(253,224,71,0.13); opacity: 0.75; }
.pc-med-ro { display: inline-block; opacity: 0.85; cursor: default; }
.pc-card-ac { margin-top: 4px; font-size: 0.82rem; }
.pc-row.pc-done td { background: rgba(34,197,94,0.14); }
.pc-row.pc-dc td { background: rgba(148,163,184,0.15); opacity: 0.65; }
.pc-row.pc-overdue td:first-child { box-shadow: inset 4px 0 0 0 #ef4444; } /* 紅左緣 = 過期未完成 */
.pc-group-row td { background: var(--bg-tertiary,#334155); font-weight: 600; font-size: 0.8rem; color: var(--text-secondary,#94a3b8); }
.pc-group-row.pc-group-today td { color: #4ade80; }
.pc-group-row.pc-group-warn td { color: #fbbf24; }
.pc-st, .pc-med { border: 1px solid var(--border,#475569); border-radius: 4px; background: var(--bg-secondary,#1e293b); color: var(--text-primary,#f1f5f9); font-family: inherit; font-size: 0.78rem; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
.pc-st-done { background: rgba(34,197,94,0.3); border-color: rgba(34,197,94,0.5); }
.pc-st-dc { background: rgba(148,163,184,0.3); color: var(--text-muted,#64748b); }
.pc-med-pending { background: rgba(234,88,12,0.3); border-color: #ea580c; }
.pc-med-collected { background: rgba(74,222,128,0.3); border-color: #4ade80; }
/* Arthro 四欄位 inline 編輯（桌面）：存 opd/procTrackSched overlay */
.plc-arthro-row { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; font-size: 0.8rem; color: var(--text-secondary,#94a3b8); }
.plc-arthro-in { background: var(--bg-primary,#0f172a); border: 1px solid var(--border,#475569); color: var(--text-primary,#f1f5f9); border-radius: 4px; padding: 2px 6px; font-family: inherit; font-size: 0.82rem; }
/* 註記（清單小筆記，不寫回 plan）：虛線框 = 可寫的備註槽；手機唯讀顯示 */
.plc-note-in { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; background: transparent; border: 1px dashed var(--border,#475569); color: var(--text-primary,#f1f5f9); border-radius: 4px; padding: 2px 6px; font-family: inherit; font-size: 0.78rem; }
.plc-note-in::placeholder { color: var(--text-muted,#64748b); opacity: 0.55; }
.plc-note-in:focus { border-style: solid; border-color: var(--color-info,#3b82f6); outline: none; }
.plc-scope .plc-note-ro { margin-top: 4px; font-size: 0.9em; color: var(--text-secondary,#94a3b8); }
.proc-desktop { display: block; }
.proc-mobile { display: none; }
/* 直立醫院螢幕（≤1280）：側欄收窄，plan 自動變寬 */
@media (max-width: 1280px) {
    .proc-table col.pc-c-labs { width: 130px; }
    .proc-table col.pc-c-tags { width: 100px; }
}
@media (max-width: 768px) {
    .proc-desktop { display: none; }
    .proc-mobile { display: block; padding-bottom: 40px; }
    .pc-group-header { padding: 10px 4px 4px; font-weight: 600; font-size: 0.9rem; color: var(--text-secondary,#94a3b8); border-bottom: 1px solid var(--border,#475569); }
    .pc-group-header.pc-group-today { color: #4ade80; }
    .pc-group-header.pc-group-warn { color: #fbbf24; }
    .pc-card { background: var(--bg-secondary,#1e293b); border: 1px solid var(--border,#475569); border-radius: 10px; padding: 10px 12px; margin-top: 8px; }
    .pc-card.pc-done { background: rgba(34,197,94,0.12); }
    .pc-card.pc-dc { opacity: 0.55; }
    .pc-card.pc-overdue { border-left: 4px solid #ef4444; border-radius: 0 10px 10px 0; }
    .pc-card.pc-cat-image { border-left: 4px solid #c4b5fd; border-radius: 0 10px 10px 0; }
    .pc-card.pc-cat-arthro { border-left: 4px solid #fde047; border-radius: 0 10px 10px 0; }
    .pc-card-date .pc-time { display: inline; margin-left: 5px; }
    .pc-card-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .pc-card-date { font-weight: 700; color: var(--color-info,#3b82f6); font-size: 1rem; }
    .pc-card-rec { font-weight: 600; font-size: 1rem; }
    .pc-card-name { color: var(--text-secondary,#94a3b8); font-size: 0.85rem; }
    .pc-card-labs { color: var(--text-secondary,#94a3b8); font-size: 0.85rem; margin-top: 3px; }
    .pc-card-plan { border-top: 1px dashed var(--border,#475569); margin-top: 7px; padding-top: 7px; font-size: 1rem; line-height: 1.55; word-break: break-word; }
    .pc-card-actions { display: flex; gap: 8px; margin-top: 8px; }
    .pc-card-actions .pc-st, .pc-card-actions .pc-med { flex: 1; min-height: 40px; font-size: 0.9rem; }
}
/* --- 共用視覺子集複本（index 頁沒有 opd.css；opd 頁重複定義同值無害） --- */
.plc-scope .visit-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.plc-scope .visit-tags .tag-chip { display: inline-flex; padding: 0px 5px; border-radius: 8px; font-size: 0.65rem; color: white; white-space: nowrap; }
.plc-scope .visit-tags .tag-chip[data-tag="鬆"] { background: #a855f7; }
.plc-scope .visit-tags .tag-chip[data-tag="CT NB"] { background: #f59e0b; color: #1a1a2e; }
.plc-scope .visit-tags .tag-chip[data-tag="CT Bx"] { background: #c2410c; color: #fff; }
.plc-scope .visit-tags .tag-chip[data-tag="SONO"] { background: #22c55e; }
.plc-scope .visit-tags .tag-chip[data-tag="TAME"] { background: #3b82f6; }
.plc-scope .visit-tags .tag-chip[data-tag="cTAME"] { background: #1e40af; }
.plc-scope .visit-tags .tag-chip[data-tag="sTAME"] { background: #60a5fa; color: #0f172a; }
.plc-scope .visit-tags .tag-chip[data-tag="MRI"] { background: #c4b5fd; color: #1a1a2e; }
.plc-scope .visit-tags .tag-chip[data-tag="CT/MRI"] { background: #c4b5fd; color: #1a1a2e; }
.plc-scope .visit-tags .tag-chip[data-tag="PRP"] { background: #ec4899; }
.plc-scope .visit-tags .tag-chip[data-tag="f/u"] { background: #64748b; }
.plc-scope .visit-tags .tag-chip[data-tag="med"] { background: #f97316; }
.plc-scope .visit-tags .tag-chip[data-tag="回診"] { background: #6366f1; }
.plc-scope .visit-tags .tag-chip[data-tag="自費"] { background: #eab308; color: #1a1a2e; }
.plc-scope .visit-tags .tag-chip[data-tag="pRF"] { background: #fb923c; }
.plc-scope .visit-tags .tag-chip[data-tag="HA"] { background: #14b8a6; }
.plc-scope .visit-tags .tag-chip[data-tag="BMA"] { background: #d946ef; }
.plc-scope .visit-tags .tag-chip[data-tag="Arthro"] { background: #ec4899; }
.plc-scope .visit-tags .tag-chip[data-tag="CT"] { background: #818cf8; color: #1a1a2e; }
.plc-scope .ac-icon { display: inline-flex; padding: 1px 6px; border-radius: 4px; font-size: 0.8rem; font-weight: 600; }
.plc-scope .ac-icon.ac-yes { background: rgba(239,68,68,0.2); color: #fca5a5; border: 1px solid rgba(239,68,68,0.4); }
.plc-scope .ac-icon.ac-none { background: rgba(34,197,94,0.18); color: #86efac; border: 1px solid rgba(34,197,94,0.4); }
.plc-scope .ac-icon.ac-unknown { background: rgba(251,191,36,0.2); color: #fde68a; border: 1px solid rgba(251,191,36,0.4); }
.plc-scope .pill.expandable { position: relative; overflow: visible; display: inline-block !important; max-width: 100%; min-width: 0; box-sizing: border-box; vertical-align: middle; cursor: help; }
.plc-scope .pill.expandable > .pill-text { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.plc-scope .pill.expandable:hover::after { content: attr(data-full); position: absolute; bottom: calc(100% + 8px); top: auto; left: 0; background: linear-gradient(135deg, #2e1d4d 0%, #1e1b3a 100%); border: 1.5px solid #a855f7; color: #f3e8ff; padding: 8px 12px; border-radius: 6px; white-space: pre-wrap; width: max-content; max-width: 420px; box-shadow: 0 6px 18px rgba(168,85,247,0.3); font-size: 0.84rem; font-weight: 400; z-index: 100; line-height: 1.45; text-align: left; pointer-events: none; }
.plc-scope .plan-line.done { color: #86efac; }
.plc-scope .plan-line.plan { color: var(--text-secondary,#94a3b8); }
.plc-scope .plan-line.rtc-line { color: #93c5fd; font-weight: 500; }
.plc-scope .inline-badge { display: inline-block; padding: 0 4px; border-radius: 3px; font-size: 0.75rem; font-weight: 600; margin: 0 2px; line-height: 1.4; }
.plc-scope .inline-badge.ib-done { background: rgba(253,230,138,0.85); color: #78350f; }
.plc-scope .inline-badge.ib-pending { background: rgba(251,207,232,0.85); color: #831843; }
.plc-scope .inline-badge.ib-pm { background: rgba(191,219,254,0.85); color: #1e3a8a; }
.plc-scope .inline-badge.ib-am { background: rgba(199,210,254,0.85); color: #3730a3; }
.plc-scope .inline-badge.ib-appt { background: rgba(251,146,60,0.85); color: #7c2d12; }
.plc-scope .inline-badge.ib-gray { background: rgba(148,163,184,0.5); color: var(--text-primary,#f1f5f9); }
.plc-scope .inline-badge.ib-songyi { background: rgba(253,230,138,0.85); color: #78350f; }
.plc-scope .inline-badge.ib-mriyi { background: rgba(196,181,253,0.85); color: #4c1d95; }
.plc-scope .inline-badge.ib-ctnbyi { background: rgba(251,146,60,0.85); color: #7c2d12; }
.plc-scope .inline-badge.ib-sonopm { background: rgba(96,165,250,0.85); color: #1e3a8a; }
.plc-scope .inline-badge.ib-sonoyue { background: rgba(59,130,246,0.9); color: #ffffff; }
.plc-scope .inline-badge.ib-selfpay { background: rgba(234,179,8,0.9); color: #1a1a2e; }
.plc-scope .inline-badge.ib-bma { background: rgba(217,70,239,0.85); color: #ffffff; }
.plc-scope .inline-badge.ib-anchor { background: rgba(99,102,241,0.7); color: white; font-weight: 700; padding: 1px 8px; box-shadow: 0 0 0 1px #6366f1 inset; }
.plc-scope .record-line.clickable { cursor: pointer; text-decoration: underline dashed rgba(255,255,255,0.25); }
.plc-scope .record-line.clickable:hover { color: #c7d2fe; }
.plc-scope .age-line { font-size: 0.75rem; color: var(--text-muted,#64748b); }
.plc-scope .empty-hint { text-align: center; color: var(--text-muted,#64748b); padding: 60px 20px; font-size: 0.95rem; }
.plc-scope .plc-lab-date { font-size: 0.82em; color: var(--text-muted,#64748b); }
.plc-scope .date-invalid { text-decoration: underline wavy #ef4444; text-underline-offset: 3px; }
/* light 主題補色（host 有 data-theme 才生效） */
:root[data-theme="light"] .plc-scope .ac-icon.ac-yes { color: #991b1b; }
:root[data-theme="light"] .plc-scope .ac-icon.ac-none { color: #166534; }
:root[data-theme="light"] .plc-scope .ac-icon.ac-unknown { color: #92400e; }
:root[data-theme="light"] .plc-scope .plan-line.done { color: #166534; }
:root[data-theme="light"] .plc-scope .plan-line.rtc-line { color: #1e40af; }
:root[data-theme="light"] .plc-scope .pill.expandable:hover::after { background: #ffffff; border-color: #7c3aed; color: #1e1b4b; box-shadow: 0 6px 18px rgba(124,58,237,0.25); }
`;
function injectStyles() {
    if (typeof document === 'undefined' || document.getElementById('plc-styles')) return;
    const st = document.createElement('style');
    st.id = 'plc-styles';
    st.textContent = PLC_CSS;
    document.head.appendChild(st);
}

// ===== 工廠 =====
// deps: {
//   fb: { db, ref, get, update }                       — 必填
//   getAllVisits: async () => allByDate                — 選填；缺省自建 TTL 5min cache（index 頁用）
//   getPatients: () => patientsMap                     — 選填；缺省自建 TTL 5min cache
//   jumpToVisit: (date, rec) => void                   — 選填；缺省病歷號不可點
//   setStatus: (msg) => void / reportError: (err, label) => void — 選填
//   ids: { list, range, chips, status }                — 選填；缺省沿用 opd 的 proc-* id
// }
export function createProcList(deps) {
    const fb = deps.fb;
    const ids = Object.assign({ list: 'proc-list', range: 'proc-range', chips: 'proc-view-chips', status: 'proc-status' }, deps.ids || {});
    const setStatus = deps.setStatus || (() => {});
    const reportError = deps.reportError || ((err, label) => alert(`${label} 寫入失敗：${err?.message || err}`));
    const jump = deps.jumpToVisit || null;
    injectStyles();

    // 內部 fallback caches（index 頁沒有 host cache 時自理；opd 頁走 deps 注入的 getCachedAllVisits / state.patients）
    const TTL = 5 * 60 * 1000;
    let _visitsCache = null, _patientsCache = null, _schedCache = null;
    let _procTrackSched = {};
    let procView = 'bydate';
    let uiBound = false;

    const getAllVisits = deps.getAllVisits || (async () => {
        if (_visitsCache && Date.now() - _visitsCache.at < TTL) return _visitsCache.data;
        const snap = await fb.get(fb.ref(fb.db, 'opd/visits'));
        _visitsCache = { at: Date.now(), data: snap.val() || {} };
        return _visitsCache.data;
    });
    const getPatients = deps.getPatients || null;
    async function resolvePatients() {
        if (getPatients) return getPatients() || {};
        if (_patientsCache && Date.now() - _patientsCache.at < TTL) return _patientsCache.data;
        const snap = await fb.get(fb.ref(fb.db, 'opd/patients'));
        _patientsCache = { at: Date.now(), data: snap.val() || {} };
        return _patientsCache.data;
    }
    async function getCachedSched(force = false) {
        if (!force && _schedCache && Date.now() - _schedCache.at < TTL) return _schedCache;
        const [cellsSnap, clSnap, trackSnap] = await Promise.all([
            fb.get(fb.ref(fb.db, 'scheduler/cellData')),
            fb.get(fb.ref(fb.db, 'scheduler/caseList')),
            fb.get(fb.ref(fb.db, 'opd/procTrackSched'))
        ]);
        _schedCache = { at: Date.now(), cells: cellsSnap.val() || {}, caseList: clSnap.val() || {}, track: trackSnap.val() || {} };
        return _schedCache;
    }

    function procTrackOf(row) {
        // 排程原生 row：狀態疊加存 opd/procTrackSched/{caseId}（不寫 scheduler，單向唯讀）
        if (row.sched && !row.srcVisit) {
            const id = row.schedCase?.id || (row.cellKey + '_' + (row.time || 'x'));
            return { key: id, track: _procTrackSched[id] || null, schedKey: id };
        }
        const key = row.procDate || ('nodate|' + row.tags[0]);
        return { key, track: row.srcVisit.procTrack?.[key] || null };
    }

    async function render() {
        const wrap = document.getElementById(ids.list);
        if (!wrap) return;
        const view = procView;
        const rangeEl = document.getElementById(ids.range);
        const range = rangeEl?.value || 'recent';
        wrap.innerHTML = '<div class="empty-hint">推導中...</div>';
        const allByDate = await getAllVisits();
        const patients = await resolvePatients();
        const today = new Date();
        const fmtOff = (d) => formatDate(new Date(today.getTime() + d * 86400000));
        let startKey = '0000-00-00', endKey = '9999-99-99';
        const todayKey = formatDate(today);
        if (range === 'cycle') {
            // 本診間：上次門診 ~ 下次門診（嚴格前後，門診日當天窗口跨兩診間）
            // 門診日判定 = 規律雙週三 OR 當日 visit 數夠多（真門診 20+）——
            //   單筆污染排除：非門診日的孤 confirmed visit、RTC 自動建的加診日（opd/clinicDates 被單一 RTC 塞）
            //   都只有 1~2 筆 visit，過不了門檻，不會綁架起點（7/6 幽靈窗口案例）
            const CLINIC_MIN_VISITS = 5; // 遠低於真門診(20+)、遠高於雜訊(1~2)
            const isClinicDay = (k) => isRegularClinicDate(k) || Object.keys(allByDate[k] || {}).length >= CLINIC_MIN_VISITS;
            const keys = Object.keys(allByDate).sort();
            const past = keys.filter(k => k < todayKey && isClinicDay(k));
            const future = keys.filter(k => k > todayKey && isClinicDay(k));
            startKey = past.length ? past[past.length - 1] : fmtOff(-14);
            endKey = future.length ? future[0] : fmtOff(42);
            const opt = rangeEl?.querySelector('option[value="cycle"]');
            if (opt) opt.textContent = `本診間（${startKey.slice(5).replace('-', '/')} ~ ${endKey.slice(5).replace('-', '/')}）`;
        }
        else if (range === 'recent') { startKey = fmtOff(-42); endKey = fmtOff(42); }
        else if (range === '3m') { startKey = fmtOff(-90); endKey = fmtOff(90); }
        // 近期 / 3個月 選項也顯示實際日期區間（跟本診間一致）
        const md = (k) => k.slice(5).replace('-', '/');
        const optR = rangeEl?.querySelector('option[value="recent"]');
        if (optR) optR.textContent = `近期 ±6週（${md(fmtOff(-42))} ~ ${md(fmtOff(42))}）`;
        const opt3 = rangeEl?.querySelector('option[value="3m"]');
        if (opt3) opt3.textContent = `前後 3 個月（${md(fmtOff(-90))} ~ ${md(fmtOff(90))}）`;
        const { dated: opdRows, undated, todayStr } = deriveProcRows(allByDate); // 全量推導，範圍在下面過濾

        // 聯集排程原生 rows。去重 = 同病人（正規化：大寫、去符號、去 leading-0）同日 → 併入 OPD row
        let schedNote = '';
        let schedRows = [];
        try {
            const sched = await getCachedSched();
            _procTrackSched = sched.track;
            schedRows = buildSchedRows(sched);
        } catch (e) {
            schedNote = '（⚠ 排程節點讀取失敗，此頁僅顯示 OPD 衍生列）';
            console.warn('讀取排程節點失敗', e);
        }
        const normRec = (r) => String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
        const opdByKey = new Map();
        opdRows.forEach(r => opdByKey.set(normRec(r.rec) + '|' + r.procDate, r));
        const datedAll = [...opdRows];
        schedRows.forEach(sr => {
            const hit = sr.rec ? opdByKey.get(normRec(sr.rec) + '|' + sr.procDate) : null;
            if (hit) {
                if (!hit.time && sr.time) hit.time = sr.time;               // 執行時間住在排程 case 上
                if (!hit.fallbackStatus && sr.fallbackStatus) hit.fallbackStatus = sr.fallbackStatus;
                hit.schedCase = sr.schedCase;                               // 領藥顯示用
                return;
            }
            datedAll.push(sr);
        });
        datedAll.sort((a, b) => a.procDate.localeCompare(b.procDate) || (a.time || '99:99').localeCompare(b.time || '99:99') || a.rec.localeCompare(b.rec));

        // 有效狀態：手動 procTrack > 舊 caselist 狀態(fallback) > plan 標記(*/[已]) > 檢查類過期自動已執行 > 待做
        const stOf = (row) => {
            const t = procTrackOf(row).track;
            if (t?.status) return t.status;
            if (row.fallbackStatus) return row.fallbackStatus;
            if (row.autoDone) return 'done';
            if (row.sched && (row.schedCase?.type === 'mri' || row.schedCase?.type === 'ct') && row.procDate < todayStr) return 'done';
            return 'pending';
        };
        // 排程「暫定」（未確認）→ 只住「📝 待排」視圖
        const isTent = (r) => !!r.tentative && r.sched && !r.srcVisit;
        // 視圖語義：範圍是外層濾鏡、視圖是內層（已完成 = 「範圍內」的完成）
        const inWindow = (r) => r.procDate >= startKey && r.procDate <= endKey;
        const dated = datedAll.filter(r => !isTent(r) && inWindow(r));
        // 逾期未完成（窗口前 8 週內）→ 只在「⏳ 待做」視圖以獨立區塊顯示
        const overdueOut = view === 'pending'
            ? datedAll.filter(r => !isTent(r) && r.procDate < startKey && r.procDate >= fmtOff(-56) && stOf(r) === 'pending')
            : [];
        const overdueCnt = datedAll.filter(r => !isTent(r) && r.procDate < startKey && r.procDate >= fmtOff(-56) && stOf(r) === 'pending').length;
        let list = dated;
        if (view === 'pending') list = dated.filter(r => stOf(r) === 'pending');
        else if (view === 'done') list = dated.filter(r => stOf(r) === 'done');
        else if (view === 'tent') list = datedAll.filter(r => isTent(r) && inWindow(r));
        const tentCnt = datedAll.filter(r => isTent(r) && inWindow(r)).length;
        const showUndated = (view === 'all' || view === 'bydate' || view === 'pending') ? undated : [];

        // 統計列
        const cnt = { pending: 0, done: 0, dc: 0 };
        dated.forEach(r => cnt[stOf(r)]++);
        const statusEl = document.getElementById(ids.status);
        const windowLabel = range === 'cycle' ? `${startKey.slice(5).replace('-', '/')}~${endKey.slice(5).replace('-', '/')} · ` : '';
        if (statusEl) statusEl.textContent = `${windowLabel}${dated.length} 筆：⏳${cnt.pending} ✅${cnt.done} ⊘${cnt.dc}${undated.length ? ` · 📌未定 ${undated.length}` : ''}${overdueCnt ? ` · ⏰逾期 ${overdueCnt}（見待做）` : ''}${tentCnt ? ` · 📝待排 ${tentCnt}` : ''}${schedNote}`;

        if (!list.length && !showUndated.length) {
            wrap.innerHTML = '<div class="plc-scope"><div class="empty-hint">此範圍內沒有 procedure（plan 需有「日期 + SONO/TAME/CT NB…」行）</div></div>';
            return;
        }

        const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
        const fmtD = (iso) => { const dt = new Date(iso + 'T00:00'); return `${dt.getMonth() + 1}/${dt.getDate()} (${dayNames[dt.getDay()]})`; };

        const rowHtml = (row, mobile) => {
            const p = patients[row.rec] || {};
            const { key, track, schedKey } = procTrackOf(row);
            const st = stOf(row);
            const isSchedOnly = row.sched && !row.srcVisit;
            const med = isSchedOnly ? (row.schedCase?.medState || '') : (track?.med || '');
            const overdue = row.procDate && st === 'pending' && row.procDate < todayStr;
            const schedType = row.schedCase?.type || '';
            // 類別列色：檢查（MRI/CT）紫、Arthro 黃（沿用舊 caselist 視覺語彙）
            const catCls = isSchedOnly && (schedType === 'mri' || schedType === 'ct') ? ' pc-cat-image'
                : (isSchedOnly && schedType === 'arthro' ? ' pc-cat-arthro' : '');
            const surname = p.surname ? `(${escapeHtml(String(p.surname).replace(/\s+/g, ''))})` : '';
            const ageSex = displayAgeSex(p, todayStr) || p.ageSex || '';
            const labs = buildLabsDisplay(p);
            // 抗凝（procedure 前必看）：Arthro / MRI / CT（檢查類）不需確認（user 定），不顯示
            const isNonInvasive = isSchedOnly && ['arthro', 'mri', 'ct'].includes(schedType);
            let acHtml = '';
            if (!isNonInvasive) {
                if (p.anticoagState === 'yes' && (p.anticoagulants || []).length) {
                    const names = (p.anticoagulants || []).map(escapeHtml).join('/');
                    const holdInfo = (p.anticoagulants || []).map(dr => `${dr} hold ${getAnticoagHold(dr)}`).join('\n');
                    acHtml = `<span class="ac-icon ac-yes pill expandable" data-full="${escapeAttr(holdInfo)}"><span class="pill-text">🩸 ${names}</span></span>`;
                } else if (p.anticoagState === 'none') {
                    acHtml = `<span class="ac-icon ac-none">✓ 無抗凝</span>`;
                } else {
                    acHtml = `<span class="ac-icon ac-unknown">❓ 抗凝待</span>`;
                }
            }
            const tagChips = row.tags.map(t => `<span class="tag-chip" data-tag="${escapeAttr(normalizeTag(t))}">${escapeHtml(t)}</span>`).join('')
                + (row.noTag ? `<span class="pill expandable pc-notag" data-full="來源 visit 沒掛對應 tag——可能是漏掛 tag，或這行是殘文。點病歷號跳去該 visit 檢查"><span class="pill-text">⚠</span></span>` : '');
            // 註記：純清單小筆記（不寫回 plan）——OPD 列存 procTrack[key].note、排程列存 procTrackSched[caseId].note
            // 跟狀態/領藥同層 → plan 改期 key 斷時一起消失（=改期重新來，跟狀態重置同語義）
            const noteVal = track?.note || '';
            // Plan 欄：OPD row = 生成此列的那行（整段太吵，前後文點病歷號跳去看）；排程原生 = planScratch / Arthro 欄位 / note
            let planHtml = '';
            if (row.srcVisit) {
                planHtml = highlightPlanLine(row.line || '');
            } else if (schedType === 'arthro') {
                // Arthro 四欄位：顯示/編輯以 procTrackSched overlay 優先，舊 caselist row 值當 fallback（退役後 overlay 是唯一家）
                const ov = track || {};
                const a = row.arthro || {};
                // overlay 只要寫過（含清空 ''）就以 overlay 為準；沒寫過才 fallback 舊 caselist 值
                const fv = (k, ck) => (ov[k] !== undefined && ov[k] !== null) ? ov[k] : (a[ck] || '');
                const vals = { arthroRegion: fv('arthroRegion', 'region'), arthroWeight: fv('arthroWeight', 'weight'), arthroMriTime: fv('arthroMriTime', 'mriTime'), arthroContrast: fv('arthroContrast', 'contrast') };
                if (mobile) {
                    planHtml = escapeHtml([`部位 ${vals.arthroRegion || '?'}`, `體重 ${vals.arthroWeight || '?'}kg`, `MRI ${vals.arthroMriTime || '?'}`, `藥量 ${vals.arthroContrast || '?'}`].join(' · '));
                } else {
                    const inp = (f, w, ph) => `<input class="plc-arthro-in" data-plc-arthro="${f}" data-plc-schedkey="${escapeAttr(schedKey)}" value="${escapeAttr(vals[f])}" placeholder="${ph}" style="width:${w}px">`;
                    planHtml = `<div class="plc-arthro-row">部位${inp('arthroRegion', 76, '部位')} 體重${inp('arthroWeight', 44, 'kg')}kg MRI${inp('arthroMriTime', 56, '時間')} 藥量${inp('arthroContrast', 56, 'ml')}</div>`;
                }
            } else {
                planHtml = row.planScratch ? escapeHtml(row.planScratch).replace(/\n/g, '<br>') : `<span style="color:var(--text-muted,#64748b);">🔗 排程登記（OPD plan 無對應行）</span>`;
            }
            const dataAttrs = isSchedOnly
                ? `data-pc-schedkey="${escapeAttr(schedKey)}" data-pc-rec="${escapeAttr(row.rec)}" data-pc-now="${escapeAttr(st)}"`
                : `data-pc-src="${escapeAttr(row.srcDate)}" data-pc-rec="${escapeAttr(row.rec)}" data-pc-key="${escapeAttr(key)}" data-pc-now="${escapeAttr(st)}"`;
            const noteIn = `<input class="plc-note-in" data-plc-note ${dataAttrs} value="${escapeAttr(noteVal)}" placeholder="📝 註記…">`;
            const stTitle = track?.status ? '手動狀態' : (row.fallbackStatus ? '沿用舊 caselist 狀態，點擊改手動' : (row.autoDone ? 'plan 標記自動判定（*/[已]），點擊改手動' : ''));
            const stBtn = `<button type="button" class="pc-st pc-st-${st}" data-pc-cycle="st" ${dataAttrs} title="${stTitle}">${PROC_ST_META[st].label}</button>`;
            // 領藥：MRI/CT 檢查與藥物無關 → 空白；排程原生 row 顯示排程領藥條狀態（唯讀）；OPD row 可點
            const medBtn = (isSchedOnly && (schedType === 'mri' || schedType === 'ct'))
                ? ''
                : (isSchedOnly
                    ? `<span class="pc-med pc-med-${med || 'none'} pc-med-ro">${PROC_MED_META[med === 'pending' ? 'pending' : (med === 'collected' ? 'collected' : '')]}</span>`
                    : `<button type="button" class="pc-med pc-med-${med || 'none'}" data-pc-cycle="med" ${dataAttrs}>${PROC_MED_META[med]}</button>`);
            const dateLabel = row.procDate ? fmtD(row.procDate) : '📌 未定';
            const timeHtml = row.time ? `<span class="pc-time">${escapeHtml(row.time)}</span>` : '';
            const jumpable = row.srcVisit && jump;
            const recHtml = jumpable
                ? `<span class="record-line clickable" data-pc-jump="${escapeAttr(row.srcDate)}" data-pc-jumprec="${escapeAttr(row.rec)}" title="跳到 ${escapeAttr(row.srcDate)} 門診">${escapeHtml(row.rec)}</span>`
                : `<span class="record-line">${escapeHtml(row.rec || '—')}${row.srcVisit ? '' : ' <span style="font-size:0.7rem;color:var(--text-muted,#64748b);">🔗</span>'}</span>`;
            if (mobile) {
                return `<div class="pc-card pc-${st}${overdue ? ' pc-overdue' : ''}${catCls}">
                    <div class="pc-card-head">
                        <span class="pc-card-date">${escapeHtml(dateLabel)}${timeHtml}</span>
                        ${jumpable ? `<span class="pc-card-rec clickable" data-pc-jump="${escapeAttr(row.srcDate)}" data-pc-jumprec="${escapeAttr(row.rec)}">${escapeHtml(row.rec)}</span>` : `<span class="pc-card-rec">${escapeHtml(row.rec || '—')}</span>`}
                        <span class="pc-card-name">${surname}${ageSex ? ` ${escapeHtml(ageSex)}` : ''}</span>
                    </div>
                    ${(labs || acHtml) ? `<div class="pc-card-labs">${acHtml}${acHtml && labs ? ' ' : ''}${fmtLabDates(escapeHtml(labs.split('\n')[0] || ''))}</div>` : ''}
                    <div class="visit-tags" style="margin-top:5px;">${tagChips}</div>
                    ${planHtml ? `<div class="pc-card-plan">${planHtml}</div>` : ''}
                    ${noteVal ? `<div class="plc-note-ro">📝 ${escapeHtml(noteVal)}</div>` : ''}
                    <div class="pc-card-actions">${stBtn}${medBtn}</div>
                </div>`;
            }
            return `<tr class="pc-row pc-${st}${overdue ? ' pc-overdue' : ''}${catCls}">
                <td class="pc-c-date">${escapeHtml(dateLabel)}${timeHtml}</td>
                <td class="pc-c-rec">
                    ${recHtml}
                    <div class="age-line">${surname}${ageSex ? ` ${escapeHtml(ageSex)}` : ''}</div>
                </td>
                <td class="pc-c-labs">${acHtml ? `<div class="pc-ac">${acHtml}</div>` : ''}${fmtLabDates(escapeHtml(labs))}</td>
                <td class="pc-c-tags"><div class="visit-tags">${tagChips}</div></td>
                <td class="pc-c-plan"><div class="pc-plan-body">${planHtml}</div>${noteIn}</td>
                <td class="pc-c-st">${stBtn}</td>
                <td class="pc-c-med">${medBtn}</td>
            </tr>`;
        };

        const tableWrap = (bodyHtml) => `<div class="proc-table-wrapper"><table class="proc-table">
            <colgroup><col class="pc-c-date"><col class="pc-c-rec"><col class="pc-c-labs"><col class="pc-c-tags"><col class="pc-c-plan"><col class="pc-c-st"><col class="pc-c-med"></colgroup>
            <thead><tr><th>日期</th><th>病人</th><th>抽血</th><th>Procedure</th><th>Procedure 行 / 註記</th><th>狀態</th><th>藥</th></tr></thead>
            <tbody>${bodyHtml}</tbody></table></div>`;

        let desktopHtml = '';
        let mobileHtml = '';
        const undatedBlockD = showUndated.length ? `<tr class="pc-group-row pc-group-warn"><td colspan="7">📌 未定日期（門診已確認但還沒約 — 漏網偵測）</td></tr>` + showUndated.map(r => rowHtml(r, false)).join('') : '';
        const undatedBlockM = showUndated.length ? `<div class="pc-group-header pc-group-warn">📌 未定日期（已確認未約）</div>` + showUndated.map(r => rowHtml(r, true)).join('') : '';
        const overdueBlockD = overdueOut.length ? `<tr class="pc-group-row pc-group-warn"><td colspan="7">⏰ 逾期未完成（窗口前 8 週內 — 點完成/DC 收掉）</td></tr>` + overdueOut.map(r => rowHtml(r, false)).join('') : '';
        const overdueBlockM = overdueOut.length ? `<div class="pc-group-header pc-group-warn">⏰ 逾期未完成（窗口前）</div>` + overdueOut.map(r => rowHtml(r, true)).join('') : '';

        if (view === 'bydate') {
            const byDate = {};
            list.forEach(r => { (byDate[r.procDate] = byDate[r.procDate] || []).push(r); });
            const keys = Object.keys(byDate).sort();
            desktopHtml = tableWrap(undatedBlockD + keys.map(d =>
                `<tr class="pc-group-row${d === todayStr ? ' pc-group-today' : ''}"><td colspan="7">${escapeHtml(fmtD(d))}${d === todayStr ? '（今天）' : ''} · ${byDate[d].length} 筆</td></tr>` +
                byDate[d].map(r => rowHtml(r, false)).join('')
            ).join(''));
            mobileHtml = undatedBlockM + keys.map(d =>
                `<div class="pc-group-header${d === todayStr ? ' pc-group-today' : ''}">${escapeHtml(fmtD(d))}${d === todayStr ? '（今天）' : ''} · ${byDate[d].length}</div>` +
                byDate[d].map(r => rowHtml(r, true)).join('')
            ).join('');
        } else {
            desktopHtml = tableWrap(undatedBlockD + overdueBlockD + list.map(r => rowHtml(r, false)).join(''));
            mobileHtml = undatedBlockM + overdueBlockM + list.map(r => rowHtml(r, true)).join('');
        }
        wrap.innerHTML = `<div class="plc-scope"><div class="proc-desktop">${desktopHtml}</div><div class="proc-mobile">${mobileHtml}</div></div>`;
    }

    // 狀態 / 領藥循環：寫來源 visit 的 procTrack/{key}（欄位級 update），寫完改本地 cache 直接重畫
    async function cycleProcTrack(kind, srcDate, rec, key, nowSt, schedKey) {
        try {
            // 排程原生 row → 疊加層 opd/procTrackSched/{caseId}（不寫 scheduler 節點）
            const path = schedKey ? `opd/procTrackSched/${schedKey}` : `opd/visits/${srcDate}/${rec}/procTrack/${key}`;
            // race guard：抓最新
            const snap = await fb.get(fb.ref(fb.db, path));
            const cur = snap.val() || {};
            const updates = { at: Date.now() };
            if (kind === 'st') {
                // DB 沒手動狀態時，從畫面上的有效狀態（可能是 autoDone）接著循環
                updates.status = PROC_ST_META[cur.status || nowSt || 'pending'].next;
            } else {
                updates.med = cur.med === 'pending' ? 'collected' : (cur.med === 'collected' ? null : 'pending');
            }
            await fb.update(fb.ref(fb.db, path), updates);
            // 本地 cache 同步（非當前門診日 → 不會有 listener echo，自己更新）
            if (schedKey) {
                _procTrackSched[schedKey] = { ...cur, ...updates };
                if (_schedCache) _schedCache.track = _procTrackSched;
            } else {
                const allByDate = await getAllVisits();
                const v = allByDate?.[srcDate]?.[rec];
                if (v) {
                    v.procTrack = v.procTrack || {};
                    v.procTrack[key] = { ...cur, ...updates };
                }
            }
            if (kind === 'st') {
                const lbl = PROC_ST_META[updates.status]?.label || updates.status;
                setStatus(`${rec} → ${lbl}（列若消失 = 日期在目前範圍外，調大時間範圍可見）`);
            } else {
                setStatus(`${rec} 領藥 → ${PROC_MED_META[updates.med || '']}`);
            }
            render();
        } catch (err) {
            reportError(err, 'Procedure 狀態');
        }
    }

    // 註記存檔（失焦；空值寫 null = 刪註記）——不重畫，避免打字流程被打斷
    async function saveProcNote(ds, value) {
        const v = value.trim();
        try {
            const path = ds.pcSchedkey
                ? `opd/procTrackSched/${ds.pcSchedkey}`
                : `opd/visits/${ds.pcSrc}/${ds.pcRec}/procTrack/${ds.pcKey}`;
            await fb.update(fb.ref(fb.db, path), { note: v || null, at: Date.now() });
            // 本地 cache 同步
            if (ds.pcSchedkey) {
                _procTrackSched[ds.pcSchedkey] = { ...(_procTrackSched[ds.pcSchedkey] || {}), note: v || null };
                if (_schedCache) _schedCache.track = _procTrackSched;
            } else {
                const allByDate = await getAllVisits();
                const vis = allByDate?.[ds.pcSrc]?.[ds.pcRec];
                if (vis) {
                    vis.procTrack = vis.procTrack || {};
                    vis.procTrack[ds.pcKey] = { ...(vis.procTrack[ds.pcKey] || {}), note: v || null };
                }
            }
            setStatus(v ? `${ds.pcRec} 註記已存` : `${ds.pcRec} 註記已清除`);
        } catch (err) {
            reportError(err, '註記');
        }
    }

    // Arthro inline 欄位存檔（失焦時單欄寫入 overlay；不重畫，避免打字流程被打斷）
    async function saveArthroField(schedKey, field, value) {
        try {
            const path = `opd/procTrackSched/${schedKey}`;
            await fb.update(fb.ref(fb.db, path), { [field]: value.trim(), at: Date.now() });
            _procTrackSched[schedKey] = { ...(_procTrackSched[schedKey] || {}), [field]: value.trim() };
            if (_schedCache) _schedCache.track = _procTrackSched;
            setStatus(`Arthro ${field.replace('arthro', '')} 已存`);
        } catch (err) {
            reportError(err, 'Arthro 欄位');
        }
    }

    function bind() {
        if (uiBound) return;
        uiBound = true;
        document.getElementById(ids.chips)?.addEventListener('click', (e) => {
            const chip = e.target.closest('.pv-chip');
            if (!chip) return;
            procView = chip.dataset.view;
            document.querySelectorAll(`#${ids.chips} .pv-chip`).forEach(c => c.classList.toggle('active', c === chip));
            render();
        });
        document.getElementById(ids.range)?.addEventListener('change', render);
        const listEl = document.getElementById(ids.list);
        listEl?.addEventListener('click', (e) => {
            const cyc = e.target.closest('[data-pc-cycle]');
            if (cyc) {
                cycleProcTrack(cyc.dataset.pcCycle, cyc.dataset.pcSrc, cyc.dataset.pcRec, cyc.dataset.pcKey, cyc.dataset.pcNow, cyc.dataset.pcSchedkey || null);
                return;
            }
            const jmp = e.target.closest('[data-pc-jump]');
            if (jmp && jump) jump(jmp.dataset.pcJump, jmp.dataset.pcJumprec);
        });
        // Arthro inline 編輯 + 註記：focusout 存單欄
        listEl?.addEventListener('focusout', (e) => {
            const inp = e.target.closest?.('[data-plc-arthro]');
            if (inp) {
                const prev = (_procTrackSched[inp.dataset.plcSchedkey] || {})[inp.dataset.plcArthro] || '';
                if (inp.value.trim() === String(prev)) return; // 沒改不寫
                saveArthroField(inp.dataset.plcSchedkey, inp.dataset.plcArthro, inp.value);
                return;
            }
            const noteEl = e.target.closest?.('[data-plc-note]');
            if (noteEl) {
                if (noteEl.value.trim() === (noteEl.defaultValue || '').trim()) return; // 沒改不寫
                saveProcNote(noteEl.dataset, noteEl.value);
                noteEl.defaultValue = noteEl.value; // 更新比較基準（防重複失焦重寫）
            }
        });
    }

    return { render, bind, invalidateSched: () => { _schedCache = null; } };
}
