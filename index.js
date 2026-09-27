/*
 * Bot Tester (봇 테스터) — SillyTavern extension
 *
 * 1) Fetches reference pages (Pixiv 百科事典 / 나무위키 / Fandom wiki) about the original character
 * 2) Plays {{user}} automatically and sends test messages to the bot for N turns
 * 3) Asks an LLM to grade how faithful the bot's portrayal is to the source (percent + feedback)
 */

import { jsonrepair } from './lib/jsonrepair.mjs';

const MODULE = 'bot_tester';
const LOG = '[BotTester]';
const STORE_PREFIX = 'bot_tester::';

const ctx = () => SillyTavern.getContext();

// ---------------------------------------------------------------------------
// Settings (global)
// ---------------------------------------------------------------------------

const defaultSettings = Object.freeze({
    turns: 5,
    scenario: 'mix',
    customInstruction: '',
    newChat: true,
    delayMs: 300,
    genMode: 'batch',        // 'batch' = write all test messages in one call (fast), 'adaptive' = one call per turn
    testerMaxTokens: 2048,
    autoMinimize: true,
    funReference: '',       // creator's proven fun style (from 재미 분석)
    accent: 'champagne',
    panelPos: null,
    panelWidth: null,        // user-resized width (desktop only)          // {x, y} in px, null = default dock
    language: '한국어',
    refMaxChars: 15000,
    evalMessages: 20,
    includeLorebook: true,
    evalMaxTokens: 8000,
    testerProfile: '',   // '' = current connection
    evalProfile: '',     // '' = current connection
    autoEvalAfterTest: true,
    // voice & personality check
    searchEngine: 'auto',    // auto (DuckDuckGo→Bing + Reddit) | serper | tavily | serpapi
    fanonSearch: true,
    voiceSamples: true,
    voiceUseChat: true,
    profileMaxTokens: 8000,
});

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) {
        extensionSettings[MODULE] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE], key)) {
            extensionSettings[MODULE][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE];
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// Per-character data (stored in browser storage, NOT in the card, so exports stay clean)
// ---------------------------------------------------------------------------

function getCurrentCharacter() {
    const c = ctx();
    if (c.groupId) return null;
    if (c.characterId === undefined || c.characterId === null) return null;
    return c.characters[c.characterId] ?? null;
}

function charKey(char) {
    return STORE_PREFIX + (char?.avatar || char?.name || 'unknown');
}

const emptyCharData = () => ({ urls: [], refText: '', authorNote: '', history: [], names: null, voiceProfile: null, voiceResults: {}, doctor: null, runs: [], abBaselineId: null, abLast: null, applyLog: [], funProfile: null });

async function loadCharData(char) {
    if (!char) return emptyCharData();
    const { localforage } = SillyTavern.libs;
    try {
        const data = await localforage.getItem(charKey(char));
        return Object.assign(emptyCharData(), data || {});
    } catch (e) {
        console.warn(LOG, 'load failed', e);
        return emptyCharData();
    }
}

async function saveCharData(char, data) {
    if (!char) return;
    const { localforage } = SillyTavern.libs;
    try {
        await localforage.setItem(charKey(char), data);
    } catch (e) {
        console.error(LOG, 'save failed', e);
        toastr.error('봇 테스터: 데이터 저장 실패 (콘솔 확인)');
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function escapeHtml(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function truncate(s, n) {
    s = String(s ?? '');
    return s.length > n ? s.slice(0, n) + '\n…(생략)…' : s;
}

function isGenerating() {
    const el = document.getElementById('mes_stop');
    return !!el && getComputedStyle(el).display !== 'none';
}

async function waitIdle(timeoutMs = 300000) {
    const start = Date.now();
    while (isGenerating()) {
        if (Date.now() - start > timeoutMs) throw new Error('응답 대기 시간 초과');
        await sleep(150);
    }
}

/** Shows a live elapsed-seconds counter in the status line while `promise` runs. */
async function withTimer(label, promise) {
    const start = Date.now();
    setStatus(`${label} (0초)`);
    const iv = setInterval(() => setStatus(`${label} (${Math.round((Date.now() - start) / 1000)}초)`), 1000);
    try {
        return await promise;
    } finally {
        clearInterval(iv);
    }
}

/** True when a roleplay line looks cut off (unclosed *action* or quote). */
function looksTruncated(t) {
    const s = String(t || '').trim();
    if (!s) return true;
    const stars = (s.match(/\*/g) || []).length;
    const dq = (s.match(/"/g) || []).length;
    const open = (s.match(/[“「『(（]/g) || []).length;
    const close = (s.match(/[”」』)）]/g) || []).length;
    return stars % 2 === 1 || dq % 2 === 1 || open > close;
}

/** Closes dangling *action* / quotes so a cut-off line still renders cleanly. */
function closeDangling(t) {
    let s = String(t || '').trim();
    if ((s.match(/"/g) || []).length % 2 === 1) s += '"';
    if ((s.match(/\*/g) || []).length % 2 === 1) s += '*';
    const pairs = { '“': '”', '「': '」', '『': '』', '(': ')', '（': '）' };
    for (const [o, c] of Object.entries(pairs)) {
        const diff = s.split(o).length - s.split(c).length;
        if (o !== c && diff > 0) s += c.repeat(diff);
    }
    return s;
}

// ---------------------------------------------------------------------------
// Wiki fetching (uses ST's built-in server proxy: /api/search/visit)
// ---------------------------------------------------------------------------

async function visit(url, html = true) {
    const res = await fetch('/api/search/visit', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ url, html }),
    });
    if (!res.ok) throw new Error(`페이지를 가져오지 못했어요 (HTTP ${res.status})`);
    return await res.text();
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'TR', 'TABLE', 'BLOCKQUOTE', 'PRE', 'DL', 'DT', 'DD', 'BR', 'ASIDE', 'FIGCAPTION', 'HEADER']);

function nodeToText(node) {
    let out = '';
    const walk = (n) => {
        if (n.nodeType === Node.TEXT_NODE) {
            out += n.nodeValue.replace(/\s+/g, ' ');
            return;
        }
        if (n.nodeType !== Node.ELEMENT_NODE) return;
        const tag = n.tagName;
        if (tag === 'BR') { out += '\n'; return; }
        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock) out += '\n';
        if (/^H[1-6]$/.test(tag)) out += '## ';
        if (tag === 'LI') out += '- ';
        if (tag === 'TD' || tag === 'TH') out += ' | ';
        for (const child of n.childNodes) walk(child);
        if (isBlock) out += '\n';
    };
    walk(node);
    return out
        .split('\n')
        .map(l => l.trim())
        .filter((l, i, arr) => l || (arr[i - 1] ?? '') !== '')
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function htmlToText(html, preferredSelectors = []) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll([
        'script', 'style', 'noscript', 'iframe', 'svg', 'nav', 'footer', 'form', 'button', 'img', 'figure',
        '.navbox', '.toc', '#toc', '.mw-editsection', 'sup.reference', '.reference', '.references',
        '.wds-global-navigation', '.global-navigation', '.page-footer', '.fandom-community-header',
        '.ad-slot', '[class*="advert"]', '.printfooter', '.catlinks',
    ].join(',')).forEach(e => e.remove());

    const candidates = [...preferredSelectors, '.mw-parser-output', '#article-body', 'article', 'main', '#content', 'body'];
    for (const sel of candidates) {
        const el = doc.querySelector(sel);
        if (el && (el.textContent || '').trim().length > 300) {
            return nodeToText(el);
        }
    }
    return nodeToText(doc.body || doc.documentElement);
}

function looksBlocked(text) {
    const t = String(text || '');
    return t.length < 200
        || /Just a moment|cf-chl|Checking your browser|Attention Required|Access denied|captcha/i.test(t.slice(0, 3000));
}

function cleanNamuMarkup(raw) {
    return String(raw)
        .replace(/\[\*[^\]]*?\s[^\]]*?\]/g, '')                 // footnotes [* ...]
        .replace(/\[\[(?:파일|File|분류):[^\]]*\]\]/g, '')       // files / categories
        .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')           // [[link|label]]
        .replace(/\[\[([^\]]*)\]\]/g, '$1')                      // [[link]]
        .replace(/\[(?:include|목차|tableofcontents|각주|footnote|br|clearfix)[^\]]*\]/gi, '')
        .replace(/\{\{\{#!(?:wiki|html|folding)[^\n]*\n?/g, '')
        .replace(/\{\{\{[+-]?\d?\s?|\}\}\}/g, '')
        .replace(/'''|''|~~|--|__|\^\^|,,/g, '')
        .replace(/<[^>]{0,80}>/g, ' ')
        .replace(/\|\|/g, ' | ')
        .replace(/^(=+)\s*#?\s*(.*?)\s*#?\s*\1\s*$/gm, '## $2')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function fetchFandom(u) {
    const m = u.pathname.match(/^(\/[a-z]{2,3}(?:-[a-z]+)?)?\/wiki\/(.+)$/i);
    if (m) {
        const langPrefix = m[1] || '';
        const title = decodeURIComponent(m[2]);
        const api = `${u.protocol}//${u.host}${langPrefix}/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text&format=json&formatversion=2&redirects=1`;
        try {
            const json = JSON.parse(await visit(api, false));
            const html = json?.parse?.text;
            if (html) {
                const text = htmlToText(`<div class="mw-parser-output">${html}</div>`, ['.mw-parser-output']);
                if (text.length > 200) return `# ${json.parse.title || title}\n\n${text}`;
            }
        } catch (e) {
            console.warn(LOG, 'fandom api failed, fallback to html', e);
        }
    }
    return htmlToText(await visit(u.href), ['.mw-parser-output']);
}

async function fetchNamu(u) {
    const m = u.pathname.match(/^\/(?:w|raw)\/(.+)$/);
    if (m) {
        try {
            const raw = await visit(`https://namu.wiki/raw/${m[1]}`, false);
            if (!looksBlocked(raw) && !/<html/i.test(raw.slice(0, 500))) {
                return `# ${decodeURIComponent(m[1])}\n\n${cleanNamuMarkup(raw)}`;
            }
        } catch (e) {
            console.warn(LOG, 'namu raw failed, fallback to html', e);
        }
    }
    return htmlToText(await visit(u.href));
}

async function fetchPixiv(u) {
    return htmlToText(await visit(u.href), ['#article-body', 'article', 'main']);
}

async function fetchReference(url) {
    const u = new URL(url.trim());
    let text;
    if (u.hostname.endsWith('fandom.com') || u.hostname.endsWith('wikia.org')) text = await fetchFandom(u);
    else if (u.hostname.endsWith('namu.wiki')) text = await fetchNamu(u);
    else if (u.hostname.endsWith('dic.pixiv.net')) text = await fetchPixiv(u);
    else text = htmlToText(await visit(u.href));

    if (looksBlocked(text)) {
        throw new Error('사이트가 자동 수집을 막았어요. 페이지 내용을 직접 복사해서 “원작 자료” 칸에 붙여넣어 주세요.');
    }
    return text;
}

// ---------------------------------------------------------------------------
// LLM helpers
// ---------------------------------------------------------------------------

function getProfiles() {
    return ctx().extensionSettings?.connectionManager?.profiles ?? [];
}

/** Output budget for evaluation JSON (reasoning models spend tokens thinking too). */
function evalTokens() {
    return Math.max(Number(getSettings().evalMaxTokens) || 0, 8000);
}

async function callLLM({ system, prompt, profileId = '', maxTokens = 600 }) {
    const c = ctx();
    if (profileId) {
        const res = await c.ConnectionManagerRequestService.sendRequest(
            profileId,
            [{ role: 'system', content: system }, { role: 'user', content: prompt }],
            maxTokens,
            { stream: false, extractData: true, includePreset: true, includeInstruct: true },
        );
        return String(res?.content ?? '').trim();
    }
    const out = await c.generateRaw({ systemPrompt: system, prompt, responseLength: maxTokens });
    return String(out ?? '').trim();
}

function stripReasoning(text) {
    return String(text).replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
}

// ---------------------------------------------------------------------------
// Character card collection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fun guard (재미 보호) — accuracy / token advice must never make roleplay boring
// ---------------------------------------------------------------------------

const FUN_PRINCIPLES = [
    'WHAT MAKES A ROLEPLAY BOT FUN — protect these; never trade them away for canon accuracy or fewer tokens:',
    '1. Directorial narration cues: lines that tell the narrator HOW to show a trait on the page (e.g. "never let the reader forget his size: he ducks through doorways, rests his elbow at other people\'s head height").',
    '2. State changes as visible beats: a physical signal that marks a mode shift (e.g. tying the hair back = limiter off), tiered escalation with concrete triggers, and a cooldown ritual.',
    '3. Voice mechanics: grammar / rhythm rules per language with sample lines and the reason behind them.',
    '4. Prohibitions paired with a replacement behavior ("surprise reads as a slow blink, not a gasp", "he asks about food") and refusals framed as characterization. These are NOT prohibition overload.',
    '5. Relationship texture in small systems: earned nicknames vs bare surnames, running gags, recurring bits with side characters, anecdotes that generate comedy.',
    '6. Signature cues with payoff: a line or verb reserved for key moments so its appearance lands.',
    '7. Subtext and gap: what the character hides and how the body betrays it (eyes off, wrapper crushed, answers shorter).',
    '8. Scene hooks: greetings that start in the middle of a small concrete problem with sensory detail and end on something {{user}} can react to.',
    '9. Scarcity: rare modes / reveals kept rare so they stay exciting.',
    'Rules for advice: prefer adding "how to show it" cues over wiki facts; never suggest deleting or flattening the items above; never turn vivid prose into dry lists; a change that is more canon-accurate but less playable is a bad change.',
].join('\n');

/** Extra guidance: the creator's proven style + this character's protected parts. */
function funGuard(charData) {
    const s = getSettings();
    const parts = [FUN_PRINCIPLES];
    if (s.funReference) parts.push(`CREATOR'S PROVEN FUN STYLE (their own bot that plays well — match this approach):\n${truncate(s.funReference, 1800)}`);
    const protect = charData?.funProfile?.protect || [];
    if (protect.length) {
        parts.push(`PROTECTED PARTS OF THIS CARD (do not remove, shorten or dilute):\n${protect.slice(0, 20).map(p => `- ${p.what}${p.quote ? `: "${truncate(p.quote, 160)}"` : ''}`).join('\n')}`);
    }
    return parts.join('\n\n');
}

const FUN_IMPACT_DOC = '"fun_impact": "+"|"0"|"-" (does this change make the roleplay MORE fun, neutral, or LESS fun?), "fun_note": "<한 줄: 재미에 어떤 영향인지>"';

function funBadge(impact, note = '') {
    const k = String(impact ?? '').trim();
    if (k === '+') return `<span class="bt-tag bt-fun-up" title="${escapeHtml(note)}">${ico('face-smile')}재미 ↑</span>`;
    if (k === '-' || k === '−') return `<span class="bt-tag bt-fun-down" title="${escapeHtml(note)}">${ico('triangle-exclamation')}재미 ↓ 주의</span>`;
    return '';
}

function collectCard(char) {
    const c = ctx();
    let fields = {};
    try {
        fields = c.getCharacterCardFields?.() ?? {};
    } catch (e) {
        console.warn(LOG, 'getCharacterCardFields failed', e);
    }
    const parts = [];
    const add = (label, v) => { if (v && String(v).trim()) parts.push(`### ${label}\n${String(v).trim()}`); };
    add('이름', char?.name);
    add('Description', fields.description ?? char?.description);
    add('Personality', fields.personality ?? char?.personality);
    add('Scenario', fields.scenario ?? char?.scenario);
    add('First message', fields.firstMessage ?? char?.first_mes);
    add('Example dialogue', fields.mesExamples ?? char?.mes_example);
    add('System prompt', fields.system);
    add('Post-history instructions', fields.jailbreak);
    add("Character's note", fields.charDepthPrompt);

    if (getSettings().includeLorebook) {
        const entries = char?.data?.character_book?.entries ?? [];
        const lore = entries
            .filter(e => e && e.enabled !== false && e.content)
            .map(e => `- [${(e.keys || []).slice(0, 4).join(', ') || e.comment || '항목'}] ${String(e.content).trim()}`)
            .join('\n');
        add('내장 로어북', truncate(lore, 8000));
    }
    return parts.join('\n\n');
}

function collectChatLog(limit) {
    const { chat } = ctx();
    return chat
        .filter(m => m && !m.is_system && typeof m.mes === 'string')
        .slice(-limit)
        .map(m => `${m.is_user ? '[USER] ' : '[BOT] '}${m.name}: ${truncate(m.mes, 1500)}`)
        .join('\n\n');
}

// ---------------------------------------------------------------------------
// Auto tester
// ---------------------------------------------------------------------------

const FOCUS = {
    daily: ['평범한 일상 대화로 기본 말투·호칭·어휘를 확인', '가벼운 잡담이나 취미 이야기', '밥/날씨/하루 일과 같은 사소한 화제'],
    lore: ['원작의 과거사·출신·소속에 대해 질문', '원작 속 사건이나 명장면을 언급하며 반응을 봄', '캐릭터의 능력·직업·특기에 관해 물어봄'],
    relationship: ['원작의 다른 등장인물 이름을 꺼내 관계성을 확인', '가족·동료·라이벌에 대한 생각을 물어봄', '{{user}}와의 거리감/호칭이 원작 성격에 맞는지 떠봄'],
    emotion: ['캐릭터를 화나게 하거나 당황하게 만드는 말', '슬프거나 약한 모습을 이끌어내는 상황', '칭찬하거나 고백하는 등 감정을 흔드는 상황'],
    values: ['캐릭터의 가치관을 시험하는 딜레마 제시', '캐릭터가 싫어하는 것/좋아하는 것을 들이밀기', '원작 성격이라면 거절할 법한 부탁을 하기'],
    chaos: ['갑작스러운 돌발 상황(사고, 위험, 낯선 사람 등장)', '분위기를 확 바꾸는 엉뚱한 행동', '캐릭터의 설정 밖의 질문(현대 문물 등)으로 일관성 확인'],
    fun: ['카드에 적힌 트리거(화나게 하는 것·모드가 바뀌는 조건)를 건드려 봄', '별명·호칭 규칙이나 반복 개그가 나올 상황을 만듦', '캐릭터가 숨기는 속마음을 슬쩍 찔러 봄', '작은 갈등이나 부탁을 던져서 장면을 굴려 봄'],
};

const SCENARIO_LABELS = {
    mix: '골고루 섞기 (추천)',
    daily: '일상 대화 / 말투',
    lore: '원작 설정 질문',
    relationship: '관계성',
    emotion: '감정 자극',
    values: '가치관 / 좋고 싫음',
    fun: '재미 포인트 자극 (트리거·개그·속마음)',
    chaos: '돌발 상황 / 일관성',
    custom: '직접 지시만 사용',
};

function pickFocus(scenario, turn) {
    if (scenario === 'custom') return '제작자 지시사항을 따름';
    const pool = scenario === 'mix'
        ? ['daily', 'fun', 'lore', 'relationship', 'emotion', 'values', 'chaos', 'fun'].map(k => FOCUS[k][turn % FOCUS[k].length])
        : FOCUS[scenario] ?? FOCUS.daily;
    return pool[turn % pool.length];
}

let running = false;
let stopRequested = false;

function cleanTesterOutput(text, userName, charName) {
    let t = stripReasoning(text);
    t = t.replace(/^```[a-z]*\n?|```$/g, '').trim();
    const namePrefix = new RegExp(`^(?:${[userName, '\\{\\{user\\}\\}', 'User', '유저', '사용자'].map(s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*[:：]\\s*`, 'i');
    t = t.replace(namePrefix, '');
    // Cut off if the model started writing the bot's line too
    const charLine = new RegExp(`\\n\\s*${String(charName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：]`);
    const idx = t.search(charLine);
    if (idx > 0) t = t.slice(0, idx);
    t = t.trim();
    if (/^["“].*["”]$/s.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1).trim();
    t = t.replace(/^\/+/, ''); // never let it run as a slash command
    return t;
}

function testerNames() {
    const c = ctx();
    return {
        userName: c.name1 || 'User',
        charName: c.name2 || getCurrentCharacter()?.name || 'Character',
    };
}

function testerSystemPrompt(userName, charName, language) {
    return [
        `You are a QA tester for a fan-made roleplay character bot. You are role-playing as "${userName}" talking to "${charName}".`,
        `Your purpose: write messages that reveal whether ${charName} is portrayed faithfully to the ORIGINAL work (speech style, personality, backstory, relationships, values).`,
        'Rules:',
        `- Write in ${language}. Each message is 1–3 sentences and MUST be complete (close every *action* and every quote).`,
        '- Short actions may be written in *asterisks*.',
        `- Never write ${charName}'s lines or narrate ${charName}'s actions.`,
        '- No explanations, no labels, no name prefix.',
        '- Use concrete names/events from the reference when it helps probe accuracy.',
        '- Think briefly. Keep the output short.',
    ].join('\n');
}

function testerContextBlocks(charData, s) {
    return [
        charData.refText ? `[원작 참고 자료 (발췌)]\n${truncate(charData.refText, 3000)}` : '[원작 참고 자료 없음 — 일반적인 캐릭터 일관성 위주로 테스트]',
        charData.authorNote ? `[제작자 메모 — 의도한 AU/설정 변경]\n${charData.authorNote}` : '',
        s.customInstruction ? `[제작자 지시사항]\n${s.customInstruction}` : '',
    ].filter(Boolean);
}

/** Adaptive mode: one LLM call per turn, reacting to the bot's last reply. */
async function generateTestMessage(turn, total, charData) {
    const s = getSettings();
    const { userName, charName } = testerNames();
    const focus = pickFocus(s.scenario, turn).replaceAll('{{user}}', userName);

    const system = testerSystemPrompt(userName, charName, s.language)
        + `\n- Output ONLY ${userName}'s next chat message. Continue naturally from the conversation; do not repeat earlier questions.`;
    const prompt = [
        ...testerContextBlocks(charData, s),
        `[지금까지의 대화]\n${collectChatLog(8) || '(아직 대화 없음)'}`,
        `[이번 턴 테스트 포인트] ${focus}`,
        `Turn ${turn + 1}/${total}. Write ${userName}'s next message now.`,
    ].join('\n\n');

    const maxTokens = Number(s.testerMaxTokens) || 2048;
    let msg = cleanTesterOutput(await callLLM({ system, prompt, profileId: s.testerProfile, maxTokens }), userName, charName);
    if (looksTruncated(msg) && !stopRequested) {
        console.warn(LOG, 'tester message looks cut off, retrying once:', msg);
        const retry = cleanTesterOutput(await callLLM({ system, prompt, profileId: s.testerProfile, maxTokens: maxTokens * 2 }), userName, charName);
        if (retry && (!looksTruncated(retry) || retry.length > msg.length)) msg = retry;
    }
    return closeDangling(msg);
}

/** Batch mode: write every test message in ONE LLM call (much faster). */
async function generateTestBatch(total, charData) {
    const s = getSettings();
    const { userName, charName } = testerNames();
    const focuses = Array.from({ length: total }, (_, i) => `${i + 1}. ${pickFocus(s.scenario, i).replaceAll('{{user}}', userName)}`);

    const system = testerSystemPrompt(userName, charName, s.language) + [
        '',
        `- You are writing a test SCRIPT of ${total} consecutive messages from ${userName}. The bot will reply between them, so each message must make sense on its own`,
        '  (you may assume the bot answered something in between; avoid depending on a specific reply).',
        `- Output ONLY a JSON array of exactly ${total} strings, e.g. ["message 1", "message 2"]. No other text.`,
    ].join('\n');
    const prompt = [
        ...testerContextBlocks(charData, s),
        `[현재 채팅의 마지막 부분]\n${collectChatLog(4) || '(아직 대화 없음 — 첫 메시지는 자연스러운 상황 도입으로)'}`,
        `[각 메시지의 테스트 포인트]\n${focuses.join('\n')}`,
        `Write the JSON array of ${total} messages now.`,
    ].join('\n\n');

    const maxTokens = Math.max(Number(s.testerMaxTokens) || 2048, 400 * total + 1024);
    const raw = await callLLM({ system, prompt, profileId: s.testerProfile, maxTokens });
    let list = parseJsonArrayLoose(raw);
    list = list.map(x => closeDangling(cleanTesterOutput(typeof x === 'string' ? x : (x?.message ?? x?.text ?? ''), userName, charName))).filter(Boolean);
    if (!list.length) throw new Error('테스트 메시지 목록을 만들지 못했어요');
    return list.slice(0, total);
}

function parseJsonArrayLoose(text) {
    let t = stripReasoning(text).replace(/```(?:json)?/gi, '').trim();
    const a = t.indexOf('[');
    const b = t.lastIndexOf(']');
    if (a !== -1 && b > a) {
        const body = t.slice(a, b + 1);
        try { return JSON.parse(body); } catch { /* try fixes */ }
    }
    try { return parseJsonLoose(t, '['); } catch { /* fall through */ }
    // Truncated or not JSON: salvage complete "..." strings, else numbered lines
    const strings = [...t.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } });
    if (strings.length) return strings;
    return t.split('\n').map(l => l.replace(/^\s*(?:\d+[.)]|-)\s*/, '').trim()).filter(Boolean);
}

async function sendAsUserAndWait(text) {
    await waitIdle();
    const ta = document.getElementById('send_textarea');
    if (!ta) throw new Error('입력창을 찾을 수 없어요');
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await ctx().generate('normal');
    await sleep(150);
    await waitIdle();
}

function lastBotReply() {
    const chat = ctx().chat;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        return m.is_user ? '' : String(m.mes || '');
    }
    return '';
}

/**
 * Runs an automatic test.
 * @param {number} [turnsOverride]
 * @param {{ script?: string[], role?: 'A'|'B' }} [opts] script = re-send exactly these messages (A/B test)
 */
async function runTest(turnsOverride, opts = {}) {
    if (running) { toastr.warning('이미 테스트가 진행 중이에요'); return; }
    const char = getCurrentCharacter();
    if (!char) { toastr.error('1:1 캐릭터 채팅을 열어주세요 (그룹 채팅은 지원하지 않아요)'); return; }

    const s = getSettings();
    const fixedScript = Array.isArray(opts.script) && opts.script.length ? opts.script : null;
    const turns = fixedScript ? fixedScript.length : Math.max(1, Math.min(50, Number(turnsOverride || s.turns) || 5));
    const charData = await loadCharData(char);

    running = true;
    stopRequested = false;
    updateRunState();
    if (s.autoMinimize && isNarrow()) setMinimized(true);

    const run = { id: Date.now(), time: Date.now(), role: opts.role || '', script: [], replies: [], chatId: '', eval: null };
    let handedOff = false;
    try {
        if (s.newChat || fixedScript) {
            await ctx().executeSlashCommandsWithOptions('/newchat');
            await sleep(500);
            await waitIdle();
        }

        let script = fixedScript;
        if (!script && s.genMode === 'batch') {
            script = await withTimer(`📝 테스트 메시지 ${turns}개 한 번에 작성 중…`, generateTestBatch(turns, charData));
        }

        const total = script ? script.length : turns;
        for (let i = 0; i < total; i++) {
            if (stopRequested) break;
            const msg = script
                ? script[i]
                : await withTimer(`🧪 ${i + 1}/${total}턴: 테스트 메시지 작성 중…`, generateTestMessage(i, total, charData));
            if (!msg) throw new Error('테스트 메시지 생성 결과가 비어 있어요');
            if (stopRequested) break;
            await withTimer(`💬 ${opts.role ? `[${opts.role}] ` : ''}${i + 1}/${total}턴: 봇 응답 대기 중…`, sendAsUserAndWait(msg));
            run.script.push(msg);
            run.replies.push(lastBotReply());
            if (Number(s.delayMs) > 0) await sleep(Number(s.delayMs));
        }
        run.chatId = ctx().getCurrentChatId?.() ?? '';

        if (stopRequested) {
            setStatus('⏹ 테스트를 중단했어요');
            toastr.info('테스트 중단됨');
            return;
        }

        // keep the run for A/B comparison
        const cd = await loadCharData(char);
        cd.runs = [run, ...(cd.runs || [])].slice(0, 8);
        if (!cd.abBaselineId || !cd.runs.some(r => r.id === cd.abBaselineId)) cd.abBaselineId = run.id;
        await saveCharData(char, cd);
        renderAbPanel(cd);

        setStatus('✅ 테스트 완료');
        toastr.success('테스트 대화 완료!');
        if (s.autoEvalAfterTest || fixedScript) {
            running = false;
            updateRunState();
            handedOff = true;
            const entry = await runEvaluation({ useChat: true, messages: run.script.length * 2 });
            if (entry) {
                const cd2 = await loadCharData(char);
                const r = (cd2.runs || []).find(x => x.id === run.id);
                if (r) {
                    r.eval = { overall: entry.result.overall, fun: entry.result.fun, categories: entry.result.categories || [], summary: entry.result.summary || '' };
                    await saveCharData(char, cd2);
                }
                renderAbPanel(cd2);
                if (opts.role === 'B') {
                    const a = (cd2.runs || []).find(x => x.id === cd2.abBaselineId);
                    if (a && a.id !== run.id) {
                        cd2.abLast = { a: a.id, b: run.id };
                        await saveCharData(char, cd2);
                        renderAbCompare(cd2);
                        switchTab('result');
                        scrollPanelTo($id('ab_compare'));
                    }
                }
            }
        }
    } catch (e) {
        console.error(LOG, e);
        setStatus(`❌ 오류: ${e.message}`);
        toastr.error(`테스트 실패: ${e.message}`);
    } finally {
        if (!handedOff) {
            setMinimized(false);
            running = false;
            updateRunState();
        }
    }
}

function stopTest() {
    stopRequested = true;
    try { ctx().stopGeneration(); } catch { /* ignore */ }
    setStatus('⏹ 중단 요청됨…');
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

const EVAL_CATEGORIES = ['말투·어휘', '성격·가치관', '원작 설정·세계관', '인간관계', '행동·반응 패턴', '재미·몰입'];

/** Depth of unclosed {}/[] outside of strings — > 0 means the output was cut off. */
function jsonOpenDepth(t) {
    let depth = 0, inStr = false, esc = false;
    for (const ch of t) {
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') depth--;
    }
    return { depth, inStr };
}

/**
 * Tolerant JSON extraction from LLM output: strips reasoning / code fences / chatter,
 * then repairs unescaped quotes & newlines, trailing commas, comments and cut-off output.
 * Sets `__truncated` on the result when the model stopped mid-JSON.
 */
function parseJsonLoose(text, opener = '{') {
    const closer = opener === '{' ? '}' : ']';
    let t = stripReasoning(String(text ?? ''))
        .replace(/^﻿/, '')
        .replace(/```[a-zA-Z]*\s*/g, '')
        .trim();
    const a = t.indexOf(opener);
    if (a === -1) throw new Error('JSON을 찾을 수 없음');
    t = t.slice(a);
    const b = t.lastIndexOf(closer);
    const { depth, inStr } = jsonOpenDepth(t);
    const truncated = depth > 0 || inStr || b === -1;
    const candidates = truncated ? [t] : [t.slice(0, b + 1), t];
    const check = (v) => {
        if (opener === '{' ? (v && typeof v === 'object' && !Array.isArray(v)) : Array.isArray(v)) return v;
        throw new Error('형식 불일치');
    };
    for (const c of candidates) {
        try { return check(JSON.parse(c)); } catch { /* next */ }
        for (const variant of [c, escapeStrayQuotes(c)]) {
            try {
                const v = check(JSON.parse(jsonrepair(variant)));
                if (truncated && opener === '{') Object.defineProperty(v, '__truncated', { value: true, enumerable: false });
                return v;
            } catch { /* next */ }
        }
    }
    throw new Error('JSON 파싱 실패');
}

/**
 * LLMs often write unescaped " inside strings (e.g. "그가 "선배"라고 했다").
 * Treat a quote as closing only if what follows looks like JSON structure; otherwise escape it.
 * Also escapes raw newlines/tabs inside strings.
 */
function escapeStrayQuotes(t) {
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if (!inStr) {
            if (ch === '/' && t[i + 1] === '/') { // strip // comments outside strings
                while (i < t.length && t[i] !== '\n') i++;
                out += '\n';
                continue;
            }
            if (ch === '"') inStr = true;
            out += ch;
            continue;
        }
        if (esc) { esc = false; out += ch; continue; }
        if (ch === '\\') { esc = true; out += ch; continue; }
        if (ch === '\n') { out += '\\n'; continue; }
        if (ch === '\r') continue;
        if (ch === '\t') { out += '\\t'; continue; }
        if (ch === '"') {
            const nextRe = /\s*(.)/sy;
            nextRe.lastIndex = i + 1;
            const m = nextRe.exec(t);
            const next = m ? m[1] : '';
            let closes = next === '' || next === '}' || next === ']';
            if (next === ',' || next === ':') {
                const afterRe = /\s*[,:]\s*(.?)/sy;
                afterRe.lastIndex = i + 1;
                const a2 = afterRe.exec(t);
                const after = a2 ? a2[1] : '';
                closes = after === '' || /["{\[\]}\d\-tfn]/.test(after);
            }
            if (closes) { inStr = false; out += ch; } else { out += '\\"'; }
            continue;
        }
        out += ch;
    }
    return out;
}

/**
 * Calls the LLM for JSON. If the reply still can't be parsed, asks the model once
 * to rewrite its own reply as valid JSON. Throws an Error with `.raw` on failure.
 */
async function requestJson({ system, prompt, profileId = '', maxTokens = 4000, label = '🤖 AI 응답 대기 중…', quietTruncation = false }) {
    const raw = await withTimer(label, callLLM({ system, prompt, profileId, maxTokens }));
    try {
        const data = parseJsonLoose(raw);
        if (data.__truncated && !quietTruncation) toastr.warning('결과가 길어서 끝부분이 잘렸어요. 설정에서 최대 토큰을 늘리면 전부 나와요.');
        return data;
    } catch (e) {
        console.warn(LOG, 'JSON parse failed, asking model to repair. raw:', raw);
    }
    const fixed = await withTimer('🧩 결과 형식 다시 맞추는 중…', callLLM({
        system: 'You convert text into strictly valid JSON. Output ONLY one JSON object. No markdown fences, no comments, no explanations. Escape every double quote inside strings. Keep all content and keys; close anything left unfinished.',
        prompt: `Rewrite the following as ONE valid JSON object:\n\n${raw}`,
        profileId,
        maxTokens,
    }));
    try {
        return parseJsonLoose(fixed);
    } catch {
        const err = new Error('결과를 JSON으로 읽지 못했어요');
        err.raw = raw;
        throw err;
    }
}

async function runEvaluation({ useChat = true, messages = 0 } = {}) {
    if (running) { toastr.warning('다른 작업이 진행 중이에요'); return; }
    const char = getCurrentCharacter();
    if (!char) { toastr.error('1:1 캐릭터 채팅을 열어주세요'); return; }

    const s = getSettings();
    const charData = await loadCharData(char);
    if (!charData.refText?.trim()) {
        toastr.warning('원작 자료가 없어요. “원작 자료” 탭에서 링크를 불러오거나 내용을 붙여넣어 주세요.');
        switchTab('source');
        return;
    }

    const chatLog = useChat ? collectChatLog(Math.max(Number(messages) || 0, Number(s.evalMessages) || 20)) : '';
    if (useChat && !chatLog.trim()) {
        toastr.warning('평가할 대화가 없어요. 먼저 테스트를 돌리거나 “카드만 평가”를 눌러주세요.');
        return;
    }

    running = true;
    updateRunState();
    setStatus('🔎 원작과 비교 평가 중… (시간이 좀 걸려요)');

    const system = [
        'You are a meticulous fandom expert and character-bot reviewer.',
        'Compare how a fan-made roleplay bot portrays a character against the ORIGINAL source material, and give actionable feedback to the bot creator.',
        'Judge ONLY against the provided reference material. If the reference does not cover something, do not invent canon — say the reference lacks it.',
        'Differences the creator explicitly marked as intentional (AU / 설정 변경) must NOT reduce the score; mention them as "의도된 변경" at most.',
        `Write every human-readable string in ${s.language}.`,
        'JSON rules: straight double quotes for keys/strings, escape any " inside strings as \\", no trailing commas, no comments. Keep lists short (max 6 issues, 5 card_suggestions).',
        'Respond with ONE JSON object only, no markdown fences, matching this shape:',
        '{',
        '  "overall": <integer 0-100, faithfulness to the original>,',
        '  "fun": <integer 0-100, how fun and immersive the bot is to roleplay with: scene hooks, vivid physical beats, humor/gags, tension and escalation, subtext, room for {{user}} to act>,',
        `  "categories": [ {"name": one of ${JSON.stringify(EVAL_CATEGORIES)}, "score": <0-100>, "comment": "<1-2 sentences>"} ],`,
        '  "summary": "<2-3 sentence overall verdict>",',
        '  "strengths": ["<what matches canon well>", ...],',
        '  "issues": [ {"severity": "high"|"medium"|"low", "category": "<category name>", "problem": "<what is off vs canon>", "evidence": "<short quote from the chat or card>", "canon": "<what the reference says>", "fix": "<concrete fix>"} ],',
        `  "card_suggestions": [ {"field": "description"|"personality"|"scenario"|"first_mes"|"mes_example"|"lorebook"|"system_prompt", "action": "add"|"edit"|"remove", "text": "<ready-to-paste sentence(s) for the card>", "reason": "<why>", ${FUN_IMPACT_DOC}} ],`,
        '  "missing_info": ["<important canon facts the card does not cover yet>", ...]',
        '}',
        'Scoring guide: 90+ = feels like the original character; 70-89 = mostly right with noticeable slips; 50-69 = recognizable but often off; <50 = largely a different character.',
        'Canon fixes must be written as PLAYABLE cues (how the trait shows up in a scene: a gesture, a line, a trigger) — not as wiki facts to memorize. Never propose a suggestion with fun_impact "-" unless the canon error is severe; say so in fun_note.',
        funGuard(charData),
        useChat
            ? 'Weigh the BOT messages in the test chat most heavily (actual behavior), and use the card to explain WHY problems happen.'
            : 'There is no chat log: evaluate the character card itself (how well it would reproduce the original).',
    ].join('\n');

    const prompt = [
        `[원작 자료: ${char.name}]\n${truncate(charData.refText, Number(s.refMaxChars) || 15000)}`,
        charData.authorNote ? `[제작자 메모 — 의도한 AU/설정 변경 (감점 금지)]\n${charData.authorNote}` : '',
        `[캐릭터 카드]\n${collectCard(char)}`,
        useChat ? `[테스트 대화 로그 (최근 ${s.evalMessages}개)]\n${chatLog}` : '',
        'Now output the JSON evaluation.',
    ].filter(Boolean).join('\n\n');

    try {
        let result;
        try {
            result = await requestJsonComplete({ system, prompt, profileId: s.evalProfile, maxTokens: evalTokens(), label: '🔎 원작과 비교 평가 중…' });
        } catch (e) {
            if (!e.raw) throw e;
            renderRawResult(e.raw);
            setStatus('⚠️ 두 번 시도했지만 결과 형식이 깨져서 원문을 보여드려요');
            return;
        }
        result.overall = Math.max(0, Math.min(100, Math.round(Number(result.overall) || 0)));
        const entry = {
            time: Date.now(),
            mode: useChat ? 'chat' : 'card',
            chatId: ctx().getCurrentChatId?.() ?? '',
            result,
        };
        charData.history = [entry, ...(charData.history || [])].slice(0, 20);
        await saveCharData(char, charData);
        renderResult(entry, charData.history[1]);
        renderHistory(charData.history);
        switchTab('result');
        setMinimized(false);
        setStatus(`✅ 평가 완료: 원작 일치도 ${result.overall}%`);
        toastr.success(`원작 일치도 ${result.overall}%`);
        return entry;
    } catch (e) {
        console.error(LOG, e);
        setStatus(`❌ 평가 실패: ${e.message}`);
        toastr.error(`평가 실패: ${e.message}${e.cause ? ' / ' + (e.cause.message || e.cause) : ''}`);
    } finally {
        running = false;
        updateRunState();
    }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const $id = (id) => document.getElementById(`bt_${id}`);

function scoreColor(n) {
    if (n >= 85) return 'var(--bt-good)';
    if (n >= 65) return 'var(--bt-ok)';
    if (n >= 45) return 'var(--bt-warn)';
    return 'var(--bt-bad)';
}

// ---------- small UI building blocks ----------

const ico = (name) => `<i class="fa-solid fa-${name}" aria-hidden="true"></i>`;

function field(label, control, hint = '') {
    return `<div class="bt-field"><label class="bt-field-label">${label}${hint ? `<span class="bt-field-hint">${hint}</span>` : ''}</label>${control}</div>`;
}

function toggle(id, title, desc = '') {
    return `<label class="bt-switch"><input type="checkbox" id="bt_${id}"><span class="bt-switch-track" aria-hidden="true"></span>
        <span class="bt-switch-text"><span>${title}</span>${desc ? `<small>${desc}</small>` : ''}</span></label>`;
}

function cardHead(eyebrow, title, desc = '') {
    return `<header class="bt-card-head">${eyebrow ? `<span class="bt-eyebrow">${eyebrow}</span>` : ''}<h3>${title}</h3>${desc ? `<p class="bt-desc">${desc}</p>` : ''}</header>`;
}

/** Escapes and splits long AI text into readable paragraphs (2 sentences each). */
function prose(text, perPara = 2) {
    const t = String(text ?? '').trim();
    if (!t) return '';
    let paras = t.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
    if (paras.length === 1 && t.length > 110 && !t.includes('\n')) {
        const sentences = t.replace(/([.!?。！？](?:["'”’」』)\]]*))\s+/g, '$1\u0001').split('\u0001').map(x => x.trim()).filter(Boolean);
        paras = [];
        for (let i = 0; i < sentences.length; i += perPara) paras.push(sentences.slice(i, i + perPara).join(' '));
    }
    return paras.map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

function ringHtml(score, size = 'lg') {
    const r = 42;
    const c = 2 * Math.PI * r;
    const off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
    return `<div class="bt-ring bt-ring-${size}">
        <svg viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="${r}" class="bt-ring-bg"></circle>
            <circle cx="50" cy="50" r="${r}" class="bt-ring-fg" style="stroke:${scoreColor(score)}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" transform="rotate(-90 50 50)"></circle>
        </svg>
        <div class="bt-ring-val">${score}<span>%</span></div>
    </div>`;
}

function deltaHtml(now, before) {
    if (before === undefined || before === null || Number.isNaN(Number(before))) return '';
    const d = Math.round(now - Number(before));
    if (d === 0) return '<span class="bt-delta">±0</span>';
    return `<span class="bt-delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? ico('arrow-up') : ico('arrow-down')}${Math.abs(d)}</span>`;
}

function meterHtml(label, score, { sub = '', delta = '' } = {}) {
    if (score === null || score === undefined) {
        return `<div class="bt-meter"><div class="bt-meter-top"><span class="bt-meter-label">${label}</span><span class="bt-meter-val muted">—</span></div>${sub ? `<div class="bt-meter-sub">${prose(sub)}</div>` : ''}</div>`;
    }
    const sc = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
    return `<div class="bt-meter">
        <div class="bt-meter-top"><span class="bt-meter-label">${label}</span><span class="bt-meter-val">${delta}<b style="color:${scoreColor(sc)}">${sc}</b><small>%</small></span></div>
        <div class="bt-bar"><i style="width:${sc}%;background:${scoreColor(sc)}"></i></div>
        ${sub ? `<div class="bt-meter-sub">${prose(sub)}</div>` : ''}
    </div>`;
}

function codeTag(v) {
    const meta = VOICE_VERSIONS[v];
    return meta ? `<span class="bt-code">${meta.code}</span>` : '';
}

function versionTitle(v) {
    const meta = VOICE_VERSIONS[v];
    return meta ? `${codeTag(v)}<span>${meta.label}</span>` : escapeHtml(v);
}

function copyBtn(cls, idx) {
    return `<button type="button" class="bt-iconbtn ${cls}" data-idx="${idx}" title="복사">${ico('copy')}</button>`;
}

function emptyState(icon, text) {
    return `<div class="bt-empty">${ico(icon)}<p>${text}</p></div>`;
}

// ---------- panel ----------

function buildPanel() {
    if ($id('panel')) return;
    const scenarioOptions = Object.entries(SCENARIO_LABELS)
        .map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('');

    const html = `
<div id="bt_panel" class="bt-panel" style="display:none" data-accent="champagne">
  <div id="bt_header" class="bt-header" title="드래그해서 옮길 수 있어요">
    <div class="bt-brand">
      <span class="bt-logo">${ico('flask-vial')}</span>
      <div class="bt-brand-text">
        <span class="bt-title">Bot Tester</span>
        <span id="bt_charname" class="bt-charname"></span>
      </div>
    </div>
    <span id="bt_hstatus" class="bt-hstatus"></span>
    <div class="bt-header-btns">
      <button type="button" id="bt_resetpos" class="bt-iconbtn bt-icon" title="위치 초기화">${ico('arrows-to-dot')}</button>
      <button type="button" id="bt_minimize" class="bt-iconbtn bt-icon" title="접기 / 펴기">${ico('minus')}</button>
      <button type="button" id="bt_close" class="bt-iconbtn bt-icon" title="닫기">${ico('xmark')}</button>
    </div>
  </div>

  <nav class="bt-tabs" role="tablist">
    <button type="button" class="bt-tab active" data-tab="source" title="원작 자료">${ico('book-open')}<span>원작</span></button>
    <button type="button" class="bt-tab" data-tab="test" title="자동 테스트">${ico('flask')}<span>테스트</span></button>
    <button type="button" class="bt-tab" data-tab="result" title="평가 결과">${ico('chart-simple')}<span>결과</span></button>
    <button type="button" class="bt-tab" data-tab="voice" title="말투·성격 검증">${ico('comment-dots')}<span>말투</span></button>
    <button type="button" class="bt-tab" data-tab="doctor" title="카드 진단">${ico('stethoscope')}<span>진단</span></button>
    <button type="button" class="bt-tab" data-tab="settings" title="설정">${ico('sliders')}<span>설정</span></button>
  </nav>

  <div id="bt_body" class="bt-body">

    <div class="bt-page" data-page="source">
      <section class="bt-card">
        ${cardHead('Step 1', '위키 링크', '픽시브 백과사전, 나무위키, 팬덤 위키 링크를 한 줄에 하나씩 넣어주세요.<br>캐릭터마다 따로 저장돼요.')}
        <textarea id="bt_urls" class="bt-input bt-mono" rows="3" placeholder="https://namu.wiki/w/…&#10;https://dic.pixiv.net/a/…&#10;https://xxx.fandom.com/wiki/…"></textarea>
        <div class="bt-actions">
          <button type="button" id="bt_fetch" class="bt-btn bt-btn-primary">${ico('download')}<span>링크 불러오기</span></button>
          ${toggle('append', '기존 자료에 이어붙이기')}
        </div>
      </section>

      <section class="bt-card">
        ${cardHead('Step 2', '원작 자료', '불러온 내용을 다듬어 주세요. 성우·굿즈처럼 관련 없는 부분을 지우면 평가가 더 정확해져요.')}
        <div class="bt-field-meta"><span id="bt_refcount"></span></div>
        <textarea id="bt_reftext" class="bt-input bt-reftext" rows="10" placeholder="불러온 위키 내용이 여기에 들어와요.&#10;수집이 막힌 사이트는 직접 복사해서 붙여넣어도 돼요."></textarea>
      </section>

      <section class="bt-card">
        ${cardHead('Optional', '제작자 메모', '일부러 바꾼 설정(AU, 시점 등)을 적어두면 평가할 때 감점하지 않아요.')}
        <textarea id="bt_authornote" class="bt-input" rows="3" placeholder="예) 현대 AU라서 마법은 안 씀&#10;원작 3부 이후 시점 / {{user}}와는 소꿉친구"></textarea>
        <div class="bt-actions bt-actions-end">
          <button type="button" id="bt_ref_undo" class="bt-btn" style="display:none">${ico('rotate-left')}<span>요약 되돌리기</span></button>
          <button type="button" id="bt_ref_diet" class="bt-btn" title="원작 자료를 성격·말투·관계 위주로 요약해서 평가 토큰을 줄여요">${ico('scissors')}<span>요약해서 줄이기</span></button>
          <button type="button" id="bt_savesrc" class="bt-btn">${ico('floppy-disk')}<span>저장</span></button>
        </div>
      </section>
    </div>

    <div class="bt-page" data-page="test" style="display:none">
      <section class="bt-card">
        ${cardHead('Auto test', '자동 테스트', 'AI가 {{user}} 역할로 메시지를 보내고, 봇의 답변을 모아 원작과 비교해요.')}
        <div class="bt-grid2">
          ${field('턴 수', '<input id="bt_turns" class="bt-input bt-num" type="number" min="1" max="50">')}
          ${field('테스트 유형', `<select id="bt_scenario" class="bt-input">${scenarioOptions}</select>`)}
        </div>
        ${field('메시지 작성 방식', `<select id="bt_genmode" class="bt-input">
            <option value="batch">빠르게 — 한 번에 미리 작성</option>
            <option value="adaptive">자연스럽게 — 매 턴 답장을 보고 작성</option>
          </select>`)}
        ${field('추가 지시', '<textarea id="bt_custom" class="bt-input" rows="2" placeholder="예) 라이벌 이야기를 꼭 꺼내줘 / 연애 감정 반응 위주로"></textarea>', '선택')}
        <div class="bt-switches">
          ${toggle('newchat', '새 채팅에서 테스트', '기존 채팅은 건드리지 않아요 (추천)')}
          ${toggle('autoeval', '끝나면 바로 평가')}
        </div>
        <div class="bt-actions">
          <button type="button" id="bt_run" class="bt-btn bt-btn-primary bt-btn-wide">${ico('play')}<span>테스트 시작</span></button>
          <button type="button" id="bt_stop" class="bt-btn bt-btn-danger" style="display:none">${ico('stop')}<span>중단</span></button>
        </div>
      </section>

      <section class="bt-card">
        ${cardHead('Evaluate only', '바로 평가하기', '이미 대화해 둔 채팅이 있다면 테스트 없이 평가할 수 있어요.')}
        <div class="bt-actions bt-actions-split">
          <button type="button" id="bt_evalchat" class="bt-btn">${ico('magnifying-glass-chart')}<span>현재 채팅 평가</span></button>
          <button type="button" id="bt_evalcard" class="bt-btn">${ico('id-card')}<span>카드만 평가</span></button>
        </div>
      </section>
${abPanelHtml()}
    </div>

    <div class="bt-page" data-page="result" style="display:none">
      <div id="bt_ab_compare" class="bt-result"></div>
      <div id="bt_result" class="bt-result">${emptyState('chart-simple', '아직 평가 결과가 없어요.')}</div>
      <section class="bt-card bt-card-flat">
        ${cardHead('', '이전 기록')}
        <div id="bt_history" class="bt-history"></div>
      </section>
    </div>

${voicePageHtml()}

${doctorPageHtml()}

    <div class="bt-page" data-page="settings" style="display:none">
      <section class="bt-card">
        ${cardHead('Models', '연결')}
        ${field('테스터용 연결', '<select id="bt_testerprofile" class="bt-input"></select>', '생각(Reasoning)을 끈 빠른 모델 추천')}
        ${field('평가용 연결', '<select id="bt_evalprofile" class="bt-input"></select>', '똑똑한 모델 추천')}
        <p class="bt-note">Connection Profiles(연결 프로필) 중에서 골라요. 비워두면 지금 연결된 API를 써요.</p>
      </section>

      <section class="bt-card">
        ${cardHead('Evaluation', '평가')}
        <div class="bt-grid2">
          ${field('응답 언어', '<input id="bt_language" class="bt-input" type="text">')}
          ${field('최근 메시지 수', '<input id="bt_evalmsgs" class="bt-input bt-num" type="number" min="2" max="200">')}
          ${field('원작 자료 최대 글자', '<input id="bt_refmax" class="bt-input bt-num" type="number" min="1000" max="200000" step="1000">')}
          ${field('평가 최대 토큰', '<input id="bt_evaltokens" class="bt-input bt-num" type="number" min="500" max="32000" step="100">')}
          ${field('프로필 최대 토큰', '<input id="bt_proftokens" class="bt-input bt-num" type="number" min="1000" max="32000" step="500">')}
          ${field('테스트 메시지 최대 토큰', '<input id="bt_testertokens" class="bt-input bt-num" type="number" min="256" max="16000" step="128">')}
        </div>
        ${field('웹 검색 방식', `<select id="bt_searchengine" class="bt-input">
            <option value="auto">자동 — DuckDuckGo · Bing + 레딧 (키 불필요)</option>
            <option value="serper">Serper (Google, API 키 필요)</option>
            <option value="tavily">Tavily (API 키 필요)</option>
            <option value="serpapi">SerpApi (API 키 필요)</option>
          </select>`)}
        <div class="bt-switches">
          ${toggle('lorebook', '내장 로어북도 평가에 포함')}
        </div>
      </section>

      <section class="bt-card">
        ${cardHead('Interface', '화면')}
        <div class="bt-grid2">
          ${field('강조 색', `<select id="bt_accent" class="bt-input">
              <option value="champagne">샴페인 골드</option>
              <option value="lavender">라벤더</option>
              <option value="sage">세이지</option>
              <option value="rose">로즈</option>
              <option value="ice">아이스 블루</option>
              <option value="theme">테마 색 따르기</option>
            </select>`)}
          ${field('턴 사이 대기 (ms)', '<input id="bt_delay" class="bt-input bt-num" type="number" min="0" max="30000" step="100">')}
        </div>
        <div class="bt-switches">
          ${toggle('automin', '모바일 테스트 중 패널 자동 접기')}
        </div>
      </section>
    </div>
  </div>

  <div class="bt-resize bt-resize-l" data-edge="l" title="끌어서 폭 조절" aria-hidden="true"></div>
  <div class="bt-resize bt-resize-r" data-edge="r" title="끌어서 폭 조절" aria-hidden="true"></div>
  <footer class="bt-footer" data-state="idle">
    <span class="bt-status-dot" aria-hidden="true"></span>
    <span id="bt_status" class="bt-status">대기 중</span>
  </footer>
</div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    bindPanel();
}

function fillProfileSelect(sel, value) {
    const profiles = getProfiles();
    sel.innerHTML = `<option value="">현재 연결 사용</option>` +
        profiles.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
    sel.value = profiles.some(p => p.id === value) ? value : '';
}

function bindPanel() {
    const s = getSettings();

    $id('close').addEventListener('click', () => togglePanel(false));
    $id('minimize').addEventListener('click', () => setMinimized(!$id('panel').classList.contains('bt-min')));
    $id('resetpos').addEventListener('click', resetPanel);
    makeDraggable();

    document.querySelectorAll('#bt_panel .bt-tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Settings bindings
    const bindNum = (id, key) => {
        const el = $id(id);
        el.value = s[key];
        el.addEventListener('change', () => { s[key] = Number(el.value) || defaultSettings[key]; saveSettings(); });
    };
    const bindText = (id, key) => {
        const el = $id(id);
        el.value = s[key];
        el.addEventListener('input', () => { s[key] = el.value; saveSettings(); });
    };
    const bindCheck = (id, key) => {
        const el = $id(id);
        el.checked = !!s[key];
        el.addEventListener('change', () => { s[key] = el.checked; saveSettings(); });
    };
    bindNum('turns', 'turns');
    bindNum('evalmsgs', 'evalMessages');
    bindNum('refmax', 'refMaxChars');
    bindNum('evaltokens', 'evalMaxTokens');
    bindNum('delay', 'delayMs');
    bindNum('testertokens', 'testerMaxTokens');
    bindCheck('automin', 'autoMinimize');
    const ac = $id('accent');
    ac.value = s.accent;
    $id('panel').dataset.accent = s.accent;
    ac.addEventListener('change', () => { s.accent = ac.value; $id('panel').dataset.accent = ac.value; saveSettings(); });
    bindNum('proftokens', 'profileMaxTokens');
    const se = $id('searchengine');
    se.value = s.searchEngine;
    se.addEventListener('change', () => { s.searchEngine = se.value; saveSettings(); });
    bindVoicePage();
    bindDoctorPage();
    bindDietUI();
    $id('ab_runb').addEventListener('click', () => { if (!running) runAbB(); });
    $id('ab_pin').addEventListener('click', () => { if (!running) pinLatestAsA(); });
    const gm = $id('genmode');
    gm.value = s.genMode;
    gm.addEventListener('change', () => { s.genMode = gm.value; saveSettings(); });
    bindText('custom', 'customInstruction');
    bindText('language', 'language');
    bindCheck('newchat', 'newChat');
    bindCheck('autoeval', 'autoEvalAfterTest');
    bindCheck('lorebook', 'includeLorebook');

    const scen = $id('scenario');
    scen.value = s.scenario;
    scen.addEventListener('change', () => { s.scenario = scen.value; saveSettings(); });

    for (const [id, key] of [['testerprofile', 'testerProfile'], ['evalprofile', 'evalProfile']]) {
        const el = $id(id);
        fillProfileSelect(el, s[key]);
        el.addEventListener('focus', () => fillProfileSelect(el, s[key]));
        el.addEventListener('change', () => { s[key] = el.value; saveSettings(); });
    }

    // Source page
    $id('reftext').addEventListener('input', updateRefCount);
    $id('savesrc').addEventListener('click', () => saveSourceFromUI(true));
    $id('fetch').addEventListener('click', onFetchClick);

    // Test page
    $id('run').addEventListener('click', async () => {
        await saveSourceFromUI(false);
        runTest();
    });
    $id('stop').addEventListener('click', stopTest);
    $id('evalchat').addEventListener('click', async () => { await saveSourceFromUI(false); runEvaluation({ useChat: true }); });
    $id('evalcard').addEventListener('click', async () => { await saveSourceFromUI(false); runEvaluation({ useChat: false }); });
}

function switchTab(name) {
    document.querySelectorAll('#bt_panel .bt-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('#bt_panel .bt-page').forEach(p => { p.style.display = p.dataset.page === name ? '' : 'none'; });
    const body = $id('body');
    if (body) body.scrollTop = 0;
    if (name === 'doctor') { runDoctorLocal(true); refreshDietList(); }
    if (name === 'settings') {
        const s = getSettings();
        fillProfileSelect($id('testerprofile'), s.testerProfile);
        fillProfileSelect($id('evalprofile'), s.evalProfile);
    }
}

const STATUS_ICONS = [
    [/^✅\s*/, 'ok'], [/^❌\s*/, 'error'], [/^⚠️?\s*/, 'warn'], [/^⏹\s*/, 'stop'],
    [/^(?:🧪|💬|📝|🔎|📥|🌐|🧠|🗣|✨|🧩|🤖|🧮|🩺|🎭|✂️?)\s*/u, 'busy'],
];

function setStatus(text) {
    let t = String(text || '');
    let state = running ? 'busy' : 'idle';
    for (const [re, st] of STATUS_ICONS) {
        if (re.test(t)) { t = t.replace(re, ''); state = st; break; }
    }
    const el = $id('status');
    if (el) el.textContent = t || '대기 중';
    const footer = el?.closest('.bt-footer');
    if (footer) footer.dataset.state = t ? state : 'idle';
    const h = $id('hstatus');
    if (h) h.textContent = t.split('\n')[0];
}

// ---------------------------------------------------------------------------
// Panel position / drag / minimize
// ---------------------------------------------------------------------------

function isNarrow() {
    return window.matchMedia('(max-width: 768px)').matches;
}

function setMinimized(min) {
    const panel = $id('panel');
    if (!panel) return;
    panel.classList.toggle('bt-min', !!min);
    applyPanelWidth();
    clampPanel();
}

/**
 * Scroll inside the panel only. (Element.scrollIntoView also scrolls SillyTavern's
 * page on some browsers — especially mobile Safari — which pushed the panel header
 * off-screen so it could not be moved or closed.)
 */
function scrollPanelTo(el) {
    const body = $id('body');
    if (!body || !el) return;
    const top = el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 6;
    body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    resetPageScroll();
}

/** SillyTavern's page itself never scrolls; undo any accidental page scroll. */
function resetPageScroll() {
    for (const el of [document.documentElement, document.body]) {
        if (el && (el.scrollTop || el.scrollLeft)) { el.scrollTop = 0; el.scrollLeft = 0; }
    }
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
}

function viewportSize() {
    const vv = window.visualViewport;
    return { vw: vv?.width || window.innerWidth, vh: vv?.height || window.innerHeight };
}

function clampPanel() {
    const panel = $id('panel');
    if (!panel || panel.style.display === 'none') return;
    const { vw, vh } = viewportSize();
    if (panel.classList.contains('bt-floating')) {
        const r = panel.getBoundingClientRect();
        const x = Math.min(Math.max(0, r.left), Math.max(0, vw - r.width));
        // keep the header always reachable and leave room for the body
        const y = Math.min(Math.max(0, r.top), Math.max(0, vh - 160));
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
        panel.style.maxHeight = `${Math.max(120, Math.min(vh - y - 8, isNarrow() ? vh * 0.85 : vh))}px`;
    } else {
        panel.style.maxHeight = '';
    }
}

function applyPanelWidth() {
    const panel = $id('panel');
    if (!panel) return;
    const w = Number(getSettings().panelWidth);
    if (isNarrow() || panel.classList.contains('bt-min') || !w) { panel.style.width = ''; return; }
    panel.style.width = `${Math.max(360, Math.min(w, window.innerWidth - 16))}px`;
}

function applyPanelPos() {
    applyPanelWidth();
    const panel = $id('panel');
    if (!panel) return;
    const pos = getSettings().panelPos;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        panel.classList.add('bt-floating');
        panel.style.left = `${pos.x}px`;
        panel.style.top = `${pos.y}px`;
        clampPanel();
    } else {
        panel.classList.remove('bt-floating');
        panel.style.left = '';
        panel.style.top = '';
        panel.style.maxHeight = '';
    }
}

function makeDraggable() {
    const panel = $id('panel');
    const handle = $id('header');
    let drag = null;

    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (e.target.closest('.bt-icon')) return;
        const r = panel.getBoundingClientRect();
        drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, sx: e.clientX, sy: e.clientY };
        handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
        if (!drag.moved) {
            // switch from docked (CSS right/top) to free-floating coordinates
            const r = panel.getBoundingClientRect();
            panel.classList.add('bt-floating', 'bt-dragging');
            panel.style.left = `${r.left}px`;
            panel.style.top = `${r.top}px`;
            drag.moved = true;
        }
        e.preventDefault();
        panel.style.left = `${e.clientX - drag.dx}px`;
        panel.style.top = `${e.clientY - drag.dy}px`;
        clampPanel();
    });

    const end = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const wasMoved = drag.moved;
        drag = null;
        panel.classList.remove('bt-dragging');
        try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        if (wasMoved) {
            const r = panel.getBoundingClientRect();
            getSettings().panelPos = { x: Math.round(r.left), y: Math.round(r.top) };
            saveSettings();
        }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);

    // double-click / double-tap header toggles minimize
    handle.addEventListener('dblclick', (e) => {
        if (e.target.closest('.bt-icon')) return;
        setMinimized(!panel.classList.contains('bt-min'));
    });

    window.addEventListener('resize', () => { applyPanelWidth(); clampPanel(); });

    // The panel itself must never scroll (only its body does). Browsers can still scroll an
    // overflow:hidden box when a hidden checkbox gets focus — undo that immediately.
    panel.addEventListener('scroll', () => { if (panel.scrollTop || panel.scrollLeft) { panel.scrollTop = 0; panel.scrollLeft = 0; } });

    // drag the left / right edge to change the width (desktop)
    for (const grip of panel.querySelectorAll('.bt-resize')) {
        let rs = null;
        grip.addEventListener('pointerdown', (e) => {
            if (isNarrow() || panel.classList.contains('bt-min')) return;
            e.preventDefault();
            e.stopPropagation();
            const r = panel.getBoundingClientRect();
            // switch to free-floating coordinates so both edges can move
            panel.classList.add('bt-floating', 'bt-resizing');
            panel.style.left = `${r.left}px`;
            panel.style.top = `${r.top}px`;
            panel.style.width = `${r.width}px`;
            rs = { id: e.pointerId, edge: grip.dataset.edge, x: e.clientX, left: r.left, width: r.width };
            grip.setPointerCapture(e.pointerId);
        });
        grip.addEventListener('pointermove', (e) => {
            if (!rs || e.pointerId !== rs.id) return;
            const vw = window.innerWidth;
            const dx = e.clientX - rs.x;
            if (rs.edge === 'r') {
                const w = Math.max(360, Math.min(rs.width + dx, vw - rs.left - 4));
                panel.style.width = `${w}px`;
            } else {
                const right = rs.left + rs.width;
                const left = Math.max(4, Math.min(rs.left + dx, right - 360));
                panel.style.left = `${left}px`;
                panel.style.width = `${right - left}px`;
            }
        });
        const end = (e) => {
            if (!rs || e.pointerId !== rs.id) return;
            rs = null;
            panel.classList.remove('bt-resizing');
            try { grip.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            const r = panel.getBoundingClientRect();
            const s2 = getSettings();
            s2.panelWidth = Math.round(r.width);
            s2.panelPos = { x: Math.round(r.left), y: Math.round(r.top) };
            saveSettings();
            clampPanel();
        };
        grip.addEventListener('pointerup', end);
        grip.addEventListener('pointercancel', end);
        grip.addEventListener('dblclick', () => { getSettings().panelWidth = null; saveSettings(); applyPanelWidth(); clampPanel(); });
    }
    window.visualViewport?.addEventListener('resize', clampPanel);
    // Esc closes the panel (desktop)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel.style.display !== 'none' && panel.contains(document.activeElement || null)) togglePanel(false);
    });
}

function updateRunState() {
    const run = $id('run');
    if (!run) return;
    $id('stop').style.display = running ? '' : 'none';
    for (const id of ['run', 'evalchat', 'evalcard', 'fetch', 'buildprofile', 'autonames', 'diet_run', 'ref_diet']) {
        $id(id)?.classList.toggle('disabled', running);
    }
    document.querySelectorAll('#bt_panel .bt-vset-btn').forEach(b => b.classList.toggle('disabled', running));
    $id('panel')?.classList.toggle('bt-busy', running);
    if (running) { $id('ab_runb')?.classList.add('disabled'); $id('ab_pin')?.classList.add('disabled'); }
    else { const ch = getCurrentCharacter(); if (ch) loadCharData(ch).then(renderAbPanel); }
}

function updateRefCount() {
    const len = ($id('reftext')?.value || '').length;
    const max = getSettings().refMaxChars;
    const el = $id('refcount');
    if (el) el.textContent = len ? `${len.toLocaleString()}자${len > max ? ` · 평가에는 앞 ${max.toLocaleString()}자만 사용` : ''}` : '';
}

async function refreshPanelForChar() {
    if (!$id('panel')) return;
    const char = getCurrentCharacter();
    $id('charname').textContent = char ? char.name : '캐릭터 없음';
    const data = await loadCharData(char);
    $id('urls').value = (data.urls || []).join('\n');
    $id('reftext').value = data.refText || '';
    $id('authornote').value = data.authorNote || '';
    updateRefCount();
    renderHistory(data.history || []);
    renderVoiceForChar(data);
    renderDoctorForChar(data);
    renderAbPanel(data);
    renderAbCompare(data);
    renderApplyLog(data);
    dietResults = {};
    renderDietResults();
    if ($id('ref_undo')) $id('ref_undo').style.display = data.refBackup ? '' : 'none';
    const dp = document.querySelector('#bt_panel .bt-page[data-page="doctor"]');
    if (dp && dp.style.display !== 'none') refreshDietList();
    if (data.history?.length) renderResult(data.history[0], data.history[1]);
    else $id('result').innerHTML = emptyState('chart-simple', '아직 평가 결과가 없어요.<br>테스트 탭에서 테스트하거나 바로 평가해 보세요.');
    setStatus(char ? '' : '캐릭터와 1:1 채팅을 열면 사용할 수 있어요.');
}

async function saveSourceFromUI(notify) {
    const char = getCurrentCharacter();
    if (!char) { if (notify) toastr.error('캐릭터 채팅을 먼저 열어주세요'); return; }
    const data = await loadCharData(char);
    data.urls = $id('urls').value.split('\n').map(x => x.trim()).filter(Boolean);
    data.refText = $id('reftext').value;
    data.authorNote = $id('authornote').value;
    await saveCharData(char, data);
    if (notify) toastr.success(`${char.name}의 원작 자료를 저장했어요`);
}

async function onFetchClick() {
    if (running) return;
    const char = getCurrentCharacter();
    if (!char) { toastr.error('캐릭터 채팅을 먼저 열어주세요'); return; }
    const urls = $id('urls').value.split('\n').map(x => x.trim()).filter(Boolean);
    if (!urls.length) { toastr.warning('링크를 넣어주세요'); return; }

    running = true;
    updateRunState();
    const chunks = [];
    const failed = [];
    const results = await withTimer(`📥 링크 ${urls.length}개 동시에 불러오는 중…`,
        Promise.allSettled(urls.map(url => fetchReference(url))));
    results.forEach((res, i) => {
        if (res.status === 'fulfilled') {
            chunks.push(`===== 출처: ${urls[i]} =====\n${res.value}`);
        } else {
            console.warn(LOG, 'fetch failed', urls[i], res.reason);
            failed.push(`${urls[i]}\n  → ${res.reason?.message || res.reason}`);
        }
    });
    running = false;
    updateRunState();

    if (chunks.length) {
        const prev = $id('reftext').value.trim();
        const joined = chunks.join('\n\n');
        $id('reftext').value = $id('append').checked && prev ? `${prev}\n\n${joined}` : joined;
        updateRefCount();
        await saveSourceFromUI(false);
    }
    if (failed.length) {
        setStatus(`⚠️ ${chunks.length}개 성공, ${failed.length}개 실패:\n${failed.join('\n')}`);
        toastr.warning(`일부 링크를 불러오지 못했어요 (${failed.length}개). 아래 상태창을 확인해 주세요.`);
    } else {
        setStatus(`✅ ${chunks.length}개 링크 불러오기 완료`);
        toastr.success('원작 자료를 불러왔어요');
    }
}

function renderList(items, cls = '') {
    if (!Array.isArray(items) || !items.length) return '';
    return `<ul class="bt-list ${cls}">${items.map(x => `<li>${escapeHtml(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('')}</ul>`;
}

const SEV_LABEL = { high: '심각', medium: '보통', low: '사소' };
const SEV_ORDER = { high: 0, medium: 1, low: 2 };
const ACTION_LABEL = { add: '추가', edit: '수정', remove: '삭제' };
const FIELD_LABEL = {
    description: 'Description', personality: 'Personality', scenario: 'Scenario', first_mes: '첫 메시지',
    mes_example: '예시 대사', lorebook: '로어북', system_prompt: '시스템 프롬프트', post_history: 'Post-History', author_note: '작가 노트',
};

function sevTag(sev) {
    const k = SEV_ORDER[sev] !== undefined ? sev : 'low';
    return `<span class="bt-tag bt-sev-${k}">${SEV_LABEL[k]}</span>`;
}

function suggestionHtml(sg, i, copyCls, applyCls = '') {
    return `<article class="bt-sugg">
        <div class="bt-sugg-head">
            <span class="bt-tag">${escapeHtml(FIELD_LABEL[sg.field] || sg.field || '')}</span>
            <span class="bt-tag bt-tag-ghost">${escapeHtml(ACTION_LABEL[sg.action] || sg.action || '')}</span>
            ${funBadge(sg.fun_impact, sg.fun_note)}
            <span class="bt-sugg-btns">${copyBtn(copyCls, i)}${applyCls ? applyBtn(applyCls, i) : ''}</span>
        </div>
        <pre class="bt-paste">${escapeHtml(sg.text || '')}</pre>
        ${sg.reason ? `<div class="bt-prose bt-muted">${prose(sg.reason)}</div>` : ''}
        ${sg.fun_note ? `<div class="bt-fun-note ${String(sg.fun_impact).trim() === '-' ? 'down' : ''}">${ico('masks-theater')}<span>${escapeHtml(sg.fun_note)}</span></div>` : ''}
    </article>`;
}

function renderResult(entry, prevEntry) {
    const r = entry.result || {};
    const overall = Math.max(0, Math.min(100, Number(r.overall) || 0));
    const hasFun = r.fun !== undefined && r.fun !== null && r.fun !== '';
    const fun = Math.max(0, Math.min(100, Number(r.fun) || 0));
    const prevOverall = prevEntry?.result ? Number(prevEntry.result.overall) : null;

    const cats = (r.categories || []).map(cat => meterHtml(escapeHtml(cat.name), cat.score, { sub: cat.comment })).join('');

    const issues = [...(r.issues || [])].sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3)).map(it => `
        <article class="bt-issue bt-sev-line-${SEV_ORDER[it.severity] !== undefined ? it.severity : 'low'}">
            <div class="bt-issue-head">${sevTag(it.severity)}<span class="bt-issue-cat">${escapeHtml(it.category || '')}</span></div>
            <div class="bt-prose">${prose(it.problem)}</div>
            ${it.evidence ? `<blockquote class="bt-quote">${escapeHtml(it.evidence)}</blockquote>` : ''}
            <dl class="bt-dl">
                ${it.canon ? `<dt>원작</dt><dd>${escapeHtml(it.canon)}</dd>` : ''}
                ${it.fix ? `<dt>수정</dt><dd class="bt-accent-text">${escapeHtml(it.fix)}</dd>` : ''}
            </dl>
        </article>`).join('');

    const sugg = (r.card_suggestions || []).map((sg, i) => suggestionHtml(sg, i, 'bt-copy', 'bt-res-apply')).join('');
    const when = new Date(entry.time).toLocaleString();

    $id('result').innerHTML = `
        ${hasFun ? `<section class="bt-card bt-hero bt-hero-dual">
            <div class="bt-hero-pair">
                <div class="bt-hero-cell">${ringHtml(overall, 'md')}<span class="bt-hero-caption">원작 일치도 ${deltaHtml(overall, prevOverall)}</span></div>
                <div class="bt-hero-cell">${ringHtml(fun, 'md')}<span class="bt-hero-caption">재미·몰입 ${deltaHtml(fun, prevEntry?.result?.fun)}</span></div>
            </div>
            <div class="bt-hero-meta bt-hero-meta-center">
                <span class="bt-eyebrow">${entry.mode === 'card' ? 'Card review' : 'Chat review'}</span>
                <h3>평가 결과</h3>
                <div class="bt-hero-sub"><span>${escapeHtml(when)}</span></div>
            </div>
        </section>` : `<section class="bt-card bt-hero">
            ${ringHtml(overall)}
            <div class="bt-hero-meta">
                <span class="bt-eyebrow">${entry.mode === 'card' ? 'Card review' : 'Chat review'}</span>
                <h3>원작 일치도</h3>
                <div class="bt-hero-sub">${deltaHtml(overall, prevOverall)}<span>${escapeHtml(when)}</span></div>
            </div>
        </section>`}
        ${r.summary ? `<section class="bt-card bt-summary">${ico('quote-left')}<div class="bt-prose">${prose(r.summary)}</div></section>` : ''}
        ${cats ? `<section class="bt-card">${cardHead('', '항목별 점수')}<div class="bt-meters">${cats}</div></section>` : ''}
        ${r.strengths?.length ? `<section class="bt-card">${cardHead('', '잘 된 점')}${renderList(r.strengths, 'bt-list-check')}</section>` : ''}
        ${issues ? `<section class="bt-card">${cardHead('', '수정이 필요한 점')}<div class="bt-stack">${issues}</div></section>` : ''}
        ${sugg ? `<section class="bt-card">${cardHead('', '카드 수정 제안', '복사해서 캐릭터 카드에 붙여넣으세요.')}<div class="bt-stack">${sugg}</div></section>` : ''}
        ${r.missing_info?.length ? `<section class="bt-card">${cardHead('', '카드에 빠진 원작 정보')}${renderList(r.missing_info)}</section>` : ''}
        <div class="bt-actions bt-actions-end"><button type="button" id="bt_copyall" class="bt-btn">${ico('clipboard')}<span>결과 전체 복사</span></button></div>`;

    const el = $id('result');
    el.querySelectorAll('.bt-copy').forEach(btn => btn.addEventListener('click', () => {
        copyText((r.card_suggestions || [])[Number(btn.dataset.idx)]?.text || '');
    }));
    el.querySelectorAll('.bt-res-apply').forEach(btn => btn.addEventListener('click', () => {
        const sg = (r.card_suggestions || [])[Number(btn.dataset.idx)];
        if (sg) openApplyDialog({ field: sg.field, text: sg.text || '', reason: sg.reason || '' });
    }));
    $id('copyall').addEventListener('click', () => copyText(resultToMarkdown(entry)));
}

function renderRawResult(raw, where = 'result') {
    const html = `<section class="bt-card bt-card-warn">
        ${cardHead('Format error', '결과를 표로 만들지 못했어요', 'AI가 정해진 형식으로 쓰지 못해서 원문을 그대로 보여드려요.<br>한 번 더 누르면 대부분 정상으로 나와요. 계속 이러면 설정에서 평가용 연결을 바꿔보세요.')}
        <pre class="bt-paste">${escapeHtml(raw)}</pre>
    </section>`;
    if (where === 'voice') {
        $id('voice_result').innerHTML = html;
        switchTab('voice');
        scrollPanelTo($id('voice_result'));
    } else {
        $id('result').innerHTML = html;
        switchTab('result');
    }
}

function resultToMarkdown(entry) {
    const r = entry.result || {};
    const lines = [`# 원작 일치도 ${r.overall}%`, '', r.summary || '', ''];
    if (r.categories?.length) {
        lines.push('## 항목별 점수');
        r.categories.forEach(c => lines.push(`- ${c.name}: ${c.score}% — ${c.comment || ''}`));
        lines.push('');
    }
    if (r.strengths?.length) { lines.push('## 잘 된 점'); r.strengths.forEach(x => lines.push(`- ${x}`)); lines.push(''); }
    if (r.issues?.length) {
        lines.push('## 수정이 필요한 점');
        r.issues.forEach(i => lines.push(`- [${i.severity}] ${i.category}: ${i.problem}${i.evidence ? `\n  - 근거: ${i.evidence}` : ''}${i.canon ? `\n  - 원작: ${i.canon}` : ''}${i.fix ? `\n  - 수정: ${i.fix}` : ''}`));
        lines.push('');
    }
    if (r.card_suggestions?.length) {
        lines.push('## 카드 수정 제안');
        r.card_suggestions.forEach(s => lines.push(`- (${s.field} / ${s.action}) ${s.text}${s.reason ? `\n  - 이유: ${s.reason}` : ''}`));
        lines.push('');
    }
    if (r.missing_info?.length) { lines.push('## 카드에 빠진 원작 정보'); r.missing_info.forEach(x => lines.push(`- ${x}`)); }
    return lines.join('\n');
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        toastr.success('복사했어요');
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toastr.success('복사했어요');
    }
}

function renderHistory(history) {
    const el = $id('history');
    if (!el) return;
    if (!history.length) { el.innerHTML = `<p class="bt-note">기록이 없어요.</p>`; return; }
    el.innerHTML = history.map((h, i) => {
        const sc = Number(h.result?.overall) || 0;
        return `<button type="button" class="bt-hist-item" data-idx="${i}">
            <span class="bt-hist-score" style="color:${scoreColor(sc)}">${sc}<small>%</small></span>
            <span class="bt-hist-date">${escapeHtml(new Date(h.time).toLocaleString())}</span>
            <span class="bt-tag bt-tag-ghost">${h.mode === 'card' ? '카드' : '대화'}</span>
        </button>`;
    }).join('');
    el.querySelectorAll('.bt-hist-item').forEach(item => item.addEventListener('click', () => {
        const i = Number(item.dataset.idx);
        renderResult(history[i], history[i + 1]);
        scrollPanelTo($id('result'));
    }));
}

function resetPanel() {
    getSettings().panelPos = null;
    getSettings().panelWidth = null;
    saveSettings();
    resetPageScroll();
    togglePanel(true);
    applyPanelPos();
    const body = $id('body');
    if (body) body.scrollTop = 0;
    toastr.info('봇 테스터 패널 위치를 초기화했어요');
}

function togglePanel(force) {
    buildPanel();
    const panel = $id('panel');
    const show = force ?? panel.style.display === 'none';
    panel.style.display = show ? '' : 'none';
    if (show) {
        panel.classList.remove('bt-min');
        resetPageScroll();
        applyPanelPos();
        refreshPanelForChar();
    }
}

function addMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('bt_menu_button')) return;
    menu.insertAdjacentHTML('beforeend', `
        <div id="bt_menu_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-flask-vial extensionsMenuExtensionButton"></div>
            봇 테스터
        </div>`);
    document.getElementById('bt_menu_button').addEventListener('click', () => togglePanel(true));
}

function addSettingsDrawer() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('bt_settings_drawer')) return;
    host.insertAdjacentHTML('beforeend', `
    <div id="bt_settings_drawer" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🧪 봇 테스터</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p>요술봉(🪄) 메뉴의 <b>봇 테스터</b> 또는 <code>/bottest</code> 로 패널을 열 수 있어요.</p>
                <div class="flex-container">
                    <div id="bt_open_from_settings" class="menu_button"><i class="fa-solid fa-flask-vial"></i> 패널 열기</div>
                    <div id="bt_reset_from_settings" class="menu_button"><i class="fa-solid fa-arrows-to-dot"></i> 패널 위치·크기 초기화</div>
                </div>
            </div>
        </div>
    </div>`);
    document.getElementById('bt_open_from_settings').addEventListener('click', () => togglePanel(true));
    document.getElementById('bt_reset_from_settings').addEventListener('click', resetPanel);
}

function registerCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument, ARGUMENT_TYPE } = ctx();
    if (!SlashCommandParser || !SlashCommand) return;

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bottest',
        callback: async () => { togglePanel(true); return ''; },
        helpString: '봇 테스터 패널을 엽니다.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bottest-doctor',
        callback: async (args) => {
            togglePanel(true);
            switchTab('doctor');
            const mode = String(args?.mode || 'card');
            if (mode === 'chat') await runChatDoctor();
            else if (mode === 'tokens') await runDoctorLocal(false);
            else await runCardDoctor();
            return '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: 'tokens = 토큰·구조 검사, card = AI 심층 진단, chat = 롤플 채팅 아쉬운 점',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['tokens', 'card', 'chat'],
                isRequired: false,
            }),
        ],
        helpString: '카드 진단: 토큰 과다, 금지문 과다, GPT·Claude·Gemini 적합도, 롤플 채팅의 아쉬운 점. 예: /bottest-doctor mode=chat',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bottest-diet',
        callback: async () => { togglePanel(true); switchTab('doctor'); await refreshDietList(); scrollPanelTo($id('diet_card')); return ''; },
        helpString: '토큰 다이어트: 카드·로어북을 캐릭터성은 살리고 길이만 줄여요.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bottest-reset',
        callback: async () => { resetPanel(); return ''; },
        helpString: '봇 테스터 패널이 화면 밖으로 나가거나 안 움직일 때 위치를 초기화합니다.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bottest-close',
        callback: async () => { togglePanel(false); resetPageScroll(); return ''; },
        helpString: '봇 테스터 패널을 닫습니다.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bottest-run',
        callback: async (args) => { togglePanel(true); await runTest(args?.turns); return ''; },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'turns',
                description: '테스트 턴 수',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
            }),
        ],
        helpString: 'AI가 유저 역할로 테스트 메시지를 보내고 (설정에 따라) 끝나면 평가합니다. 예: /bottest-run turns=8',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bottest-voice',
        callback: async (args) => {
            togglePanel(true);
            switchTab('voice');
            const key = { jako: 'ja_ko', ja_ko: 'ja_ko', koen: 'ko_en', ko_en: 'ko_en', en: 'en_us_gb', en_us_gb: 'en_us_gb' }[String(args?.set || 'ja_ko').toLowerCase()] || 'ja_ko';
            await runVoiceCheck(key);
            return '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'set',
                description: 'ja_ko = 일본어·한국어, ko_en = 한국어·영어, en = 미국식·영국식 영어',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['ja_ko', 'ko_en', 'en'],
                isRequired: false,
            }),
        ],
        helpString: '언어 짝별 말투·성격 검증. 예: /bottest-voice set=en (프로필이 없으면 먼저 만듭니다)',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bottest-eval',
        callback: async (args) => {
            togglePanel(true);
            await runEvaluation({ useChat: String(args?.mode || 'chat') !== 'card' });
            return '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: 'chat = 현재 채팅 평가, card = 카드만 평가',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['chat', 'card'],
                isRequired: false,
            }),
        ],
        helpString: '원작 자료와 비교해서 원작 일치도(%)와 피드백을 보여줍니다.',
    }));
}

// ---------------------------------------------------------------------------
// Voice (말투) & personality (성격) verification
// ---------------------------------------------------------------------------

const VOICE_VERSIONS = {
    ja: { label: '일본어 원작', code: 'JA', lang: '日本語', desc: 'Japanese original (source text)' },
    en_us: { label: '미국식 영어', code: 'US', lang: 'American English', desc: 'American English (official English localization if it exists)' },
    en_gb: { label: '영국식 영어', code: 'UK', lang: 'British English', desc: 'British English (UK release if it differs; otherwise how the character would naturally sound in British English)' },
    ko_official: { label: '한국어 정발', code: 'KO', lang: '한국어', desc: 'Korean official licensed translation (정발본)' },
};

const FANON_LANGS = { ja: '일본 팬덤', en: '영어권 팬덤', ko: '한국 팬덤' };

const emptyNames = () => ({ ja: '', en: '', ko: '', seriesJa: '', seriesEn: '', seriesKo: '' });

// ---------- Web search (no links needed from the user) ----------

function decodeDdgHref(href) {
    try {
        const u = new URL(href, 'https://duckduckgo.com');
        const real = u.searchParams.get('uddg');
        return real ? decodeURIComponent(real) : u.href;
    } catch { return href; }
}

async function searchDuckDuckGo(query) {
    const html = await visit(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('.result')].map(r => ({
        title: r.querySelector('.result__a')?.textContent?.trim() || '',
        url: decodeDdgHref(r.querySelector('.result__a')?.getAttribute('href') || ''),
        snippet: r.querySelector('.result__snippet')?.textContent?.trim() || '',
    })).filter(x => x.snippet);
}

async function searchBing(query) {
    const html = await visit(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=ko`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('li.b_algo')].map(r => ({
        title: r.querySelector('h2')?.textContent?.trim() || '',
        url: r.querySelector('h2 a')?.getAttribute('href') || '',
        snippet: (r.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4')?.textContent || '').trim(),
    })).filter(x => x.snippet);
}

async function searchViaStApi(engine, query) {
    const res = await fetch(`/api/search/${engine}`, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`${engine} 검색 실패 (HTTP ${res.status}) — API 키가 SillyTavern에 저장돼 있는지 확인해 주세요`);
    const data = await res.json();
    if (engine === 'tavily') return (data.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content }));
    return (data.organic || data.organic_results || []).map(r => ({ title: r.title, url: r.link, snippet: r.snippet }));
}

async function webSearch(query) {
    const engine = getSettings().searchEngine;
    if (engine && engine !== 'auto') return (await searchViaStApi(engine, query)).slice(0, 8);
    try {
        const r = await searchDuckDuckGo(query);
        if (r.length) return r.slice(0, 8);
    } catch (e) { console.warn(LOG, 'ddg failed', e); }
    try {
        return (await searchBing(query)).slice(0, 8);
    } catch (e) { console.warn(LOG, 'bing failed', e); return []; }
}

async function redditResearch(query) {
    const out = [];
    const json = JSON.parse(await visit(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=8&sort=relevance&t=all`, false));
    const posts = (json?.data?.children || []).map(c => c.data).filter(Boolean);
    for (const p of posts) {
        if (hasShip(`${p.title} ${p.selftext}`)) continue;
        out.push({
            title: `r/${p.subreddit}: ${p.title}`,
            url: `https://www.reddit.com${p.permalink}`,
            snippet: truncate(String(p.selftext || '').replace(/\s+/g, ' '), 500),
        });
    }
    // read top comments of the 2 most-commented threads
    const top = [...posts].sort((a, b) => (b.num_comments || 0) - (a.num_comments || 0)).slice(0, 2);
    await Promise.allSettled(top.map(async p => {
        const thread = JSON.parse(await visit(`https://www.reddit.com${p.permalink}.json?limit=15&sort=top`, false));
        const comments = (thread?.[1]?.data?.children || [])
            .map(c => c.data?.body).filter(b => b && !hasShip(b)).slice(0, 10)
            .map(b => '• ' + truncate(b.replace(/\s+/g, ' '), 350)).join('\n');
        if (comments) out.push({ title: `r/${p.subreddit} 댓글: ${p.title}`, url: `https://www.reddit.com${p.permalink}`, snippet: comments });
    }));
    return out;
}

function buildResearchQueries(n) {
    const q = [];
    const add = (group, query) => { if (query.replace(/["\s]/g, '').length > 2) q.push({ group, query }); };
    const ja = n.ja || n.ko || n.en;
    const en = n.en || n.ja;
    const ko = n.ko || n.ja;
    // speech
    add('speech-ja', `${ja} ${n.seriesJa} 口調 一人称 台詞`);
    add('speech-ja', `${ja} ${n.seriesJa} 方言 喋り方`);
    add('speech-en', `${en} ${n.seriesEn} quotes`);
    add('speech-en', `${en} ${n.seriesEn} dub voice accent English`);
    add('speech-ko', `${ko} ${n.seriesKo} 말투 정발 대사`);
    // fanon
    add('fanon-ja', `${ja} 解釈 性格 site:x.com -カプ -CP -夢 -受け -攻め`);
    add('fanon-ja', `${ja} ${n.seriesJa} 性格 解釈 考察 -カプ -CP -夢`);
    add('fanon-en', `${en} ${n.seriesEn} fanon characterization personality -ship -shipping -x`);
    add('fanon-en', `${en} personality site:x.com -ship -shipping`);
    add('fanon-ko', `${ko} 캐해 성격 site:x.com -커플링 -컾 -공수 -드림`);
    add('fanon-ko', `${ko} ${n.seriesKo} 캐해석 성격 -커플링 -컾 -공수`);
    return q;
}

async function runResearch(names) {
    const queries = buildResearchQueries(names);
    const tasks = queries.map(({ group, query }) => webSearch(query).then(r => ({ group, query, results: r })));
    if (names.en) {
        tasks.push(redditResearch(`${names.en} ${names.seriesEn}`.trim()).then(r => ({ group: 'fanon-reddit', query: 'reddit', results: r })));
    }
    const settled = await Promise.allSettled(tasks);
    const blocks = [];
    const sources = [];
    const seen = new Set();
    let ok = 0;
    for (const s of settled) {
        if (s.status !== 'fulfilled') { console.warn(LOG, 'research failed', s.reason); continue; }
        const { group, query, results } = s.value;
        if (!results.length) continue;
        ok++;
        const lines = [];
        for (const r of results) {
            if (!r.url || seen.has(r.url + group)) continue;
            if (hasShip(`${r.title} ${r.snippet}`)) continue; // no coupling talk
            seen.add(r.url + group);
            lines.push(`- ${r.title}\n  ${r.url}\n  ${r.snippet}`);
            if (!sources.includes(r.url)) sources.push(r.url);
        }
        if (lines.length) blocks.push(`### [${group}] ${query}\n${lines.join('\n')}`);
    }
    return { text: truncate(blocks.join('\n\n'), 16000), sources, okCount: ok, total: tasks.length };
}

// ---------- Names auto-fill ----------

async function autofillNames(char, charData) {
    const s = getSettings();
    const system = 'You identify fictional characters. Output ONE JSON object only.';
    const prompt = [
        `[캐릭터 카드 이름] ${char.name}`,
        `[카드 설명 일부]\n${truncate(char.description || '', 1500)}`,
        charData.refText ? `[원작 자료 일부]\n${truncate(charData.refText, 2500)}` : '',
        'Identify the ORIGINAL character this fan-made bot is based on. Return:',
        '{"ja":"<Japanese name in original script, e.g. 白布賢二郎>","en":"<official English name>","ko":"<official Korean name>","seriesJa":"<series title in Japanese>","seriesEn":"<series title in English>","seriesKo":"<series title in Korean>"}',
        'If the work is not Japanese, still fill each language with the official/common name. Use "" if unknown.',
    ].filter(Boolean).join('\n\n');
    const data = await requestJson({ system, prompt, profileId: s.evalProfile, maxTokens: 2000, label: '✨ 캐릭터 이름 확인 중…' });
    return Object.assign(emptyNames(), data);
}

// ---------- Profile builder ----------

const SPEECH_KEYS_DOC = `{
  "available": <true if this language version officially exists or is well documented>,
  "style_ko": "<이 버전에서 어떤 말투인지 한국어로 쉽게 2-4문장 (예시 표현과 그 뜻 포함). 영어판은 특히 자세히>",
  "personality_ko": "<이 버전에서 성격이 어떤 느낌으로 전달되는지 한국어로 1-3문장>",
  "first_person": "<1인칭 (e.g. 俺 / I / 나)>",
  "second_person": "<how they address others / {{user}}, e.g. お前, 呼び捨て, you, 너>",
  "register": "<반말/존댓말/敬語/formality level>",
  "sentence_endings": "<typical endings or grammar habits>",
  "dialect": "<dialect/accent and how it is rendered in this version, or '없음'>",
  "verbal_tics": ["<habits, fillers, sounds>"],
  "catchphrases": ["<signature lines in this language>"],
  "sample_lines": ["<3-5 short representative lines in this language>"],
  "dont": ["<things this character would NOT say / common mistakes>"],
  "confidence": "high"|"medium"|"low"
}`;

async function buildVoiceProfile() {
    if (running) { toastr.warning('다른 작업이 진행 중이에요'); return; }
    const char = getCurrentCharacter();
    if (!char) { toastr.error('1:1 캐릭터 채팅을 열어주세요'); return; }
    const s = getSettings();
    const charData = await loadCharData(char);
    readNamesFromUI(charData);

    running = true;
    updateRunState();
    try {
        if (!charData.names.ja && !charData.names.en && !charData.names.ko) {
            charData.names = await withTimer('✨ 캐릭터 이름 자동 확인 중…', autofillNames(char, charData));
            writeNamesToUI(charData.names);
        }

        let research = { text: '', sources: [], okCount: 0, total: 0 };
        if (s.fanonSearch) {
            research = await withTimer('🌐 일·영·한 웹/트위터/레딧 검색 중…', runResearch(charData.names));
        }

        const versions = Object.keys(VOICE_VERSIONS);
        const system = [
            'You are a localization expert and fandom analyst for anime/manga/game characters.',
            'Build a reference sheet of HOW a character talks in each language version and WHAT their personality is, both canon and fanon (fan interpretation).',
            'Priority of evidence: (1) the provided reference material, (2) the provided web search snippets, (3) your own knowledge. Never invent official lines; if unsure, lower "confidence" and say so.',
            'Pay special attention to dialects (e.g. 関西弁, 博多弁, 東北弁), unusual first-person pronouns, keigo, verbal tics and catchphrases, and how translators rendered them (e.g. 関西弁 → 경상도/전라도 사투리 in Korean, Southern/regional accent in English).',
            'For en_gb: if there is no separate UK localization, say so in "dialect"/"register" and describe how the character should sound in natural British English (vocabulary, spelling), keeping the same personality.',
            'Fanon = how fans on X/Twitter, Reddit, pixiv etc. commonly interpret the character\'s PERSONALITY (popular headcanons about temperament, habits, attitude, memes, exaggerations). Separate it clearly from canon and list where fanon diverges from canon.',
            NO_SHIP_RULE + ' Ignore any search snippet about couplings. For canon relationships describe only the in-story bond (teammate, senior, rival, family), never romance between fans\' pairings.',
            'Write explanations in 한국어; keep sample lines / catchphrases in their own language.',
            'Output ONE JSON object only (no markdown fences):',
            '{',
            `  "speech": { ${versions.map(v => `"${v}": <${VOICE_VERSIONS[v].desc}>`).join(', ')} },`,
            `  each speech entry has the shape: ${SPEECH_KEYS_DOC},`,
            '  "dialect_mapping": "<원작 사투리/특유 말투가 각 언어판에서 어떻게 옮겨졌는지 한눈에 정리>",',
            '  "personality": {',
            '    "canon": {"core_traits": [], "values": "", "likes": [], "dislikes": [], "emotional_expression": "", "relationships": [{"name": "", "dynamic": ""}], "behaviors": [], "confidence": "high|medium|low"},',
            '    "fanon": {"ja": {"popular_interpretations": [], "tags_memes": []}, "en": {"popular_interpretations": [], "tags_memes": []}, "ko": {"popular_interpretations": [], "tags_memes": []}, "divergence_from_canon": [], "confidence": "high|medium|low"}',
            '  },',
            '  "notes": "<caveats, e.g. 영국판 별도 번역 없음 / 검색 결과 부족>"',
            '}',
        ].join('\n');

        const n = charData.names;
        const prompt = [
            `[캐릭터] ${char.name} / 日: ${n.ja} / EN: ${n.en} / KO: ${n.ko}`,
            `[작품] 日: ${n.seriesJa} / EN: ${n.seriesEn} / KO: ${n.seriesKo}`,
            charData.refText ? `[원작 자료 (위키)]\n${truncate(charData.refText, 10000)}` : '[원작 자료 없음]',
            research.text ? `[웹 검색 결과 스니펫 (일·영·한, X/트위터·레딧 포함)]\n${research.text}` : '[웹 검색 결과 없음 — 자체 지식으로 작성하고 confidence를 낮게]',
            'Now output the JSON reference sheet.',
        ].join('\n\n');

        let profile;
        try {
            profile = sanitizeProfile(await requestJsonComplete({ system, prompt, profileId: s.evalProfile, maxTokens: Math.max(Number(s.profileMaxTokens) || 0, 10000), label: '🧠 말투·성격 프로필 정리 중…' }));
        } catch (e) {
            if (!e.raw) throw e;
            throw new Error('프로필 결과 형식이 깨졌어요. 평가용 연결을 더 큰 모델로 바꿔보세요.');
        }
        charData.voiceProfile = {
            time: Date.now(),
            profile,
            sources: research.sources.slice(0, 40),
            searchStat: research.total ? `${research.okCount}/${research.total}` : '검색 안 함',
        };
        await saveCharData(char, charData);
        renderVoiceProfile(charData.voiceProfile);
        setStatus(`✅ 프로필 완성 (웹 검색 성공 ${charData.voiceProfile.searchStat})`);
        toastr.success('말투·성격 프로필을 만들었어요');
    } catch (e) {
        console.error(LOG, e);
        setStatus(`❌ 프로필 생성 실패: ${e.message}`);
        toastr.error(`프로필 생성 실패: ${e.message}`);
    } finally {
        running = false;
        updateRunState();
    }
}

// ---------- Verification ----------

async function generateVoiceSamples(versions) {
    const { userName, charName } = testerNames();
    const out = {};
    for (const v of versions) {
        if (stopRequested) break;
        const lang = VOICE_VERSIONS[v].lang;
        const quietPrompt = [
            `[OOC: 롤플레이를 잠깐 멈추고, ${charName}(으)로서 아래 세 상황에 대한 대사를 각각 1~2문장씩 **${lang}**(으)로만 써줘.`,
            '지문·설명·번역·괄호 없이 대사만, 아래 형식 그대로:',
            '1) ...\n2) ...\n3) ...',
            `상황 1) ${userName}이(가) 가볍게 인사하며 말을 걸었다.`,
            `상황 2) ${userName}이(가) 실수로 ${charName}을(를) 짜증 나게 했다.`,
            `상황 3) ${userName}이(가) ${charName}을(를) 진심으로 칭찬했다.]`,
        ].join('\n');
        try {
            await waitIdle();
            const text = await withTimer(`🗣 ${VOICE_VERSIONS[v].label} 샘플 대사 받는 중…`,
                ctx().generateQuietPrompt({ quietPrompt, responseLength: 600 }));
            out[v] = stripReasoning(String(text || '')).trim();
        } catch (e) {
            console.warn(LOG, 'sample failed', v, e);
            out[v] = `(생성 실패: ${e.message})`;
        }
    }
    return out;
}

const VOICE_SETS = {
    ja_ko: {
        label: '일본어 · 한국어',
        short: '일 · 한',
        hint: '원작 말투가 정발에서도 살아 있는지',
        versions: ['ja', 'ko_official'],
        fanon: ['ja', 'ko'],
        focus: 'Compare the Japanese original and the Korean official translation (정발). Check how dialect, keigo/반말, first-person pronouns and nuance survive in Korean.',
    },
    ko_en: {
        label: '한국어 · 영어',
        short: '한 · 영',
        hint: '존댓말·호칭이 영어에서 어떻게 옮겨지는지',
        versions: ['ko_official', 'en_us'],
        fanon: ['ko', 'en'],
        focus: 'Compare the Korean official translation and the official English localization. Check how 존댓말/반말, 호칭 and tone map to English (no honorifics), and whether personality reads the same.',
    },
    en_us_gb: {
        label: '미국식 · 영국식 영어',
        short: '미 · 영',
        hint: '두 영어의 말투·성격 느낌을 한국어로 설명',
        versions: ['en_us', 'en_gb'],
        fanon: ['en'],
        focus: 'Compare American English and British English renderings. Check vocabulary/slang (e.g. mom/mum, guy/bloke, awesome/brilliant), spelling (color/colour), politeness/understatement, sarcasm style and any accent/dialect equivalents. Explain everything clearly in Korean for a reader who does not know English nuances well.',
    },
};

// ---------- no-coupling filter ----------

/** Words that signal shipping / coupling talk (JP / KO / EN). Fanon must be about personality only. */
const SHIP_RE = new RegExp([
    'カップリング', 'カプ(?![セチリ])', '[一-龯ァ-ヶ]{1,6}(?:受け|攻め)(?=[がのはでも、。！!\\s#]|$)', '[左右]固定', '総受け', '受け攻め', '攻め受け', 'リバ(?!ース|ウ|ティ|プール)', '夢(?:小説|主|女子|絵|漫画)', '腐向け', '腐女子',
    '(?<![A-Za-z])(?:BL|GL|NL|CP)(?![A-Za-z])', '컾', '커플링', '커플', '공수\\s*(?:관계|구도|역전)', '총수', '드림(?:주|러|캐|물)',
    '\\bships?\\b', '\\bshipping\\b', '\\bshipped\\b', '\\bOTP\\b', '\\bpairings?\\b', 'x\\s*reader', '\\byaoi\\b', '\\byuri\\b', '\\bslash\\s*fic',
    '[A-Za-z가-힣ぁ-んァ-ヶ一-龯]{1,12}\\s*×\\s*[A-Za-z가-힣ぁ-んァ-ヶ一-龯]{1,12}',
    '[A-Za-z가-힣ぁ-んァ-ヶ一-龯]{2,12}\\s[xX]\\s[A-Za-z가-힣ぁ-んァ-ヶ一-龯]{2,12}',
].join('|'), 'i');

const hasShip = (t) => SHIP_RE.test(String(t || ''));

/** Drops sentences / lines that talk about couplings. */
function stripShipping(text) {
    const t = String(text ?? '');
    if (!hasShip(t)) return t;
    return t.replace(/([.!?。！？](?:["'”’」』)\]]*))\s+/g, '$1\u0001').split(/\u0001|\n/)
        .filter(x => !hasShip(x)).join(' ').replace(/\s{2,}/g, ' ').trim();
}

const noShipList = (arr) => Array.isArray(arr) ? arr.filter(x => !hasShip(typeof x === 'string' ? x : JSON.stringify(x))) : arr;

/** Removes coupling talk from a voice profile (in place) and returns it. */
function sanitizeProfile(p) {
    if (!p || typeof p !== 'object') return p;
    const f = p.personality?.fanon;
    if (f) {
        for (const k of ['ja', 'en', 'ko']) {
            if (!f[k]) continue;
            f[k].popular_interpretations = noShipList(f[k].popular_interpretations);
            f[k].tags_memes = noShipList(f[k].tags_memes);
        }
        f.divergence_from_canon = noShipList(f.divergence_from_canon);
    }
    const c = p.personality?.canon;
    if (c) {
        // relationships stay (canon bonds like 선후배/라이벌) but romantic-shipping wording is removed
        c.relationships = (c.relationships || []).filter(r => !hasShip(`${r?.name} ${r?.dynamic}`));
        c.behaviors = noShipList(c.behaviors);
    }
    if (p.notes) p.notes = stripShipping(p.notes);
    return p;
}

function sanitizeVoiceResult(r) {
    if (!r || typeof r !== 'object') return r;
    const p = r.personality;
    if (p) {
        p.fanon_comment = stripShipping(p.fanon_comment);
        p.canon_comment = stripShipping(p.canon_comment);
        p.ooc_moments = (p.ooc_moments || []).filter(o => !hasShip(`${o.problem} ${o.fix}`));
    }
    r.summary = stripShipping(r.summary);
    r.compare_ko = stripShipping(r.compare_ko);
    r.card_suggestions = (r.card_suggestions || []).filter(sg => !hasShip(`${sg.text} ${sg.reason}`));
    return r;
}

const NO_SHIP_RULE = 'STRICT RULE: never mention couplings / ships / pairings (CP, カップリング, 受け・攻め, 夢, 커플링, 공수, "A x B", OTP, x Reader) or romantic fan pairings in any field. Fan interpretation (fanon) means personality, habits, attitude and memes about the character ONLY.';

// ---------- JSON with truncation retry ----------

/**
 * Like requestJson, but if the model stopped mid-JSON, asks again once with a bigger
 * budget and a "be concise" note, and keeps whichever answer is complete.
 */
async function requestJsonComplete(opts) {
    const first = await requestJson({ ...opts, quietTruncation: true });
    if (!first.__truncated) return first;
    console.warn(LOG, 'truncated JSON, retrying with bigger budget:', opts.label);
    try {
        const second = await requestJson({
            ...opts,
            quietTruncation: true,
            maxTokens: Math.round((opts.maxTokens || 8000) * 1.6),
            label: `${opts.label} (잘려서 다시 요청)`,
            system: `${opts.system}\n\nIMPORTANT: your previous answer was cut off. Be MUCH more concise this time: shorter sentences, fewer list items. Finish the JSON.`,
        });
        if (!second.__truncated) return second;
        toastr.warning('결과가 길어서 일부가 잘렸어요. 평가용 연결을 생각(Reasoning)을 줄인 모델로 바꾸면 전부 나와요.');
        return second;
    } catch {
        return first;
    }
}

async function runVoiceCheck(setKey = 'ja_ko') {
    if (running) { toastr.warning('다른 작업이 진행 중이에요'); return; }
    const set = VOICE_SETS[setKey];
    if (!set) return;
    const char = getCurrentCharacter();
    if (!char) { toastr.error('1:1 캐릭터 채팅을 열어주세요'); return; }
    const s = getSettings();
    let charData = await loadCharData(char);
    if (!charData.voiceProfile?.profile) {
        await buildVoiceProfile();
        charData = await loadCharData(char);
        if (!charData.voiceProfile?.profile) return;
    }
    const versions = set.versions;

    running = true;
    stopRequested = false;
    updateRunState();
    try {
        const samples = s.voiceSamples ? await generateVoiceSamples(versions) : {};
        const chatLog = s.voiceUseChat ? collectChatLog(Number(s.evalMessages) || 20) : '';
        if (!chatLog.trim() && !Object.keys(samples).length) {
            throw new Error('검증할 대사가 없어요. “샘플 대사 생성”을 켜거나 채팅을 먼저 진행해 주세요.');
        }

        const prof = sanitizeProfile(structuredClone(charData.voiceProfile.profile || {}));
        const fanon = prof.personality?.fanon || {};
        const card = truncate(collectCard(char), 6000);
        const note = charData.authorNote ? `[제작자 메모 — 의도한 AU/설정 변경 (감점 금지)]\n${charData.authorNote}` : '';
        const sampleOf = (v) => samples[v] ? `[${VOICE_VERSIONS[v].label} (${VOICE_VERSIONS[v].lang}) 샘플 — 봇이 실제 설정으로 생성]\n${samples[v]}` : '';
        const common = [
            'Every explanation must be in natural 한국어 that a Korean reader who is not fluent in the other language can understand. When you mention an English/Japanese word, add its Korean meaning in parentheses.',
            'Differences the creator marked as intentional (AU / 설정 변경) must not reduce scores.',
            NO_SHIP_RULE,
            funGuard(charData),
            'JSON rules: straight double quotes, escape any " inside strings as \\", no trailing commas, no comments. Output ONE JSON object only, no markdown fences.',
        ].join('\n');

        // --- 1) one small call per language version (keeps each answer short → no truncation)
        const speechResults = [];
        const runOne = async (v) => {
            const system = [
                'You are a strict localization QA reviewer.',
                `Review ONLY the ${VOICE_VERSIONS[v].desc} version of the character's speech.`,
                set.focus,
                'Judge first-person pronoun, how they address others, register/politeness, sentence endings, dialect/accent, verbal tics and catchphrases. Dialect matters a lot: missing, wrong or over-exaggerated dialect is a major problem.',
                'Quote the exact bot line for every problem and give a corrected rewrite IN THAT LANGUAGE.',
                `If there are no bot lines in ${VOICE_VERSIONS[v].lang} (neither chat nor sample), set status "no_sample" and score null, but still fill style_ko and personality_ko from the reference.`,
                'BOT FIXES: what the creator should change in the CURRENT bot (card, example dialogue, system prompt, lorebook) so these speech problems go away. Concrete and actionable, most important first. Empty list if fine.',
                'Limits: flagged ≤ 3, bot_fixes ≤ 4, each text field ≤ 3 sentences.',
                common,
                'Shape:',
                `{"version": "${v}", "status": "checked"|"no_sample", "score": <0-100 or null>,`,
                ' "style_ko": "<이 버전에서 캐릭터가 원래 어떤 말투인지 (예시 표현 + 뜻)>",',
                ' "personality_ko": "<이 버전에서 성격이 어떤 느낌으로 전달되는지>",',
                ' "bot_style_ko": "<봇이 실제로 이 버전에서 어떤 말투로 말했는지, 샘플 없으면 빈 문자열>",',
                ' "checks": {"first_person": "ok|bad|n/a", "address": "ok|bad|n/a", "register": "ok|bad|n/a", "dialect": "ok|bad|n/a", "tics": "ok|bad|n/a"},',
                ' "comment": "",',
                ' "flagged": [{"line": "", "problem": "", "rewrite": "", "rewrite_ko": "<고친 문장의 한국어 뜻, 한국어판이면 빈 문자열>"}],',
                ` "bot_fixes": [{"priority": "high"|"medium"|"low", "what": "", "where": "description|personality|mes_example|first_mes|system_prompt|post_history|lorebook|author_note", "how": "", "paste": "<붙여넣을 문장, 대사는 해당 언어로 — 규칙 나열보다 샘플 대사·연출 지시 형태로>", ${FUN_IMPACT_DOC}}]}`,
            ].join('\n');
            const prompt = [
                `[레퍼런스 — ${VOICE_VERSIONS[v].label} 말투]\n${JSON.stringify(prof.speech?.[v] ?? {}, null, 1)}`,
                prof.dialect_mapping ? `[사투리·말투 번역 정리]\n${prof.dialect_mapping}` : '',
                note,
                `[캐릭터 카드]\n${card}`,
                chatLog ? `[현재 채팅 로그]\n${chatLog}` : '',
                sampleOf(v),
                'Now output the JSON.',
            ].filter(Boolean).join('\n\n');
            const res = await requestJsonComplete({ system, prompt, profileId: s.evalProfile, maxTokens: evalTokens(), label: `🔎 ${VOICE_VERSIONS[v].label} 말투 검증 중…` });
            res.version = v;
            return res;
        };
        if (s.evalProfile) {
            // separate connection profile → requests can run side by side
            speechResults.push(...await Promise.all(versions.map(runOne)));
        } else {
            for (const v of versions) {
                if (stopRequested) throw new Error('중단됨');
                speechResults.push(await runOne(v));
            }
        }

        // --- 2) one call for personality, comparison and card suggestions
        const digest = speechResults.map(r => `${r.version}: ${r.score ?? '샘플 없음'}점 — ${r.comment || ''}`).join('\n');
        const overviewSystem = [
            'You are a fandom expert reviewing a fan-made roleplay bot.',
            `Language pair: ${versions.map(v => VOICE_VERSIONS[v].desc).join(' / ')}. ${set.focus}`,
            'PERSONALITY: canon_score = faithful to the original; fanon_score = matches the fan interpretation of the given fandoms. Say which way the bot leans. OOC moments must quote the bot line.',
            'compare_ko: explain in Korean how speech and personality FEEL different between the two versions, with concrete words/expressions and their meaning.',
            'Limits: ooc_moments ≤ 3, card_suggestions ≤ 4, summary 2-3 sentences, compare_ko 3-5 sentences.',
            common,
            'Shape:',
            '{"summary": "", "compare_ko": "",',
            ' "personality": {"canon_score": <0-100>, "fanon_score": <0-100>, "leaning": "canon"|"fanon"|"balanced"|"neither", "canon_comment": "", "fanon_comment": "", "ooc_moments": [{"line": "", "problem": "", "fix": ""}]},',
            ` "card_suggestions": [{"field": "description|personality|mes_example|first_mes|lorebook|system_prompt", "action": "add|edit|remove", "text": "", "reason": "", ${FUN_IMPACT_DOC}}]}`,
        ].join('\n');
        const overviewPrompt = [
            `[원작 성격]\n${JSON.stringify(prof.personality?.canon ?? {}, null, 1)}`,
            `[2차 캐해 — ${set.fanon.map(k => FANON_LANGS[k]).join(', ')}]\n${JSON.stringify({ ...Object.fromEntries(set.fanon.map(k => [k, fanon[k] ?? null])), divergence_from_canon: fanon.divergence_from_canon }, null, 1)}`,
            `[언어별 말투 요약]\n${versions.map(v => `${v}: ${prof.speech?.[v]?.style_ko || ''}`).join('\n')}`,
            `[말투 검증 결과 요약]\n${digest}`,
            note,
            `[캐릭터 카드]\n${card}`,
            chatLog ? `[현재 채팅 로그]\n${chatLog}` : '',
            ...versions.map(sampleOf),
            'Now output the JSON.',
        ].filter(Boolean).join('\n\n');
        const overview = await requestJsonComplete({ system: overviewSystem, prompt: overviewPrompt, profileId: s.evalProfile, maxTokens: evalTokens(), label: `🎭 ${set.label} 성격·비교 정리 중…` });

        const result = sanitizeVoiceResult({
            summary: overview.summary,
            compare_ko: overview.compare_ko,
            speech: speechResults,
            personality: overview.personality || {},
            card_suggestions: overview.card_suggestions || [],
        });

        const entry = { time: Date.now(), set: setKey, versions, samples, result };
        charData.voiceResults = charData.voiceResults || {};
        charData.voiceResults[setKey] = [entry, ...(charData.voiceResults[setKey] || [])].slice(0, 10);
        await saveCharData(char, charData);
        currentVoiceSet = setKey;
        renderVoiceResults(charData);
        const p = result.personality || {};
        setStatus(`✅ ${set.label} 검증 완료 — 원작 캐해 ${p.canon_score ?? '?'}% / 2차 캐해 ${p.fanon_score ?? '?'}%`);
        toastr.success(`${set.label} 검증 완료`);
        setMinimized(false);
        scrollPanelTo($id('voice_result'));
    } catch (e) {
        console.error(LOG, e);
        if (e.raw) {
            renderRawResult(e.raw, 'voice');
            setStatus('⚠️ 두 번 시도했지만 결과 형식이 깨져서 원문을 보여드려요');
        } else {
            setStatus(`❌ 검증 실패: ${e.message}`);
            toastr.error(`검증 실패: ${e.message}`);
        }
    } finally {
        running = false;
        updateRunState();
    }
}

// ---------- Voice UI ----------

function readNamesFromUI(charData) {
    const g = (id) => ($id(id)?.value || '').trim();
    charData.names = {
        ja: g('n_ja'), en: g('n_en'), ko: g('n_ko'),
        seriesJa: g('n_sja'), seriesEn: g('n_sen'), seriesKo: g('n_sko'),
    };
}

function writeNamesToUI(n) {
    n = Object.assign(emptyNames(), n || {});
    const map = { n_ja: n.ja, n_en: n.en, n_ko: n.ko, n_sja: n.seriesJa, n_sen: n.seriesEn, n_sko: n.seriesKo };
    for (const [id, v] of Object.entries(map)) if ($id(id)) $id(id).value = v || '';
    const sum = $id('names_summary');
    if (sum) sum.textContent = [n.ja || n.ko || n.en, n.seriesKo || n.seriesJa || n.seriesEn].filter(Boolean).join(' · ') || '비어 있음';
}

async function saveNamesFromUI() {
    const char = getCurrentCharacter();
    if (!char) return;
    const data = await loadCharData(char);
    readNamesFromUI(data);
    await saveCharData(char, data);
    writeNamesToUI(data.names);
}

function bindVoicePage() {
    const s = getSettings();
    for (const [id, key] of [['fanonsearch', 'fanonSearch'], ['vsamples', 'voiceSamples'], ['vchat', 'voiceUseChat']]) {
        const el = $id(id);
        el.checked = !!s[key];
        el.addEventListener('change', () => { s[key] = el.checked; saveSettings(); });
    }
    ['n_ja', 'n_en', 'n_ko', 'n_sja', 'n_sen', 'n_sko'].forEach(id => $id(id).addEventListener('change', saveNamesFromUI));

    $id('autonames').addEventListener('click', async () => {
        if (running) return;
        const char = getCurrentCharacter();
        if (!char) { toastr.error('캐릭터 채팅을 먼저 열어주세요'); return; }
        await saveSourceFromUI(false);
        const data = await loadCharData(char);
        running = true; updateRunState();
        try {
            data.names = await withTimer('✨ 이름 자동 확인 중…', autofillNames(char, data));
            await saveCharData(char, data);
            writeNamesToUI(data.names);
            $id('names_box').open = true;
            setStatus('✅ 이름을 채웠어요. 맞는지 확인해 주세요.');
        } catch (e) {
            setStatus(`❌ 이름 자동 채우기 실패: ${e.message}`);
        } finally {
            running = false; updateRunState();
        }
    });
    $id('buildprofile').addEventListener('click', async () => { await saveSourceFromUI(false); buildVoiceProfile(); });
    document.querySelectorAll('#bt_panel .bt-vset-btn[data-set]').forEach(btn => btn.addEventListener('click', async () => {
        if (running) return;
        await saveSourceFromUI(false);
        runVoiceCheck(btn.dataset.set);
    }));
}

function voicePageHtml() {
    const setButtons = Object.entries(VOICE_SETS).map(([k, v]) => `
        <button type="button" class="bt-vset-btn" data-set="${k}">
            <span class="bt-vset-codes">${v.versions.map(codeTag).join('')}</span>
            <span class="bt-vset-text"><b>${v.label}</b><small>${v.hint}</small></span>
            ${ico('chevron-right')}
        </button>`).join('');
    return `
    <div class="bt-page" data-page="voice" style="display:none">
      <section class="bt-card">
        ${cardHead('Voice & Personality', '말투·성격 검증', '언어별 원작 말투와 성격(원작 캐해, 팬덤 2차 캐해)을 정리한 뒤, 봇이 그대로 말하고 행동하는지 언어 짝별로 검사해요.<br>링크는 따로 안 넣어도 돼요.')}
        <details class="bt-disclosure" id="bt_names_box">
          <summary><span>캐릭터 이름 · 작품명</span><small id="bt_names_summary"></small>${ico('chevron-down')}</summary>
          <div class="bt-grid2">
            ${field('일본어 이름', '<input id="bt_n_ja" class="bt-input" placeholder="白布賢二郎">')}
            ${field('작품 (일)', '<input id="bt_n_sja" class="bt-input" placeholder="ハイキュー!!">')}
            ${field('영어 이름', '<input id="bt_n_en" class="bt-input" placeholder="Kenjiro Shirabu">')}
            ${field('작품 (영)', '<input id="bt_n_sen" class="bt-input" placeholder="Haikyu!!">')}
            ${field('한국어 이름', '<input id="bt_n_ko" class="bt-input" placeholder="시라부 켄지로">')}
            ${field('작품 (한)', '<input id="bt_n_sko" class="bt-input" placeholder="하이큐!!">')}
          </div>
          <div class="bt-actions">
            <button type="button" id="bt_autonames" class="bt-btn">${ico('wand-magic-sparkles')}<span>자동 채우기</span></button>
            <p class="bt-note">비워두면 자동으로 채워요. 검색 정확도에 큰 영향을 줘요.</p>
          </div>
        </details>
        <div class="bt-switches">
          ${toggle('fanonsearch', '웹 검색으로 자료 보강', '일·영·한 위키와 대사, X(트위터)·레딧 2차 캐해')}
          ${toggle('vsamples', '언어별 샘플 대사 생성', '봇이 직접 답해요. 채팅에는 남지 않아요.')}
          ${toggle('vchat', '현재 채팅의 봇 대사도 검사')}
        </div>
      </section>

      <section class="bt-card">
        ${cardHead('Step 1', '말투·성격 프로필', '원작 자료와 검색 결과로 4개 언어판의 말투와 성격을 정리해요.')}
        <div class="bt-actions">
          <button type="button" id="bt_buildprofile" class="bt-btn">${ico('book-open')}<span>프로필 만들기</span></button>
          <span class="bt-note" id="bt_profile_meta">아직 없어요</span>
        </div>
        <details class="bt-disclosure" id="bt_profile_box">
          <summary><span>프로필 보기</span>${ico('chevron-down')}</summary>
          <div id="bt_profile_view"></div>
        </details>
      </section>

      <section class="bt-card">
        ${cardHead('Step 2', '언어 짝별 검증', '프로필이 없으면 자동으로 먼저 만들어요.')}
        <div class="bt-vset-btns">${setButtons}</div>
      </section>

      <div id="bt_voice_tabs" class="bt-seg"></div>
      <div id="bt_voice_result"></div>
    </div>`;
}

function chips(items, cls = '') {
    if (!Array.isArray(items) || !items.length) return '';
    return `<div class="bt-chips ${cls}">${items.map(x => `<span class="bt-chip">${escapeHtml(typeof x === 'string' ? x : JSON.stringify(x))}</span>`).join('')}</div>`;
}

const CONF_LABEL = { high: '신뢰도 높음', medium: '신뢰도 보통', low: '신뢰도 낮음' };
const confTag = (c) => c ? `<span class="bt-tag bt-conf-${escapeHtml(c)}">${escapeHtml(CONF_LABEL[c] || c)}</span>` : '';

function kvRows(rows) {
    const body = rows.filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== 'n/a' && !(Array.isArray(v) && !v.length))
        .map(([k, v, kind]) => {
            let val;
            if (kind === 'chips') val = chips(v);
            else if (kind === 'list') val = renderList(v);
            else if (kind === 'dont') val = renderList(v, 'bt-list-dont');
            else val = escapeHtml(v);
            return `<dt>${k}</dt><dd>${val}</dd>`;
        }).join('');
    return body ? `<dl class="bt-dl bt-dl-wide">${body}</dl>` : '';
}

function renderVoiceProfile(vp) {
    const view = $id('profile_view');
    const meta = $id('profile_meta');
    if (!view) return;
    if (!vp?.profile) {
        view.innerHTML = `<p class="bt-note">프로필을 만들면 여기에 정리돼요.</p>`;
        if (meta) meta.textContent = '아직 없어요';
        return;
    }
    const p = sanitizeProfile(structuredClone(vp.profile));
    if (meta) meta.textContent = `${new Date(vp.time).toLocaleString()} · 웹 검색 ${vp.searchStat}`;

    const speech = Object.entries(p.speech || {}).filter(([, sp]) => sp).map(([k, sp]) => `
        <article class="bt-vcard">
            <div class="bt-vcard-head"><h4>${versionTitle(k)}</h4>${confTag(sp.confidence)}${sp.available === false ? '<span class="bt-tag bt-tag-ghost">공식판 없음</span>' : ''}</div>
            ${sp.style_ko ? `<div class="bt-explain"><span class="bt-explain-label">말투</span><div class="bt-prose">${prose(sp.style_ko)}</div></div>` : ''}
            ${sp.personality_ko ? `<div class="bt-explain"><span class="bt-explain-label">성격</span><div class="bt-prose">${prose(sp.personality_ko)}</div></div>` : ''}
            ${kvRows([
                ['1인칭', sp.first_person], ['호칭', sp.second_person], ['격식', sp.register],
                ['어미·문법', sp.sentence_endings], ['사투리', sp.dialect],
                ['말버릇', sp.verbal_tics, 'chips'], ['명대사', sp.catchphrases, 'chips'],
                ['예시', sp.sample_lines, 'list'], ['금지', sp.dont, 'dont'],
            ])}
        </article>`).join('');

    const c = p.personality?.canon || {};
    const f = p.personality?.fanon || {};
    const fanonRows = Object.entries(FANON_LANGS).filter(([k]) => f[k]).map(([k, label]) =>
        `<dt>${label}</dt><dd>${renderList(f[k].popular_interpretations)}${chips(f[k].tags_memes, 'bt-chips-sm')}</dd>`).join('');

    view.innerHTML = `
        <div class="bt-stack">${speech}</div>
        ${p.dialect_mapping ? `<div class="bt-callout">${ico('language')}<div class="bt-prose">${prose(p.dialect_mapping)}</div></div>` : ''}
        <article class="bt-vcard">
            <div class="bt-vcard-head"><h4>원작 성격</h4>${confTag(c.confidence)}</div>
            ${chips(c.core_traits)}
            ${kvRows([
                ['가치관', c.values], ['감정 표현', c.emotional_expression],
                ['좋아함', c.likes, 'chips'], ['싫어함', c.dislikes, 'chips'],
                ['관계', (c.relationships || []).map(r => `${r.name} — ${r.dynamic}`), 'list'],
                ['행동 패턴', c.behaviors, 'list'],
            ])}
        </article>
        <article class="bt-vcard">
            <div class="bt-vcard-head"><h4>2차 캐해 · 팬덤</h4>${confTag(f.confidence)}</div>
            ${fanonRows ? `<dl class="bt-dl bt-dl-wide">${fanonRows}</dl>` : ''}
            ${f.divergence_from_canon?.length ? `<dl class="bt-dl bt-dl-wide"><dt>원작과 차이</dt><dd>${renderList(f.divergence_from_canon)}</dd></dl>` : ''}
        </article>
        ${p.notes ? `<p class="bt-note">${ico('circle-info')} ${escapeHtml(p.notes)}</p>` : ''}
        ${vp.sources?.length ? `<details class="bt-disclosure bt-disclosure-sm"><summary><span>참고한 검색 결과 ${vp.sources.length}개</span>${ico('chevron-down')}</summary><ul class="bt-list bt-sources">${vp.sources.map(u => `<li><a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u)}</a></li>`).join('')}</ul></details>` : ''}`;
}

let currentVoiceSet = 'ja_ko';

function renderVoiceResults(data) {
    const tabs = $id('voice_tabs');
    const el = $id('voice_result');
    if (!tabs || !el) return;
    const results = data?.voiceResults || {};
    const done = Object.keys(VOICE_SETS).filter(k => results[k]?.length);
    if (!done.length) {
        tabs.innerHTML = '';
        el.innerHTML = emptyState('comment-dots', '아직 검증 결과가 없어요.<br>위에서 언어 짝을 골라 검증해 보세요.');
        return;
    }
    if (!results[currentVoiceSet]?.length) currentVoiceSet = done[0];
    tabs.innerHTML = Object.entries(VOICE_SETS).map(([k, v]) => {
        const last = results[k]?.[0]?.result?.personality;
        return `<button type="button" class="bt-seg-item ${k === currentVoiceSet ? 'active' : ''} ${results[k]?.length ? '' : 'empty'}" data-set="${k}">
            <span>${v.short}</span>${last ? `<small>${Number(last.canon_score) || 0}%</small>` : ''}</button>`;
    }).join('');
    tabs.querySelectorAll('.bt-seg-item').forEach(t => t.addEventListener('click', () => {
        if (!results[t.dataset.set]?.length) { toastr.info('이 언어 짝은 아직 검증하지 않았어요'); return; }
        currentVoiceSet = t.dataset.set;
        renderVoiceResults(data);
    }));
    const list = results[currentVoiceSet];
    renderVoiceResult(list[0], list[1]);
}

const WHERE_LABEL = FIELD_LABEL;
const PRIO_LABEL = { high: '급함', medium: '보통', low: '여유' };
const PRIO_ORDER = { high: 0, medium: 1, low: 2 };

function renderVoiceResult(entry, prev) {
    const el = $id('voice_result');
    if (!el) return;
    if (!entry?.result) { el.innerHTML = ''; return; }
    const r = sanitizeVoiceResult(structuredClone(entry.result));
    const set = VOICE_SETS[entry.set] || {};
    const p = r.personality || {};
    const pc = Math.max(0, Math.min(100, Number(p.canon_score) || 0));
    const pf = Math.max(0, Math.min(100, Number(p.fanon_score) || 0));
    const pp = prev?.result?.personality;
    const checkLabel = { first_person: '1인칭', address: '호칭', register: '격식', dialect: '사투리', tics: '말버릇' };
    const leanLabel = { canon: '원작 캐해에 가까워요', fanon: '2차 캐해에 가까워요', balanced: '원작과 2차 캐해 사이 균형', neither: '둘 다와 거리가 있어요' };
    const leanPos = { canon: 12, balanced: 50, fanon: 88, neither: 50 }[p.leaning] ?? 50;

    // --- fixes checklist
    const allFixes = (r.speech || []).flatMap(sp => (sp.bot_fixes || []).map(f => ({ ...f, version: sp.version })))
        .sort((a, b) => (PRIO_ORDER[a.priority] ?? 3) - (PRIO_ORDER[b.priority] ?? 3));
    const fixesHtml = allFixes.map((f, i) => {
        const pr = PRIO_ORDER[f.priority] !== undefined ? f.priority : 'low';
        return `<article class="bt-fixitem bt-sev-line-${pr}">
            <label class="bt-fixcheck">
                <input type="checkbox"><span class="bt-checkmark" aria-hidden="true">${ico('check')}</span>
                <span class="bt-fixwhat">${escapeHtml(f.what || '')}</span>
            </label>
            <div class="bt-fixmeta">
                <span class="bt-tag bt-prio-${pr}">${PRIO_LABEL[pr]}</span>
                ${codeTag(f.version)}
                <span class="bt-tag bt-tag-ghost">${escapeHtml(WHERE_LABEL[f.where] || f.where || '')}</span>
                ${funBadge(f.fun_impact, f.fun_note)}
            </div>
            ${f.fun_note && String(f.fun_impact).trim() === '-' ? `<div class="bt-fun-note down">${ico('masks-theater')}<span>${escapeHtml(f.fun_note)}</span></div>` : ''}
            ${f.how ? `<div class="bt-prose bt-fixhow">${prose(f.how)}</div>` : ''}
            ${f.paste ? `<div class="bt-paste-wrap"><pre class="bt-paste">${escapeHtml(f.paste)}</pre><span class="bt-paste-actions">${copyBtn('bt-fixcopy', i)}${applyBtn('bt-fixapply', i)}</span></div>` : ''}
        </article>`;
    }).join('');
    const fixesMd = allFixes.map(f => `- [ ] (${PRIO_LABEL[f.priority] || f.priority}) [${VOICE_VERSIONS[f.version]?.label || f.version} / ${WHERE_LABEL[f.where] || f.where}] ${f.what}${f.how ? `\n  - 방법: ${f.how}` : ''}${f.paste ? `\n  - 붙여넣기: ${f.paste}` : ''}`).join('\n');

    // --- per-version speech cards
    const speech = (r.speech || []).map(sp => {
        const sc = sp.score === null || sp.score === undefined ? null : Math.max(0, Math.min(100, Number(sp.score) || 0));
        const checks = Object.entries(sp.checks || {}).map(([k, v]) =>
            `<span class="bt-check bt-check-${v === 'ok' ? 'ok' : v === 'bad' ? 'bad' : 'na'}">${ico(v === 'ok' ? 'check' : v === 'bad' ? 'xmark' : 'minus')}${escapeHtml(checkLabel[k] || k)}</span>`).join('');
        const flags = (sp.flagged || []).map(f => `
            <div class="bt-flag">
                <blockquote class="bt-quote">${escapeHtml(f.line)}</blockquote>
                <dl class="bt-dl">
                    <dt>문제</dt><dd>${escapeHtml(f.problem)}</dd>
                    ${f.rewrite ? `<dt>수정</dt><dd class="bt-accent-text">${escapeHtml(f.rewrite)}</dd>` : ''}
                    ${f.rewrite_ko ? `<dt>뜻</dt><dd class="bt-muted">${escapeHtml(f.rewrite_ko)}</dd>` : ''}
                </dl>
            </div>`).join('');
        return `<article class="bt-vcard">
            <div class="bt-vcard-head"><h4>${versionTitle(sp.version)}</h4>
                ${sc === null ? '<span class="bt-tag bt-tag-ghost">샘플 없음</span>' : `<span class="bt-vcard-score" style="color:${scoreColor(sc)}">${sc}<small>%</small></span>`}</div>
            ${sc === null ? '' : `<div class="bt-bar"><i style="width:${sc}%;background:${scoreColor(sc)}"></i></div>`}
            ${checks ? `<div class="bt-checks">${checks}</div>` : ''}
            ${sp.style_ko ? `<div class="bt-explain"><span class="bt-explain-label">원래 말투</span><div class="bt-prose">${prose(sp.style_ko)}</div></div>` : ''}
            ${sp.personality_ko ? `<div class="bt-explain"><span class="bt-explain-label">성격 느낌</span><div class="bt-prose">${prose(sp.personality_ko)}</div></div>` : ''}
            ${sp.bot_style_ko ? `<div class="bt-explain bt-explain-bot"><span class="bt-explain-label">봇의 말투</span><div class="bt-prose">${prose(sp.bot_style_ko)}</div></div>` : ''}
            ${sp.comment ? `<div class="bt-prose bt-muted">${prose(sp.comment)}</div>` : ''}
            ${flags ? `<div class="bt-stack">${flags}</div>` : ''}
        </article>`;
    }).join('');

    const ooc = (p.ooc_moments || []).map(o => `
        <div class="bt-flag">
            <blockquote class="bt-quote">${escapeHtml(o.line)}</blockquote>
            <dl class="bt-dl">
                <dt>문제</dt><dd>${escapeHtml(o.problem)}</dd>
                ${o.fix ? `<dt>수정</dt><dd class="bt-accent-text">${escapeHtml(o.fix)}</dd>` : ''}
            </dl>
        </div>`).join('');

    const sugg = (r.card_suggestions || []).map((sg, i) => suggestionHtml(sg, i, 'bt-vcopy', 'bt-vapply')).join('');
    const samples = Object.entries(entry.samples || {}).map(([v, t]) =>
        `<dt>${codeTag(v)}</dt><dd><pre class="bt-paste">${escapeHtml(t)}</pre></dd>`).join('');

    el.innerHTML = `
        <section class="bt-card bt-hero bt-hero-dual">
            <div class="bt-hero-pair">
                <div class="bt-hero-cell">${ringHtml(pc, 'md')}<span class="bt-hero-caption">원작 캐해 ${deltaHtml(pc, pp?.canon_score)}</span></div>
                <div class="bt-hero-cell">${ringHtml(pf, 'md')}<span class="bt-hero-caption">2차 캐해 ${deltaHtml(pf, pp?.fanon_score)}</span></div>
            </div>
            <div class="bt-hero-meta bt-hero-meta-center">
                <span class="bt-eyebrow">${set.versions ? set.versions.map(v => VOICE_VERSIONS[v].code).join(' · ') : ''}</span>
                <h3>${escapeHtml(set.label || '')} 검증</h3>
                <div class="bt-hero-sub"><span>${escapeHtml(new Date(entry.time).toLocaleString())}</span></div>
            </div>
        </section>

        ${r.summary ? `<section class="bt-card bt-summary">${ico('quote-left')}<div class="bt-prose">${prose(r.summary)}</div></section>` : ''}

        <section class="bt-card bt-card-accent">
            ${cardHead('Action items', '지금 봇에서 고칠 부분', '말투 문제를 없애려면 카드의 어디를 어떻게 고치면 되는지, 급한 순서대로 정리했어요.')}
            ${fixesHtml ? `<div class="bt-stack">${fixesHtml}</div>
                <div class="bt-actions bt-actions-end"><button type="button" id="bt_fixcopyall" class="bt-btn">${ico('list-check')}<span>체크리스트 복사</span></button></div>`
                : '<p class="bt-note">고칠 부분이 없거나, 이전 버전에서 만든 결과예요. 다시 검증하면 나와요.</p>'}
        </section>

        ${r.compare_ko ? `<section class="bt-card">${cardHead('Compare', `${escapeHtml(set.short || '')} 차이`)}<div class="bt-prose">${prose(r.compare_ko)}</div></section>` : ''}

        <section class="bt-card">
            ${cardHead('Speech', '말투 상세')}
            <div class="bt-stack">${speech}</div>
        </section>

        <section class="bt-card">
            ${cardHead('Personality', '성격')}
            <div class="bt-meters">
                ${meterHtml('원작 캐해 일치도', pc, { sub: p.canon_comment, delta: deltaHtml(pc, pp?.canon_score) })}
                ${meterHtml(`2차 캐해 일치도 <small class="bt-muted">${escapeHtml((set.fanon || []).map(k => FANON_LANGS[k]).join(', '))}</small>`, pf, { sub: p.fanon_comment, delta: deltaHtml(pf, pp?.fanon_score) })}
            </div>
            <div class="bt-lean">
                <div class="bt-lean-labels"><span>원작</span><span>2차</span></div>
                <div class="bt-lean-track"><span class="bt-lean-dot" style="left:${leanPos}%"></span></div>
                <p class="bt-lean-caption">${escapeHtml(leanLabel[p.leaning] || p.leaning || '')}</p>
            </div>
            ${ooc ? `<h4 class="bt-subhead">캐붕 의심 장면</h4><div class="bt-stack">${ooc}</div>` : ''}
        </section>

        ${sugg ? `<section class="bt-card">${cardHead('Card', '카드 수정 제안', '복사해서 캐릭터 카드에 붙여넣으세요.')}<div class="bt-stack">${sugg}</div></section>` : ''}
        ${samples ? `<details class="bt-disclosure"><summary><span>생성된 샘플 대사</span>${ico('chevron-down')}</summary><dl class="bt-dl bt-dl-wide">${samples}</dl></details>` : ''}`;

    el.querySelectorAll('.bt-vcopy').forEach(btn => btn.addEventListener('click', () => {
        copyText((r.card_suggestions || [])[Number(btn.dataset.idx)]?.text || '');
    }));
    el.querySelectorAll('.bt-fixcopy').forEach(btn => btn.addEventListener('click', () => {
        copyText(allFixes[Number(btn.dataset.idx)]?.paste || '');
    }));
    el.querySelectorAll('.bt-fixapply').forEach(btn => btn.addEventListener('click', () => {
        const f = allFixes[Number(btn.dataset.idx)];
        if (f) openApplyDialog({ field: f.where, text: f.paste || '', reason: f.what || '' });
    }));
    el.querySelectorAll('.bt-vapply').forEach(btn => btn.addEventListener('click', () => {
        const sg = (r.card_suggestions || [])[Number(btn.dataset.idx)];
        if (sg) openApplyDialog({ field: sg.field, text: sg.text || '', reason: sg.reason || '' });
    }));
    el.querySelector('#bt_fixcopyall')?.addEventListener('click', () => copyText(`# ${set.label || ''} 말투 수정 체크리스트\n${fixesMd}`));
}

function renderVoiceForChar(data) {
    writeNamesToUI(data.names);
    renderVoiceProfile(data.voiceProfile);
    renderVoiceResults(data);
}


// ---------------------------------------------------------------------------
// Card doctor (카드 진단): tokens, prohibition overload, model fit, roleplay weaknesses
// ---------------------------------------------------------------------------

const DOCTOR_FIELDS = [
    ['description', 'Description', true],
    ['personality', 'Personality', true],
    ['scenario', 'Scenario', true],
    ['mesExamples', '예시 대사', true],
    ['system', '시스템 프롬프트', true],
    ['jailbreak', 'Post-History 지시', true],
    ['charDepthPrompt', 'Character Note', true],
    ['firstMessage', '첫 메시지', false],
];

const MODEL_FAMILIES = {
    gpt: { label: 'GPT', icon: 'circle-nodes' },
    claude: { label: 'Claude', icon: 'feather' },
    gemini: { label: 'Gemini', icon: 'star' },
};

async function countTokens(text) {
    const t = String(text || '');
    if (!t) return 0;
    try {
        const n = await ctx().getTokenCountAsync(t);
        if (Number.isFinite(n)) return n;
    } catch { /* fall back */ }
    return Math.ceil(t.length / 2.2);
}

/** Lorebook entries attached to the character: linked world file first, else the embedded book. */
async function getLoreEntries(char) {
    const out = [];
    const worldName = char?.data?.extensions?.world;
    if (worldName && typeof ctx().loadWorldInfo === 'function') {
        try {
            const data = await ctx().loadWorldInfo(worldName);
            for (const e of Object.values(data?.entries || {})) {
                out.push({
                    name: e.comment || (e.key || []).slice(0, 3).join(', ') || `#${e.uid}`,
                    keys: (e.key || []).map(String).filter(Boolean),
                    content: String(e.content || ''),
                    constant: !!e.constant,
                    enabled: !e.disable,
                    source: worldName,
                });
            }
        } catch (err) { console.warn(LOG, 'loadWorldInfo failed', err); }
    }
    if (!out.length) {
        for (const e of char?.data?.character_book?.entries || []) {
            out.push({
                name: e.comment || e.name || (e.keys || []).slice(0, 3).join(', ') || '항목',
                keys: (e.keys || []).map(String).filter(Boolean),
                content: String(e.content || ''),
                constant: !!e.constant,
                enabled: e.enabled !== false,
                source: '카드 내장',
            });
        }
    }
    return out;
}

function tokenLevel(n) {
    if (n <= 1500) return { key: 'good', label: '가벼움' };
    if (n <= 3000) return { key: 'ok', label: '적당함' };
    if (n <= 5000) return { key: 'warn', label: '많은 편' };
    return { key: 'bad', label: '과함' };
}

async function analyzeTokens(char) {
    let f = {};
    try { f = ctx().getCharacterCardFields?.() ?? {}; } catch { /* ignore */ }
    const fallback = { description: char?.description, personality: char?.personality, scenario: char?.scenario, mesExamples: char?.mes_example, firstMessage: char?.first_mes };
    const rows = [];
    for (const [key, label, permanent] of DOCTOR_FIELDS) {
        const text = String(f[key] ?? fallback[key] ?? '').trim();
        if (!text) continue;
        rows.push({ key, label, permanent, text, tokens: await countTokens(text) });
    }
    const lore = await getLoreEntries(char);
    for (const e of lore) e.tokens = e.enabled ? await countTokens(e.content) : 0;
    const active = lore.filter(e => e.enabled);
    const loreConstant = active.filter(e => e.constant).reduce((a, e) => a + e.tokens, 0);
    const loreTriggered = active.filter(e => !e.constant);
    const cardPermanent = rows.filter(r => r.permanent).reduce((a, r) => a + r.tokens, 0);
    const permanent = cardPermanent + loreConstant;
    return {
        rows, lore, permanent, cardPermanent, loreConstant,
        loreTriggeredCount: loreTriggered.length,
        loreTriggeredTokens: loreTriggered.reduce((a, e) => a + e.tokens, 0),
        firstMes: rows.find(r => r.key === 'firstMessage')?.tokens || 0,
        maxContext: Number(ctx().maxContext) || 0,
        level: tokenLevel(permanent),
    };
}

// --- local lint ---

const NEG_RE = /(\bdon'?t\b|\bdo not\b|\bnever\b|\bmust not\b|\bmustn'?t\b|\bshould not\b|\bshouldn'?t\b|\bavoid\b|\bforbidden\b|\bprohibited\b|\bnot allowed\b|\bno longer\b|금지|하지\s*마|하지\s*말|하지\s*않도록|해서는\s*안|하면\s*안|안\s*된다|말\s*것|않을\s*것|절대\s|없도록|삼가|禁止|厳禁|しないこと|するな|しないで|してはいけない|決して|べからず)/i;
const EMPH_RE = /(\bMUST\b|\bIMPORTANT\b|\bALWAYS\b|\bNEVER\b|\bCRITICAL\b|반드시|무조건|절대|필수|중요|必ず|絶対|重要|!!+)/g;

function splitSentences(text) {
    return String(text || '')
        .replace(/([.!?。！？])\s+/g, '$1\n')
        .split(/\n+/)
        .map(x => x.replace(/^[\s\-*•·>#\d.)]+/, '').trim())
        .filter(x => x.length >= 4);
}

function lintCard(stats, userName) {
    const findings = [];
    const add = (severity, category, title, detail, examples = []) => findings.push({ severity, category, title, detail, examples });
    const permTexts = [
        ...stats.rows.filter(r => r.permanent).map(r => ({ where: r.label, text: r.text })),
        ...stats.lore.filter(e => e.enabled && e.constant).map(e => ({ where: `로어북: ${e.name}`, text: e.content })),
    ];

    // 1) prohibition overload
    const sentences = permTexts.flatMap(p => splitSentences(p.text).map(s => ({ where: p.where, s })));
    // specific prohibitions that name a replacement behaviour are a good pattern — don't count them
    const REPLACEMENT_RE = /(대신|아니라|instead|rather than|reads as|, not |not an? |characterization|→|except|exception|예외|unless|하되|말고)/i;
    const negAll = sentences.filter(x => NEG_RE.test(x.s));
    const neg = negAll.filter(x => !REPLACEMENT_RE.test(x.s));
    const goodNeg = negAll.length - neg.length;
    const ratio = sentences.length ? neg.length / sentences.length : 0;
    if (neg.length >= 8 && ratio >= 0.2) {
        add('medium', '막연한 금지문', `대체 행동 없는 금지문이 많아요 (${neg.length}문장, 전체의 ${Math.round(ratio * 100)}%)`,
            `"~하지 마"만 있고 "대신 어떻게 하는지"가 없는 문장이 많으면 모델이 몸을 사려서 연기가 밋밋해질 수 있어요. 금지문을 지우지 말고 대체 행동을 붙여 주세요 (예: "놀라도 소리치지 않는다 → 느리게 눈만 깜빡인다").${goodNeg ? ` 대체 행동이 붙은 구체적인 금지문 ${goodNeg}개는 좋은 방식이라 세지 않았어요.` : ''}`,
            neg.slice(0, 5).map(x => `[${x.where}] ${x.s}`));
    } else if (neg.length >= 5 && ratio >= 0.12) {
        add('low', '막연한 금지문', `대체 행동 없는 금지문이 조금 있어요 (${neg.length}문장)`,
            '금지문은 지우지 말고, 그 대신 캐릭터가 무엇을 하는지를 한 구절 붙이면 연기가 더 살아나요.',
            neg.slice(0, 4).map(x => `[${x.where}] ${x.s}`));
    }

    // 2) shouting / emphasis spam
    // section headings like "### IDENTITY" are structure, not shouting
    const allPerm = permTexts.map(p => p.text).join('\n').split('\n').filter(l => !/^\s*(#{1,6}\s|\[[^\]]*\]\s*$|[A-Z][A-Z\s&:/-]{2,}$)/.test(l)).join('\n');
    const emph = allPerm.match(EMPH_RE) || [];
    const caps = allPerm.match(/\b[A-Z]{4,}\b/g) || [];
    if (emph.length >= 10 || caps.length >= 10) {
        add('medium', '강조어 남발', `강조어가 너무 많아요 (강조 ${emph.length}회, 대문자 단어 ${caps.length}개)`,
            '"반드시·절대·MUST·IMPORTANT·!!"가 많으면 무엇이 진짜 중요한지 흐려지고, 모델이 규칙 지키기에만 매달려 연기가 딱딱해져요. 정말 중요한 1~2개만 남기세요.',
            [...new Set([...emph, ...caps])].slice(0, 8));
    }

    // 3) duplicated sentences
    const seen = new Map();
    const dups = [];
    for (const x of sentences) {
        const k = x.s.replace(/\s+/g, ' ').toLowerCase();
        if (k.length < 10) continue;
        if (seen.has(k)) dups.push(seen.get(k) === x.where ? `[${x.where}] ${x.s}` : `[${seen.get(k)} ↔ ${x.where}] ${x.s}`);
        else seen.set(k, x.where);
    }
    if (dups.length) add('medium', '중복', `같은 문장이 여러 곳에 있어요 (${dups.length}개)`, '같은 내용이 반복되면 토큰만 늘고, 모델이 그 부분을 과하게 강조해서 받아들여요.', dups.slice(0, 4));

    // 4) card dictates {{user}}
    const un = String(userName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const userRe = new RegExp(`(\\{\\{user\\}\\}${un ? `|${un}` : ''})\\s*(?:은|는|이|가)\\s*[^.。\\n]{0,40}다(?=[.。!\\s]|$)|(\\{\\{user\\}\\}${un ? `|${un}` : ''})\\s+(?:is|feels|felt|loves|hates|always|will|thinks|wants)\\b`, 'i');
    const userCtl = sentences.filter(x => userRe.test(x.s));
    if (userCtl.length >= 2) {
        add('medium', '{{user}} 조종', `카드가 {{user}}의 감정·행동을 정해버려요 (${userCtl.length}문장)`,
            '카드에 유저의 감정이나 행동이 정해져 있으면, 봇이 유저 대신 말하거나 행동하는 버릇이 생기기 쉬워요. 유저에 대한 설정은 "관계"나 "캐릭터가 유저를 어떻게 보는지"로 바꿔 적어보세요.',
            userCtl.slice(0, 4).map(x => `[${x.where}] ${x.s}`));
    }

    // 5) sizes
    if (stats.level.key === 'bad') add('high', '토큰 과다', `항상 들어가는 토큰이 ${stats.permanent.toLocaleString()}개로 너무 많아요`, '매 응답마다 이만큼이 들어가서 비용·속도에 불리하고, 대화 기록이 들어갈 자리가 줄어요. 중요도가 낮은 설정은 키워드 로어북으로 옮기세요.');
    else if (stats.level.key === 'warn') add('medium', '토큰 과다', `항상 들어가는 토큰이 ${stats.permanent.toLocaleString()}개로 많은 편이에요`, '모든 대화에 꼭 필요한 정보만 카드에 남기고, 특정 상황에만 필요한 설정은 키워드 로어북으로 옮기면 좋아요.');
    if (stats.maxContext && stats.permanent / stats.maxContext > 0.25) add('high', '토큰 과다', `컨텍스트의 ${Math.round(stats.permanent / stats.maxContext * 100)}%를 카드가 차지해요`, '대화 기억이 금방 밀려나서 봇이 최근 대화를 잘 잊어요.');
    const fm = stats.rows.find(r => r.key === 'firstMessage');
    if (fm && fm.tokens > 700) add('medium', '첫 메시지', `첫 메시지가 길어요 (${fm.tokens.toLocaleString()} 토큰)`, '첫 메시지 길이와 문체를 모델이 그대로 따라해서, 이후 응답도 계속 길고 장황해지기 쉬워요.');
    const ex = stats.rows.find(r => r.key === 'mesExamples');
    if (ex && ex.tokens > 1500) add('medium', '예시 대사', `예시 대사가 길어요 (${ex.tokens.toLocaleString()} 토큰)`, '예시 대사가 길면 봇이 그 문장을 그대로 베끼거나 같은 표현을 반복하기 쉬워요. 말투가 드러나는 짧은 예시 3~5개면 충분해요.');

    // 6) lorebook
    const active = stats.lore.filter(e => e.enabled);
    const noKey = active.filter(e => !e.constant && !e.keys.length);
    if (noKey.length) add('medium', '로어북', `키워드가 없는 로어북 항목이 ${noKey.length}개 있어요`, '상시(constant)도 아니고 키워드도 없으면 절대 불러와지지 않아요.', noKey.slice(0, 5).map(e => e.name));
    const commonKeys = new Set(['나', '너', '그', '그녀', '우리', '사람', '말', 'the', 'a', 'i', 'you', 'he', 'she', 'it', 'and', '私', '俺', '僕', 'の', 'は']);
    const weakKeys = active.flatMap(e => e.keys.filter(k => k.trim().length <= 1 || commonKeys.has(k.trim().toLowerCase())).map(k => `${e.name}: "${k}"`));
    if (weakKeys.length) add('medium', '로어북', `너무 흔한 키워드가 있어요 (${weakKeys.length}개)`, '한 글자나 흔한 단어가 키워드면 거의 매번 발동해서, 상시 항목처럼 토큰을 먹어요.', weakKeys.slice(0, 6));
    const keyMap = new Map();
    for (const e of active) for (const k of e.keys) { const kk = k.trim().toLowerCase(); if (!kk) continue; keyMap.set(kk, [...(keyMap.get(kk) || []), e.name]); }
    const dupKeys = [...keyMap.entries()].filter(([, v]) => v.length > 1);
    if (dupKeys.length) add('low', '로어북', `여러 항목이 같은 키워드를 써요 (${dupKeys.length}개)`, '같은 키워드에 여러 항목이 한꺼번에 발동해서 토큰이 튈 수 있어요. 의도한 게 아니면 정리하세요.', dupKeys.slice(0, 5).map(([k, v]) => `"${k}" → ${v.join(', ')}`));
    const big = active.filter(e => e.tokens > 600);
    if (big.length) add('low', '로어북', `아주 긴 로어북 항목이 ${big.length}개 있어요`, '항목 하나가 길면 발동할 때마다 토큰이 크게 늘어요. 여러 항목으로 쪼개면 필요한 부분만 불러와져요.', big.slice(0, 5).map(e => `${e.name} (${e.tokens} 토큰)`));
    if (stats.loreConstant > 1500) add('medium', '로어북', `상시(constant) 로어북이 ${stats.loreConstant.toLocaleString()} 토큰이에요`, '상시 항목은 카드 본문처럼 매번 들어가요. 꼭 필요한 것만 상시로 두고 나머지는 키워드 항목으로 바꾸세요.');

    const order = { high: 0, medium: 1, low: 2 };
    return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

// --- local chat stats ---

function chatStats() {
    const bots = ctx().chat.filter(m => m && !m.is_user && !m.is_system && typeof m.mes === 'string').slice(-30);
    if (!bots.length) return null;
    const lens = bots.map(m => m.mes.length);
    const avg = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
    const opener = (t) => t.replace(/^[\s*"「『“]+/, '').slice(0, 10);
    const opCount = new Map();
    for (const m of bots) { const o = opener(m.mes); if (o.length >= 4) opCount.set(o, (opCount.get(o) || 0) + 1); }
    const repeatedOpeners = [...opCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 4);

    // phrases (5-char windows over normalized text) repeated across ≥3 messages
    const grams = new Map();
    for (const [i, m] of bots.entries()) {
        const t = m.mes.replace(/\s+/g, ' ');
        const local = new Set();
        const words = t.split(' ');
        for (let j = 0; j + 3 <= words.length; j++) {
            const g = words.slice(j, j + 3).join(' ');
            if (g.replace(/[^\p{L}]/gu, '').length >= 6) local.add(g);
        }
        for (const g of local) grams.set(g, (grams.get(g) || new Set()).add(i));
    }
    const repeatedPhrases = [];
    const candidates = [...grams.entries()].map(([g, set]) => [g, set.size]).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
    for (const [g, n] of candidates) {
        const w = g.split(' ');
        // skip windows that overlap a phrase we already picked (same sentence, shifted by one word)
        if (repeatedPhrases.some(([pg]) => { const pw = pg.split(' '); return w.filter(x => pw.includes(x)).length >= 2; })) continue;
        repeatedPhrases.push([g, n]);
        if (repeatedPhrases.length >= 6) break;
    }
    const endsQ = bots.filter(m => /[?？]\s*["」”]?\s*$/.test(m.mes.trim())).length;
    return { count: bots.length, avg, min: Math.min(...lens), max: Math.max(...lens), repeatedOpeners, repeatedPhrases, endsQuestionPct: Math.round(endsQ / bots.length * 100) };
}

// --- AI reviews ---

const MODEL_HEURISTICS = [
    'Model-family heuristics (use as hints, judge from the actual card):',
    '- Claude: follows natural prose and clear sections well; heavy lists of "never/don\'t" make it cautious, stiff or oddly fixated on the forbidden thing; long OOC rule blocks reduce immersion; strong at subtext when given motivation and inner logic.',
    '- GPT: follows explicit rules literally but may still drift into purple prose, clichés, moralizing or summarizing endings and ending every reply with a question; benefits from concrete example dialogue and clear speech rules; long prohibition lists get partially ignored.',
    '- Gemini: very instruction-sensitive and verbose; prone to repeating phrases/structures, over-describing, echoing card/lorebook text verbatim, and ballooning length; large constant lorebooks and long first messages amplify this.',
].join('\n');

async function runCardDoctor() {
    if (running) { toastr.warning('다른 작업이 진행 중이에요'); return; }
    const char = getCurrentCharacter();
    if (!char) { toastr.error('1:1 캐릭터 채팅을 열어주세요'); return; }
    const s = getSettings();
    running = true;
    updateRunState();
    try {
        const stats = await withTimer('🧮 토큰 세는 중…', analyzeTokens(char));
        const lint = lintCard(stats, ctx().name1);
        renderDoctorLocal(stats, lint);
        const charData = await loadCharData(char);
        const loreList = stats.lore.filter(e => e.enabled).slice(0, 40)
            .map(e => `- ${e.constant ? '[상시]' : `[키: ${e.keys.slice(0, 5).join(', ')}]`} ${e.name} (${e.tokens} tok): ${truncate(e.content.replace(/\s+/g, ' '), e.constant ? 600 : 220)}`).join('\n');
        const system = [
            'You are an expert prompt engineer for character roleplay bots (SillyTavern character cards and lorebooks).',
            'Diagnose how well this card will make GPT, Claude and Gemini models roleplay the character — and above all whether the roleplay will be FUN: token efficiency, clarity, structure, vague prohibitions, contradictions, vague traits, {{user}} control, things that cause repetition or bland/stiff acting, lorebook design.',
            MODEL_HEURISTICS,
            funGuard(charData),
            'Do NOT flag the fun engines above as problems. Specific prohibitions that come with a replacement behavior, per-language speech mechanics, escalation tiers, running gags and directorial cues are strengths even if they cost tokens. Only flag token cost when the text is redundant, wiki-like trivia, or never affects a scene.',
            'Rewrite examples: turn vague prohibitions or flat lines into vivid, concrete, playable instructions (keep the same language as the card). Never make a line blander or shorter at the cost of flavor.',
            'Everything human-readable in natural 한국어 (quotes and rewrites stay in the card\'s language). Short, concrete sentences.',
            NO_SHIP_RULE,
            'Limits: issues ≤ 8, rewrite_examples ≤ 4. JSON rules: straight double quotes, escape " inside strings, no trailing commas. Output ONE JSON object only:',
            '{"overall": <0-100 how well the card supports good roleplay>, "fun": <0-100 how fun the roleplay will likely be>, "summary": "<2-3 문장>",',
            ' "model_fit": [{"model": "gpt"|"claude"|"gemini", "score": <0-100>, "good": "<잘 맞는 점>", "risk": "<이 모델에서 생길 문제>", "tip": "<이 모델용 한 줄 팁>"}],',
            ` "issues": [{"severity": "high"|"medium"|"low", "category": "막연한 금지문|토큰 낭비|모순|모호함|{{user}} 조종|반복 유발|재미 부족|구조·형식|로어북|기타", "where": "<필드 이름 또는 로어북 항목>", "problem": "", "evidence": "<카드 인용>", "fix": "", "paste": "<바꿔 넣을 문장, 없으면 빈 문자열>", ${FUN_IMPACT_DOC}}],`,
            ' "rewrite_examples": [{"before": "", "after": "", "why": ""}]}',
        ].join('\n');
        const prompt = [
            `[토큰] 항상 들어감 ${stats.permanent} (카드 ${stats.cardPermanent} + 상시 로어북 ${stats.loreConstant}), 첫 메시지 ${stats.firstMes}, 키워드 로어북 ${stats.loreTriggeredCount}개/${stats.loreTriggeredTokens} tok, 최대 컨텍스트 ${stats.maxContext || '알 수 없음'}`,
            `[필드별 토큰]\n${stats.rows.map(r => `- ${r.label}: ${r.tokens}`).join('\n')}`,
            lint.length ? `[자동 검사에서 찾은 문제]\n${lint.map(f => `- (${f.severity}) ${f.title}`).join('\n')}` : '',
            charData.authorNote ? `[제작자 메모 — 의도한 설정]\n${charData.authorNote}` : '',
            `[캐릭터 카드 전문]\n${truncate(stats.rows.map(r => `### ${r.label}\n${r.text}`).join('\n\n'), 14000)}`,
            loreList ? `[로어북]\n${loreList}` : '[로어북 없음]',
            'Now output the JSON diagnosis.',
        ].filter(Boolean).join('\n\n');
        const result = await requestJsonComplete({ system, prompt, profileId: s.evalProfile, maxTokens: evalTokens(), label: '🩺 GPT·Claude·Gemini 적합도 진단 중…' });
        const cd = await loadCharData(char);
        cd.doctor = { ...(cd.doctor || {}), card: { time: Date.now(), result, permanent: stats.permanent } };
        await saveCharData(char, cd);
        renderDoctorCard(cd.doctor.card);
        setStatus(`✅ 카드 진단 완료 — 롤플 적합도 ${result.overall ?? '?'}%`);
        toastr.success('카드 진단 완료');
        setMinimized(false);
        scrollPanelTo($id('doc_card'));
    } catch (e) {
        console.error(LOG, e);
        if (e.raw) { $id('doc_card').innerHTML = `<section class="bt-card bt-card-warn">${cardHead('Format error', '결과를 표로 만들지 못했어요', '한 번 더 눌러보세요.')}<pre class="bt-paste">${escapeHtml(e.raw)}</pre></section>`; setStatus('⚠️ 결과 형식이 깨져서 원문을 보여드려요'); }
        else { setStatus(`❌ 카드 진단 실패: ${e.message}`); toastr.error(`카드 진단 실패: ${e.message}`); }
    } finally {
        running = false;
        updateRunState();
    }
}

async function runChatDoctor() {
    if (running) { toastr.warning('다른 작업이 진행 중이에요'); return; }
    const char = getCurrentCharacter();
    if (!char) { toastr.error('1:1 캐릭터 채팅을 열어주세요'); return; }
    const st = chatStats();
    if (!st || st.count < 3) { toastr.warning('봇 답장이 3개 이상 있어야 해요. 테스트 탭에서 자동 테스트를 먼저 돌려보세요.'); return; }
    const s = getSettings();
    running = true;
    updateRunState();
    try {
        const stats = await analyzeTokens(char);
        const cdFun = await loadCharData(char);
        const system = [
            'You are an expert reviewer of AI roleplay quality.',
            'Read the bot\'s replies in this roleplay chat and find what is disappointing from a roleplayer\'s point of view, and trace each problem back to the card/lorebook when possible.',
            'Look for: repetitive sentence openings/structures, reused phrases, parroting the user, speaking or acting for {{user}}, purple prose/over-description, replies too long or too short, bland or passive acting, forgetting character traits, ignoring lorebook info, OOC tone, clichés, ending every reply with a question, summarizing/moralizing endings, stiffness caused by prohibitions.',
            'Also judge FUN: does the bot create small conflicts or hooks, use physical beats and signature cues, pay off running gags and nicknames, escalate when triggered, show subtext through the body, and leave {{user}} something to react to? Boring-but-accurate replies are a problem.',
            funGuard(cdFun),
            MODEL_HEURISTICS,
            'Everything in natural 한국어 (quotes stay in the chat\'s language).',
            NO_SHIP_RULE,
            'Limits: patterns ≤ 7, evidence ≤ 2 quotes each. JSON rules: straight double quotes, escape " inside strings, no trailing commas. Output ONE JSON object only:',
            '{"overall": <0-100 roleplay quality>, "fun": <0-100 how fun this chat was>, "summary": "<2-3 문장>", "strengths": ["..."],',
            ' "patterns": [{"severity": "high"|"medium"|"low", "name": "<아쉬운 점 이름>", "evidence": ["<봇 대사 인용>"], "cause": "<카드·로어북의 어느 부분 때문인지 (모르면 빈 문자열)>", "fix": "<고치는 방법>", "paste": "<카드에 넣을 문장, 없으면 빈 문자열>"}]}',
        ].join('\n');
        const statLine = `봇 답장 ${st.count}개, 평균 ${st.avg}자 (최소 ${st.min}, 최대 ${st.max}), 질문으로 끝나는 비율 ${st.endsQuestionPct}%` +
            (st.repeatedOpeners.length ? `\n반복되는 시작: ${st.repeatedOpeners.map(([o, n]) => `"${o}…" ×${n}`).join(', ')}` : '') +
            (st.repeatedPhrases.length ? `\n여러 답장에 반복된 표현: ${st.repeatedPhrases.map(([g, n]) => `"${g}" ×${n}`).join(', ')}` : '');
        const prompt = [
            `[자동 통계]\n${statLine}`,
            `[캐릭터 카드 요약]\n${truncate(stats.rows.map(r => `### ${r.label}\n${r.text}`).join('\n\n'), 7000)}`,
            `[롤플레잉 채팅 로그]\n${collectChatLog(Math.min(40, Math.max(10, Number(s.evalMessages) || 20)))}`,
            'Now output the JSON review.',
        ].join('\n\n');
        const result = await requestJsonComplete({ system, prompt, profileId: s.evalProfile, maxTokens: evalTokens(), label: '💬 롤플 채팅 아쉬운 점 찾는 중…' });
        const cd = await loadCharData(char);
        cd.doctor = { ...(cd.doctor || {}), chat: { time: Date.now(), result, stats: st } };
        await saveCharData(char, cd);
        renderDoctorChat(cd.doctor.chat);
        setStatus(`✅ 채팅 진단 완료 — 롤플 품질 ${result.overall ?? '?'}%`);
        toastr.success('채팅 진단 완료');
        setMinimized(false);
        scrollPanelTo($id('doc_chat'));
    } catch (e) {
        console.error(LOG, e);
        if (e.raw) { $id('doc_chat').innerHTML = `<section class="bt-card bt-card-warn">${cardHead('Format error', '결과를 표로 만들지 못했어요', '한 번 더 눌러보세요.')}<pre class="bt-paste">${escapeHtml(e.raw)}</pre></section>`; setStatus('⚠️ 결과 형식이 깨져서 원문을 보여드려요'); }
        else { setStatus(`❌ 채팅 진단 실패: ${e.message}`); toastr.error(`채팅 진단 실패: ${e.message}`); }
    } finally {
        running = false;
        updateRunState();
    }
}

// --- doctor UI ---

function doctorPageHtml() {
    return `
    <div class="bt-page" data-page="doctor" style="display:none">
      <section class="bt-card">
        ${cardHead('Card doctor', '카드 진단', '토큰이 과하지 않은지, GPT·Claude·Gemini가 캐릭터를 잘 연기할 수 있는 카드인지, 실제 롤플에서 아쉬운 점이 뭔지 찾아줘요.')}
        <div class="bt-vset-btns">
          <button type="button" class="bt-vset-btn" id="bt_docbtn_fun">
            <span class="bt-doc-ico">${ico('masks-theater')}</span>
            <span class="bt-vset-text"><b>재미 분석</b><small>이 봇이 왜 재밌는지 형식을 분석하고, 지켜야 할 부분을 저장해요. 먼저 해두면 다른 제안이 재미를 해치지 않아요.</small></span>${ico('chevron-right')}
          </button>
          <button type="button" class="bt-vset-btn" id="bt_docbtn_local">
            <span class="bt-doc-ico">${ico('calculator')}</span>
            <span class="bt-vset-text"><b>토큰·구조 검사</b><small>AI를 쓰지 않아서 바로 끝나요. 금지문 비율, 중복, 로어북 키워드까지 봐요.</small></span>${ico('chevron-right')}
          </button>
          <button type="button" class="bt-vset-btn" id="bt_docbtn_card">
            <span class="bt-doc-ico">${ico('stethoscope')}</span>
            <span class="bt-vset-text"><b>AI 심층 진단</b><small>GPT·Claude·Gemini 적합도, 금지문·모순·모호한 설정, 고쳐 쓴 예시</small></span>${ico('chevron-right')}
          </button>
          <button type="button" class="bt-vset-btn" id="bt_docbtn_chat">
            <span class="bt-doc-ico">${ico('comments')}</span>
            <span class="bt-vset-text"><b>롤플 채팅 아쉬운 점</b><small>현재 채팅의 봇 답장에서 반복·유저 대신 행동·과한 묘사 등을 찾아요.</small></span>${ico('chevron-right')}
          </button>
        </div>
        <p class="bt-note">토큰 수는 지금 연결된 모델의 토크나이저 기준이에요. GPT·Claude·Gemini끼리는 ±10~20% 정도 차이 나요.</p>
      </section>
      <div id="bt_doc_fun" class="bt-result"></div>
      <div id="bt_doc_local_view" class="bt-result"></div>
      <div id="bt_doc_card" class="bt-result"></div>
      <div id="bt_doc_chat" class="bt-result"></div>
${dietCardHtml()}
      <section class="bt-card">
        ${cardHead('History', '적용 기록', '봇 테스터로 카드에 넣은 내용이에요. 되돌리면 적용 전 내용으로 돌아가요.')}
        <div id="bt_apply_log" class="bt-stack"></div>
      </section>
    </div>`;
}

function renderDoctorLocal(stats, lint) {
    const el = $id('doc_local_view');
    if (!el) return;
    const max = Math.max(1, ...stats.rows.map(r => r.tokens), stats.loreConstant);
    const row = (label, n, sub = '') => `<div class="bt-tokrow"><span class="bt-tokrow-label">${label}${sub ? `<small>${sub}</small>` : ''}</span><span class="bt-tokrow-bar"><i style="width:${Math.max(2, n / max * 100)}%"></i></span><span class="bt-tokrow-n">${n.toLocaleString()}</span></div>`;
    const rows = stats.rows.map(r => row(escapeHtml(r.label), r.tokens, r.permanent ? '' : '1회')).join('')
        + (stats.loreConstant ? row('상시 로어북', stats.loreConstant) : '')
        + (stats.loreTriggeredCount ? row('키워드 로어북', stats.loreTriggeredTokens, `${stats.loreTriggeredCount}개 · 발동할 때만`) : '');
    const pct = stats.maxContext ? Math.round(stats.permanent / stats.maxContext * 100) : null;
    const findings = lint.map(f => `
        <article class="bt-issue bt-sev-line-${f.severity}">
            <div class="bt-issue-head">${sevTag(f.severity)}<span class="bt-issue-cat">${escapeHtml(f.category)}</span></div>
            <div class="bt-fixwhat">${escapeHtml(f.title)}</div>
            <div class="bt-prose bt-muted">${prose(f.detail)}</div>
            ${f.examples?.length ? `<ul class="bt-list bt-examples">${f.examples.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : ''}
        </article>`).join('');
    el.innerHTML = `
        <section class="bt-card">
            ${cardHead('Tokens', '토큰 사용량')}
            <div class="bt-tokhero">
                <div><span class="bt-tokhero-n">${stats.permanent.toLocaleString()}</span><span class="bt-tokhero-unit">토큰</span></div>
                <div class="bt-tokhero-meta"><span class="bt-tag bt-lvl-${stats.level.key}">${stats.level.label}</span><span>매 응답마다 항상 들어가는 양${pct !== null ? ` · 컨텍스트의 ${pct}%` : ''}</span></div>
            </div>
            <div class="bt-tokrows">${rows}</div>
        </section>
        <section class="bt-card">
            ${cardHead('Lint', '구조 검사', lint.length ? `${lint.length}가지를 찾았어요.` : '')}
            ${findings ? `<div class="bt-stack">${findings}</div>` : `<div class="bt-callout">${ico('circle-check')}<div class="bt-prose"><p>금지문 비율, 강조어, 중복, 로어북 키워드 모두 괜찮아요.</p></div></div>`}
        </section>`;
}

function renderDoctorCard(entry) {
    const el = $id('doc_card');
    if (!el) return;
    if (!entry?.result) { el.innerHTML = ''; return; }
    const r = entry.result;
    const overall = Math.max(0, Math.min(100, Number(r.overall) || 0));
    const models = Object.keys(MODEL_FAMILIES).map(k => {
        const m = (r.model_fit || []).find(x => String(x.model).toLowerCase().includes(k)) || {};
        const sc = Math.max(0, Math.min(100, Number(m.score) || 0));
        return `<article class="bt-model">
            <div class="bt-model-head"><span class="bt-model-name">${ico(MODEL_FAMILIES[k].icon)}${MODEL_FAMILIES[k].label}</span><span class="bt-vcard-score" style="color:${scoreColor(sc)}">${sc}<small>%</small></span></div>
            <div class="bt-bar"><i style="width:${sc}%;background:${scoreColor(sc)}"></i></div>
            <dl class="bt-dl">
                ${m.good ? `<dt>장점</dt><dd>${escapeHtml(m.good)}</dd>` : ''}
                ${m.risk ? `<dt>위험</dt><dd>${escapeHtml(m.risk)}</dd>` : ''}
                ${m.tip ? `<dt>팁</dt><dd class="bt-accent-text">${escapeHtml(m.tip)}</dd>` : ''}
            </dl>
        </article>`;
    }).join('');
    const issues = [...(r.issues || [])].sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3)).map((it, i) => `
        <article class="bt-issue bt-sev-line-${SEV_ORDER[it.severity] !== undefined ? it.severity : 'low'}">
            <div class="bt-issue-head">${sevTag(it.severity)}<span class="bt-issue-cat">${escapeHtml(it.category || '')}</span>${it.where ? `<span class="bt-tag bt-tag-ghost">${escapeHtml(it.where)}</span>` : ''}${funBadge(it.fun_impact, it.fun_note)}</div>
            <div class="bt-prose">${prose(it.problem)}</div>
            ${it.evidence ? `<blockquote class="bt-quote">${escapeHtml(it.evidence)}</blockquote>` : ''}
            ${it.fix ? `<dl class="bt-dl"><dt>수정</dt><dd class="bt-accent-text">${escapeHtml(it.fix)}</dd></dl>` : ''}
            ${it.paste ? `<div class="bt-paste-wrap"><pre class="bt-paste">${escapeHtml(it.paste)}</pre><span class="bt-paste-actions">${copyBtn('bt-doccopy', i)}${applyBtn('bt-docapply', i)}</span></div>` : ''}
        </article>`).join('');
    const sortedIssues = [...(r.issues || [])].sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3));
    const rewrites = (r.rewrite_examples || []).map(x => `
        <article class="bt-rewrite">
            <div class="bt-rw bt-rw-before"><span>Before</span><p>${escapeHtml(x.before)}</p></div>
            <div class="bt-rw bt-rw-after"><span>After</span><p>${escapeHtml(x.after)}</p></div>
            ${x.why ? `<div class="bt-prose bt-muted">${prose(x.why)}</div>` : ''}
        </article>`).join('');
    const dFun = r.fun === undefined || r.fun === null || r.fun === '' ? null : Math.max(0, Math.min(100, Number(r.fun) || 0));
    el.innerHTML = `
        <section class="bt-card bt-hero">
            ${ringHtml(overall)}${dFun === null ? '' : ringHtml(dFun, 'md')}
            <div class="bt-hero-meta">
                <span class="bt-eyebrow">AI diagnosis</span>
                <h3>롤플 적합도${dFun === null ? '' : ' · 재미'}</h3>
                <div class="bt-hero-sub"><span>${escapeHtml(new Date(entry.time).toLocaleString())}</span></div>
            </div>
        </section>
        ${r.summary ? `<section class="bt-card bt-summary">${ico('quote-left')}<div class="bt-prose">${prose(r.summary)}</div></section>` : ''}
        <section class="bt-card">${cardHead('Model fit', '모델별 적합도')}<div class="bt-stack">${models}</div></section>
        ${issues ? `<section class="bt-card">${cardHead('Issues', '고칠 점')}<div class="bt-stack">${issues}</div></section>` : ''}
        ${rewrites ? `<section class="bt-card">${cardHead('Rewrite', '이렇게 바꿔 보세요', '금지문이나 모호한 문장을 긍정문·구체적인 문장으로 고친 예시예요.')}<div class="bt-stack">${rewrites}</div></section>` : ''}`;
    el.querySelectorAll('.bt-doccopy').forEach(btn => btn.addEventListener('click', () => copyText(sortedIssues[Number(btn.dataset.idx)]?.paste || '')));
    el.querySelectorAll('.bt-docapply').forEach(btn => btn.addEventListener('click', () => {
        const it = sortedIssues[Number(btn.dataset.idx)];
        if (it) openApplyDialog({ field: it.where, text: it.paste || '', reason: it.problem || '' });
    }));
}

function renderDoctorChat(entry) {
    const el = $id('doc_chat');
    if (!el) return;
    if (!entry?.result) { el.innerHTML = ''; return; }
    const r = entry.result;
    const st = entry.stats || {};
    const overall = Math.max(0, Math.min(100, Number(r.overall) || 0));
    const sorted = [...(r.patterns || [])].sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3));
    const patterns = sorted.map((pt, i) => `
        <article class="bt-issue bt-sev-line-${SEV_ORDER[pt.severity] !== undefined ? pt.severity : 'low'}">
            <div class="bt-issue-head">${sevTag(pt.severity)}<span class="bt-issue-cat">${escapeHtml(pt.name || '')}</span></div>
            ${(pt.evidence || []).map(q => `<blockquote class="bt-quote">${escapeHtml(q)}</blockquote>`).join('')}
            <dl class="bt-dl">
                ${pt.cause ? `<dt>원인</dt><dd>${escapeHtml(pt.cause)}</dd>` : ''}
                ${pt.fix ? `<dt>수정</dt><dd class="bt-accent-text">${escapeHtml(pt.fix)}</dd>` : ''}
            </dl>
            ${pt.paste ? `<div class="bt-paste-wrap"><pre class="bt-paste">${escapeHtml(pt.paste)}</pre><span class="bt-paste-actions">${copyBtn('bt-chatcopy', i)}${applyBtn('bt-chatapply', i)}</span></div>` : ''}
        </article>`).join('');
    const statItems = [
        ['봇 답장', `${st.count ?? '-'}개`], ['평균 길이', `${(st.avg ?? 0).toLocaleString()}자`],
        ['질문으로 끝남', `${st.endsQuestionPct ?? 0}%`], ['반복 표현', `${(st.repeatedPhrases || []).length}개`],
    ].map(([k, v]) => `<div class="bt-stat"><span>${k}</span><b>${v}</b></div>`).join('');
    const reps = [...(st.repeatedOpeners || []).map(([o, n]) => `"${o}…" 로 시작 ×${n}`), ...(st.repeatedPhrases || []).map(([g, n]) => `"${g}" ×${n}`)];
    const cFun = r.fun === undefined || r.fun === null || r.fun === '' ? null : Math.max(0, Math.min(100, Number(r.fun) || 0));
    el.innerHTML = `
        <section class="bt-card bt-hero">
            ${ringHtml(overall)}${cFun === null ? '' : ringHtml(cFun, 'md')}
            <div class="bt-hero-meta">
                <span class="bt-eyebrow">Roleplay review</span>
                <h3>롤플 품질${cFun === null ? '' : ' · 재미'}</h3>
                <div class="bt-hero-sub"><span>${escapeHtml(new Date(entry.time).toLocaleString())}</span></div>
            </div>
        </section>
        <section class="bt-card">
            ${cardHead('Stats', '자동 통계')}
            <div class="bt-stats">${statItems}</div>
            ${reps.length ? `<h4 class="bt-subhead">여러 번 반복된 표현</h4>${chips(reps, 'bt-chips-sm')}` : ''}
        </section>
        ${r.summary ? `<section class="bt-card bt-summary">${ico('quote-left')}<div class="bt-prose">${prose(r.summary)}</div></section>` : ''}
        ${patterns ? `<section class="bt-card">${cardHead('Weak points', '롤플에서 아쉬운 점')}<div class="bt-stack">${patterns}</div></section>` : ''}
        ${r.strengths?.length ? `<section class="bt-card">${cardHead('', '잘 된 점')}${renderList(r.strengths, 'bt-list-check')}</section>` : ''}`;
    el.querySelectorAll('.bt-chatcopy').forEach(btn => btn.addEventListener('click', () => copyText(sorted[Number(btn.dataset.idx)]?.paste || '')));
    el.querySelectorAll('.bt-chatapply').forEach(btn => btn.addEventListener('click', () => {
        const pt = sorted[Number(btn.dataset.idx)];
        if (pt) openApplyDialog({ field: 'description', text: pt.paste || '', reason: `${pt.name || ''}${pt.fix ? ` — ${pt.fix}` : ''}` });
    }));
}

async function runDoctorLocal(silent = false) {
    const char = getCurrentCharacter();
    if (!char) { if (!silent) toastr.error('1:1 캐릭터 채팅을 열어주세요'); return; }
    try {
        const stats = await analyzeTokens(char);
        renderDoctorLocal(stats, lintCard(stats, ctx().name1));
        if (!silent) setStatus(`✅ 토큰·구조 검사 완료 — 항상 들어가는 토큰 ${stats.permanent.toLocaleString()}개`);
    } catch (e) {
        console.error(LOG, e);
        if (!silent) setStatus(`❌ 토큰 검사 실패: ${e.message}`);
    }
}

function renderDoctorForChar(data) {
    if ($id('doc_local_view')) $id('doc_local_view').innerHTML = '';
    renderFunAnalysis(data);
    renderDoctorCard(data?.doctor?.card);
    renderDoctorChat(data?.doctor?.chat);
    const page = document.querySelector('#bt_panel .bt-page[data-page="doctor"]');
    if (page && page.style.display !== 'none') runDoctorLocal(true);
}

function bindDoctorPage() {
    $id('docbtn_local').addEventListener('click', () => { if (!running) runDoctorLocal(false); });
    $id('docbtn_card').addEventListener('click', runCardDoctor);
    $id('docbtn_chat').addEventListener('click', runChatDoctor);
    $id('docbtn_fun').addEventListener('click', runFunAnalysis);
}

// ---------------------------------------------------------------------------
// Apply suggestions to the card / lorebook (with backup & undo)
// ---------------------------------------------------------------------------

const APPLY_FIELDS = {
    description: { label: 'Description', sel: '#description_textarea' },
    personality: { label: 'Personality', sel: '#personality_textarea' },
    scenario: { label: 'Scenario', sel: '#scenario_pole' },
    first_mes: { label: '첫 메시지', sel: '#firstmessage_textarea' },
    mes_example: { label: '예시 대사', sel: '#mes_example_textarea' },
    system_prompt: { label: '시스템 프롬프트', sel: '#system_prompt_textarea' },
    post_history: { label: 'Post-History 지시', sel: '#post_history_instructions_textarea' },
    char_note: { label: 'Character Note', sel: '#depth_prompt_prompt' },
    lorebook: { label: '로어북 새 항목', sel: null },
};

function normalizeField(f) {
    const k = String(f || '').toLowerCase().replace(/[\s-]/g, '_');
    if (APPLY_FIELDS[k]) return k;
    if (/first/.test(k)) return 'first_mes';
    if (/example|mes_ex|예시/.test(k)) return 'mes_example';
    if (/lore|world|로어/.test(k)) return 'lorebook';
    if (/system|시스템/.test(k)) return 'system_prompt';
    if (/post|jailbreak/.test(k)) return 'post_history';
    if (/note|depth|author/.test(k)) return 'char_note';
    if (/person|성격/.test(k)) return 'personality';
    if (/scen/.test(k)) return 'scenario';
    return 'description';
}

function readField(key) {
    const sel = APPLY_FIELDS[key]?.sel;
    const el = sel ? document.querySelector(sel) : null;
    return el ? String(el.value ?? '') : null;
}

function writeField(key, value) {
    const sel = APPLY_FIELDS[key]?.sel;
    const el = sel ? document.querySelector(sel) : null;
    if (!el) throw new Error('캐릭터 편집 칸을 찾지 못했어요. 캐릭터 편집 화면을 한 번 열었다가 다시 시도해 주세요.');
    el.value = value;
    // SillyTavern listens with jQuery; a native input event reaches it and triggers the (debounced) character save
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (window.jQuery) window.jQuery(el).trigger('input');
}

async function addLoreEntry(worldName, { comment, keys, content }) {
    const c = ctx();
    const data = await c.loadWorldInfo(worldName);
    if (!data || typeof data.entries !== 'object') throw new Error('로어북을 불러오지 못했어요');
    let entry = null;
    try {
        const wi = await import('../../../world-info.js');
        entry = wi.createWorldInfoEntry?.(worldName, data) || null;
    } catch { /* fall back below */ }
    if (!entry) {
        const uids = Object.keys(data.entries).map(Number).filter(Number.isFinite);
        const uid = uids.length ? Math.max(...uids) + 1 : 0;
        entry = { uid, key: [], keysecondary: [], comment: '', content: '', constant: false, selective: true, order: 100, position: 0, disable: false, excludeRecursion: false, probability: 100, useProbability: true, depth: 4, group: '', displayIndex: uid };
        data.entries[uid] = entry;
    }
    entry.comment = comment || '봇 테스터 제안';
    entry.key = keys;
    entry.content = content;
    entry.constant = false;
    entry.disable = false;
    await c.saveWorldInfo(worldName, data, true);
    try { c.reloadWorldInfoEditor?.(worldName, true); } catch { /* optional */ }
    return entry.uid;
}

async function removeLoreEntry(worldName, uid) {
    const c = ctx();
    const data = await c.loadWorldInfo(worldName);
    if (!data?.entries?.[uid]) return false;
    delete data.entries[uid];
    await c.saveWorldInfo(worldName, data, true);
    try { c.reloadWorldInfoEditor?.(worldName, true); } catch { /* optional */ }
    return true;
}

async function logApply(char, item) {
    const cd = await loadCharData(char);
    cd.applyLog = [{ id: Date.now(), time: Date.now(), ...item }, ...(cd.applyLog || [])].slice(0, 30);
    await saveCharData(char, cd);
    renderApplyLog(cd);
}

/** Opens an editable preview; the user confirms before anything is written. */
async function openApplyDialog({ field, text, reason = '' }) {
    const char = getCurrentCharacter();
    if (!char) { toastr.error('캐릭터 채팅을 먼저 열어주세요'); return; }
    const c = ctx();
    if (c.menuType === 'create') { toastr.warning('새 캐릭터 만들기 화면에서는 적용할 수 없어요'); return; }
    if (!c.callGenericPopup) { copyText(text); return; }

    let key = normalizeField(field);
    const worldName = char?.data?.extensions?.world || '';
    const wrap = document.createElement('div');
    wrap.className = 'bt-apply-dialog';
    wrap.innerHTML = `
        <h3>카드에 적용하기</h3>
        <p class="bt-apply-note">아래 내용이 그대로 저장돼요. 필요하면 직접 고친 뒤 <b>적용</b>을 누르세요. 원래 내용은 백업돼서 봇 테스터의 <b>진단 → 적용 기록</b>에서 되돌릴 수 있어요.</p>
        ${reason ? `<p class="bt-apply-reason">${escapeHtml(reason)}</p>` : ''}
        <label>적용할 곳
            <select class="bt-apply-field">${Object.entries(APPLY_FIELDS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
        </label>
        <div class="bt-apply-lore">
            <label>항목 이름 <input class="bt-apply-comment" type="text" value="봇 테스터 제안"></label>
            <label>키워드 <small>(쉼표로 구분)</small> <input class="bt-apply-keys" type="text" placeholder="예) 검, 전설의 검"></label>
            <p class="bt-apply-note bt-apply-world"></p>
        </div>
        <label class="bt-apply-body-label">내용 <small class="bt-apply-hint"></small>
            <textarea class="bt-apply-text" rows="14"></textarea>
        </label>`;
    const sel = wrap.querySelector('.bt-apply-field');
    const ta = wrap.querySelector('.bt-apply-text');
    const hint = wrap.querySelector('.bt-apply-hint');
    const loreBox = wrap.querySelector('.bt-apply-lore');
    const fill = () => {
        key = sel.value;
        if (key === 'lorebook') {
            loreBox.style.display = '';
            wrap.querySelector('.bt-apply-world').textContent = worldName
                ? `“${worldName}” 로어북에 새 항목으로 추가돼요.`
                : '이 캐릭터에 연결된 로어북이 없어요. 캐릭터 편집 화면의 🌐 버튼으로 로어북을 연결한 뒤 다시 시도해 주세요.';
            ta.value = text;
            hint.textContent = '새 항목의 내용';
        } else {
            loreBox.style.display = 'none';
            const cur = readField(key);
            if (cur === null) { ta.value = text; hint.textContent = '(편집 칸을 찾지 못함)'; return; }
            ta.value = cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${text}` : text;
            hint.textContent = '현재 내용 끝에 제안을 붙여 뒀어요';
        }
    };
    sel.value = key;
    fill();
    sel.addEventListener('change', fill);

    const res = await c.callGenericPopup(wrap, c.POPUP_TYPE.CONFIRM, '', { okButton: '적용', cancelButton: '취소', wide: true, large: false, allowVerticalScrolling: true });
    if (res !== c.POPUP_RESULT.AFFIRMATIVE && res !== true && res !== 1) return;

    try {
        if (key === 'lorebook') {
            if (!worldName) { copyText(ta.value); toastr.warning('연결된 로어북이 없어서 내용만 복사했어요'); return; }
            const keys = wrap.querySelector('.bt-apply-keys').value.split(/[,，、]/).map(x => x.trim()).filter(Boolean);
            if (!keys.length) { toastr.warning('키워드를 하나 이상 적어주세요'); return; }
            const uid = await addLoreEntry(worldName, { comment: wrap.querySelector('.bt-apply-comment').value.trim(), keys, content: ta.value });
            await logApply(char, { kind: 'lore', label: `로어북: ${wrap.querySelector('.bt-apply-comment').value.trim() || '새 항목'}`, world: worldName, uid, after: ta.value });
            toastr.success('로어북에 새 항목을 추가했어요');
        } else {
            const before = readField(key);
            if (before === null) throw new Error('캐릭터 편집 칸을 찾지 못했어요');
            writeField(key, ta.value);
            await logApply(char, { kind: 'field', field: key, label: APPLY_FIELDS[key].label, before, after: ta.value });
            toastr.success(`${APPLY_FIELDS[key].label}에 적용했어요 (원본 백업됨)`);
        }
        setStatus('✅ 카드에 적용했어요 — A/B 비교로 효과를 확인해 보세요');
    } catch (e) {
        console.error(LOG, e);
        toastr.error(`적용 실패: ${e.message}`);
    }
}

async function undoApply(id) {
    const char = getCurrentCharacter();
    if (!char) return;
    const cd = await loadCharData(char);
    const item = (cd.applyLog || []).find(x => x.id === id);
    if (!item) return;
    const c = ctx();
    try {
        if (item.kind === 'lore-edit') {
            const data = await c.loadWorldInfo(item.world);
            const e = data?.entries?.[item.uid];
            if (!e) { toastr.info('그 로어북 항목은 이미 없어요'); }
            else { e.content = item.before ?? ''; await c.saveWorldInfo(item.world, data, true); try { c.reloadWorldInfoEditor?.(item.world, true); } catch { /* optional */ } toastr.success('로어북 항목을 요약 전으로 되돌렸어요'); }
        } else if (item.kind === 'lore') {
            const ok = await removeLoreEntry(item.world, item.uid);
            toastr[ok ? 'success' : 'info'](ok ? '추가했던 로어북 항목을 지웠어요' : '그 로어북 항목은 이미 없어요');
        } else {
            const cur = readField(item.field);
            if (cur !== null && cur !== item.after && c.callGenericPopup) {
                const r = await c.callGenericPopup('적용한 뒤에 이 칸이 또 바뀌었어요. 그래도 적용 전 내용으로 되돌릴까요?', c.POPUP_TYPE.CONFIRM);
                if (r !== c.POPUP_RESULT.AFFIRMATIVE && r !== true && r !== 1) return;
            }
            writeField(item.field, item.before ?? '');
            toastr.success(`${item.label}을(를) 적용 전으로 되돌렸어요`);
        }
        item.undone = Date.now();
        await saveCharData(char, cd);
        renderApplyLog(cd);
    } catch (e) {
        toastr.error(`되돌리기 실패: ${e.message}`);
    }
}

function applyBtn(cls, idx) {
    return `<button type="button" class="bt-iconbtn bt-applybtn ${cls}" data-idx="${idx}" title="카드에 적용">${ico('file-import')}</button>`;
}

function renderApplyLog(data) {
    const el = $id('apply_log');
    if (!el) return;
    const log = data?.applyLog || [];
    if (!log.length) { el.innerHTML = '<p class="bt-note">아직 적용한 내용이 없어요. 결과 화면의 <i class="fa-solid fa-file-import"></i> 버튼으로 제안을 카드에 바로 넣을 수 있어요.</p>'; return; }
    el.innerHTML = log.map(item => `
        <div class="bt-log-item ${item.undone ? 'undone' : ''}">
            <div class="bt-log-main">
                <b>${escapeHtml(item.label || '')}</b>
                <small>${escapeHtml(new Date(item.time).toLocaleString())}${item.undone ? ' · 되돌림' : ''}</small>
            </div>
            ${item.undone ? '' : `<button type="button" class="bt-btn bt-btn-sm bt-undo" data-id="${item.id}">${ico('rotate-left')}<span>되돌리기</span></button>`}
        </div>`).join('');
    el.querySelectorAll('.bt-undo').forEach(b => b.addEventListener('click', () => undoApply(Number(b.dataset.id))));
}

// ---------------------------------------------------------------------------
// A/B comparison
// ---------------------------------------------------------------------------

function abPanelHtml() {
    return `
      <section class="bt-card">
        ${cardHead('A / B', '수정 전·후 비교', '카드를 고치기 전 테스트(A)와 똑같은 메시지로 고친 뒤 다시 테스트(B)해서 점수와 답장을 나란히 비교해요.')}
        <div id="bt_ab_status" class="bt-ab-status"></div>
        <div class="bt-actions bt-actions-split">
          <button type="button" id="bt_ab_runb" class="bt-btn bt-btn-primary">${ico('code-compare')}<span>같은 메시지로 B 테스트</span></button>
          <button type="button" id="bt_ab_pin" class="bt-btn">${ico('thumbtack')}<span>최근 테스트를 A로</span></button>
        </div>
      </section>`;
}

function renderAbPanel(data) {
    const el = $id('ab_status');
    if (!el) return;
    const runs = data?.runs || [];
    const a = runs.find(r => r.id === data?.abBaselineId);
    const latest = runs[0];
    const fmt = (r) => `${new Date(r.time).toLocaleString()} · ${r.script.length}턴${r.eval ? ` · <b style="color:${scoreColor(r.eval.overall)}">${r.eval.overall}%</b>` : ' · 평가 전'}`;
    el.innerHTML = a
        ? `<div class="bt-ab-row"><span class="bt-ab-badge">A</span><span>${fmt(a)}</span></div>
           ${latest && latest.id !== a.id ? `<div class="bt-ab-row"><span class="bt-ab-badge bt-ab-badge-b">최근</span><span>${fmt(latest)}</span></div>` : ''}`
        : '<p class="bt-note">아직 기준(A)이 없어요. 위에서 테스트를 한 번 돌리면 자동으로 A가 돼요.</p>';
    $id('ab_runb')?.classList.toggle('disabled', !a || running);
    $id('ab_pin')?.classList.toggle('disabled', !latest || (a && latest.id === a.id) || running);
}

async function runAbB() {
    const char = getCurrentCharacter();
    if (!char) { toastr.error('캐릭터 채팅을 먼저 열어주세요'); return; }
    const cd = await loadCharData(char);
    const a = (cd.runs || []).find(r => r.id === cd.abBaselineId);
    if (!a) { toastr.warning('기준(A) 테스트가 없어요. 먼저 테스트를 한 번 돌려주세요.'); return; }
    if (!a.eval) {
        toastr.info('A는 아직 평가 전이라, B와 함께 비교하려면 A 채팅도 평가가 필요해요. A를 새로 돌리는 걸 추천해요.');
    }
    await runTest(a.script.length, { script: a.script, role: 'B' });
}

async function pinLatestAsA() {
    const char = getCurrentCharacter();
    if (!char) return;
    const cd = await loadCharData(char);
    if (!cd.runs?.length) return;
    cd.abBaselineId = cd.runs[0].id;
    await saveCharData(char, cd);
    renderAbPanel(cd);
    toastr.success('최근 테스트를 기준(A)으로 정했어요');
}

function renderAbCompare(data) {
    const el = $id('ab_compare');
    if (!el) return;
    const last = data?.abLast;
    const runs = data?.runs || [];
    const a = runs.find(r => r.id === last?.a);
    const b = runs.find(r => r.id === last?.b);
    if (!a || !b) { el.innerHTML = ''; return; }
    const sa = a.eval ? Number(a.eval.overall) || 0 : null;
    const sb = b.eval ? Number(b.eval.overall) || 0 : null;
    const catNames = [...new Set([...(a.eval?.categories || []), ...(b.eval?.categories || [])].map(c => c.name))];
    const catScore = (run, name) => { const c = (run.eval?.categories || []).find(x => x.name === name); return c ? Math.round(Number(c.score) || 0) : null; };
    const rows = catNames.map(n => {
        const x = catScore(a, n); const y = catScore(b, n);
        const d = x !== null && y !== null ? y - x : null;
        return `<div class="bt-ab-cat"><span>${escapeHtml(n)}</span><b>${x ?? '—'}</b><b>${y ?? '—'}</b><span class="bt-delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d === null ? '' : d === 0 ? '±0' : `${d > 0 ? '+' : ''}${d}`}</span></div>`;
    }).join('');
    const turns = a.script.map((msg, i) => `
        <details class="bt-disclosure bt-ab-turn">
            <summary><span>${i + 1}턴</span><small>${escapeHtml(truncate(msg, 60).replace(/\n/g, ' '))}</small>${ico('chevron-down')}</summary>
            <blockquote class="bt-quote">${escapeHtml(msg)}</blockquote>
            <div class="bt-ab-pair">
                <div><span class="bt-ab-badge">A</span><div class="bt-ab-reply">${escapeHtml(a.replies[i] || '(답장 없음)')}</div></div>
                <div><span class="bt-ab-badge bt-ab-badge-b">B</span><div class="bt-ab-reply">${escapeHtml(b.replies[i] || '(답장 없음)')}</div></div>
            </div>
        </details>`).join('');
    const verdict = sa === null || sb === null ? '한쪽이 평가 전이라 점수 비교는 못 했어요.'
        : sb - sa >= 3 ? `수정 후(B)가 ${sb - sa}점 더 높아요. 고친 게 효과가 있었어요.`
        : sa - sb >= 3 ? `수정 후(B)가 ${sa - sb}점 낮아요. 되돌리거나 다른 방향으로 고쳐 보세요.`
        : '점수 차이가 거의 없어요 (±2점은 평가 오차 범위예요). 아래 답장을 직접 비교해 보세요.';
    el.innerHTML = `
        <section class="bt-card bt-hero bt-hero-dual">
            <div class="bt-hero-pair">
                <div class="bt-hero-cell">${sa === null ? '<div class="bt-ring bt-ring-md"></div>' : ringHtml(sa, 'md')}<span class="bt-hero-caption">A · 수정 전</span></div>
                <div class="bt-hero-cell">${sb === null ? '<div class="bt-ring bt-ring-md"></div>' : ringHtml(sb, 'md')}<span class="bt-hero-caption">B · 수정 후 ${sa !== null && sb !== null ? deltaHtml(sb, sa) : ''}</span></div>
            </div>
            <div class="bt-hero-meta bt-hero-meta-center">
                <span class="bt-eyebrow">A / B</span>
                <h3>수정 전·후 비교</h3>
                <div class="bt-hero-sub"><span>같은 메시지 ${a.script.length}턴</span></div>
            </div>
        </section>
        <section class="bt-card bt-summary">${ico('scale-balanced')}<div class="bt-prose"><p>${escapeHtml(verdict)}</p></div></section>
        ${rows ? `<section class="bt-card">${cardHead('', '항목별 비교')}<div class="bt-ab-cats"><div class="bt-ab-cat bt-ab-head"><span>항목</span><b>A</b><b>B</b><span>차이</span></div>${rows}</div></section>` : ''}
        ${a.eval?.summary || b.eval?.summary ? `<section class="bt-card">${cardHead('', '총평 비교')}
            <div class="bt-ab-pair"><div><span class="bt-ab-badge">A</span><div class="bt-prose">${prose(a.eval?.summary || '')}</div></div><div><span class="bt-ab-badge bt-ab-badge-b">B</span><div class="bt-prose">${prose(b.eval?.summary || '')}</div></div></div></section>` : ''}
        <section class="bt-card">${cardHead('', '턴별 답장 비교', '같은 메시지에 A와 B가 어떻게 답했는지 펼쳐서 보세요.')}${turns}</section>
        <div class="bt-actions bt-actions-end"><button type="button" id="bt_ab_newa" class="bt-btn">${ico('thumbtack')}<span>B를 새 기준(A)으로</span></button></div>`;
    $id('ab_newa')?.addEventListener('click', async () => {
        const char = getCurrentCharacter();
        const cd = await loadCharData(char);
        cd.abBaselineId = b.id;
        await saveCharData(char, cd);
        renderAbPanel(cd);
        toastr.success('B를 새 기준(A)으로 정했어요');
    });
}


// ---------------------------------------------------------------------------
// Token diet (토큰 다이어트): compress card fields / lorebook entries / reference text
// ---------------------------------------------------------------------------

const DIET_FIELD_MAP = {
    description: 'description', personality: 'personality', scenario: 'scenario', mesExamples: 'mes_example',
    system: 'system_prompt', jailbreak: 'post_history', charDepthPrompt: 'char_note', firstMessage: 'first_mes',
};

const DIET_LEVELS = {
    light: { label: '가볍게 (약 20~30% 줄임)', ratio: 0.75, rule: 'Remove only obvious redundancy, filler words and repeated info. Keep the writing style.' },
    normal: { label: '보통 (약 40~50% 줄임)', ratio: 0.55, rule: 'Merge repeated info, cut flowery prose, turn long explanations into short declarative sentences or compact "Trait: value" lines.' },
    strong: { label: '강하게 (약 60~70% 줄임)', ratio: 0.35, rule: 'Keep only what changes how the character talks and acts. Use very compact lines (e.g. "Speech: …", "Likes: …"). Drop background that never affects roleplay.' },
};

function rawCardValue(char, applyKey) {
    const fromEditor = readField(applyKey);
    if (fromEditor !== null && fromEditor !== '') return fromEditor;
    const d = char?.data || {};
    return String({
        description: char?.description, personality: char?.personality, scenario: char?.scenario,
        mes_example: char?.mes_example, first_mes: char?.first_mes, system_prompt: d.system_prompt,
        post_history: d.post_history_instructions, char_note: d.extensions?.depth_prompt?.prompt,
    }[applyKey] ?? '');
}

/** Everything that can be compressed, with raw text and token counts. */
async function dietTargets(char) {
    const out = [];
    for (const [docKey, label] of DOCTOR_FIELDS) {
        const key = DIET_FIELD_MAP[docKey];
        const text = rawCardValue(char, key);
        if (!text.trim()) continue;
        out.push({ id: `f:${key}`, kind: 'field', field: key, label, text, tokens: await countTokens(text) });
    }
    const worldName = char?.data?.extensions?.world;
    if (worldName && typeof ctx().loadWorldInfo === 'function') {
        try {
            const data = await ctx().loadWorldInfo(worldName);
            for (const e of Object.values(data?.entries || {})) {
                if (e.disable || !String(e.content || '').trim()) continue;
                out.push({
                    id: `l:${e.uid}`, kind: 'lore', world: worldName, uid: e.uid,
                    label: `로어북: ${e.comment || (e.key || []).slice(0, 3).join(', ') || `#${e.uid}`}${e.constant ? ' (상시)' : ''}`,
                    text: String(e.content), tokens: await countTokens(String(e.content)), constant: !!e.constant,
                });
            }
        } catch (err) { console.warn(LOG, 'diet lore load failed', err); }
    }
    return out;
}

function parseDietOutput(raw) {
    const t = stripReasoning(String(raw || ''));
    const pick = (tag) => { const m = t.match(new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`, 'i')); return m ? m[1].trim() : ''; };
    let compressed = pick('compressed');
    const removed = pick('removed').split('\n').map(x => x.replace(/^[\s\-*•·]+/, '').trim()).filter(Boolean);
    const funRisk = pick('fun_risk').split('\n').map(x => x.replace(/^[\s\-*•·]+/, '').trim()).filter(x => x && !/^(없음|none|n\/a)$/i.test(x));
    if (!compressed) compressed = t.replace(/<\/?(?:removed|notes|fun_risk)>[\s\S]*$/i, '').trim();
    return { compressed, removed, funRisk };
}

async function compressText({ text, label, kind, level, keepExamples, positive, isReference = false, protectFun = true, charData = null }) {
    const s = getSettings();
    const L = DIET_LEVELS[level] || DIET_LEVELS.normal;
    const inTok = await countTokens(text);
    const target = Math.max(40, Math.round(inTok * L.ratio));
    const system = [
        isReference
            ? 'You condense wiki/reference material about a fictional character into a compact reference used to judge roleplay accuracy.'
            : 'You compress SillyTavern character card text to save tokens while keeping everything that matters for roleplay.',
        `Target length: about ${target} tokens (original ≈ ${inTok}). ${L.rule}`,
        'Rules:',
        '- Keep the SAME language as the original. Do not translate.',
        '- Keep every macro exactly as written ({{char}}, {{user}}, <START>, etc.).',
        '- Keep names, speech style, first-person pronoun, dialect, catchphrases, relationships, key backstory and anything that changes behaviour.',
        keepExamples ? '- Keep quoted lines / example dialogue VERBATIM (you may drop some examples, but never rewrite a kept line).' : '- You may shorten example lines, but keep the character\'s voice.',
        positive ? '- Rewrite only VAGUE prohibitions ("don\'t be OOC", "never be boring") as positive statements. Keep specific prohibitions that name a replacement behavior or define the character exactly as they are.' : '- Keep prohibitions as they are.',
        isReference ? '- Focus on personality, speech, values, relationships, likes/dislikes and major events. Drop trivia (voice actors, merchandise, release dates, popularity polls).' : '- Do not invent anything new.',
        (!isReference && protectFun) ? [
            '- PROTECT (never remove or water down, even if it costs tokens): directorial narration cues (how to show a trait on the page), state-change beats, escalation tiers with their triggers and cooldown, per-language speech mechanics and sample lines, prohibitions that name a replacement behavior, nickname/suffix systems, running gags and anecdotes, signature lines, subtext tells, scene hooks.',
            '- Cut ONLY: exact repetition, facts stated twice, wiki trivia that never affects a scene, filler words, over-long transitions.',
            '- If reaching the target length would require cutting protected material, stop above the target instead.',
            funGuard(charData),
        ].join('\n') : '',
        NO_SHIP_RULE,
        'Output format (no markdown fences):',
        '<compressed>',
        'the compressed text',
        '</compressed>',
        '<removed>',
        '- one line per piece of information you dropped or merged (in 한국어)',
        '</removed>',
        '<fun_risk>',
        '- one line per flavor/fun element that became weaker, in 한국어 (leave empty if none)',
        '</fun_risk>',
    ].filter(Boolean).join('\n');
    const prompt = `[${label}]\n${text}`;
    const raw = await callLLM({ system, prompt, profileId: s.evalProfile, maxTokens: Math.max(1500, Math.round(inTok * 1.3) + 600) });
    const out = parseDietOutput(raw);
    if (!out.compressed) throw new Error('요약 결과가 비어 있어요');
    return { ...out, before: inTok, after: await countTokens(out.compressed) };
}

// --- replace-apply with backup ---

async function applyReplace(item, newText) {
    const char = getCurrentCharacter();
    if (!char) return;
    const c = ctx();
    if (c.menuType === 'create') { toastr.warning('새 캐릭터 만들기 화면에서는 적용할 수 없어요'); return; }
    let text = newText;
    if (c.callGenericPopup) {
        const wrap = document.createElement('div');
        wrap.className = 'bt-apply-dialog';
        wrap.innerHTML = `
            <h3>${escapeHtml(item.label)} 바꾸기</h3>
            <p class="bt-apply-note">지금 내용을 아래 요약본으로 <b>바꿔요</b>. 필요하면 직접 고친 뒤 <b>적용</b>을 누르세요. 원래 내용은 백업돼서 <b>진단 → 적용 기록</b>에서 되돌릴 수 있어요.</p>
            <label>새 내용 <textarea class="bt-apply-text" rows="16"></textarea></label>`;
        wrap.querySelector('textarea').value = newText;
        const res = await c.callGenericPopup(wrap, c.POPUP_TYPE.CONFIRM, '', { okButton: '적용', cancelButton: '취소', wide: true, allowVerticalScrolling: true });
        if (res !== c.POPUP_RESULT.AFFIRMATIVE && res !== true && res !== 1) return false;
        text = wrap.querySelector('textarea').value;
    }
    try {
        if (item.kind === 'lore') {
            const data = await c.loadWorldInfo(item.world);
            const e = data?.entries?.[item.uid];
            if (!e) throw new Error('로어북 항목을 찾지 못했어요');
            const before = String(e.content || '');
            e.content = text;
            await c.saveWorldInfo(item.world, data, true);
            try { c.reloadWorldInfoEditor?.(item.world, true); } catch { /* optional */ }
            await logApply(char, { kind: 'lore-edit', label: `${item.label} (요약)`, world: item.world, uid: item.uid, before, after: text });
        } else {
            const before = readField(item.field);
            if (before === null) throw new Error('캐릭터 편집 칸을 찾지 못했어요. 캐릭터 편집 화면을 한 번 열었다가 다시 시도해 주세요.');
            writeField(item.field, text);
            await logApply(char, { kind: 'field', field: item.field, label: `${item.label} (요약)`, before, after: text });
        }
        toastr.success(`${item.label}을(를) 요약본으로 바꿨어요 (원본 백업됨)`);
        return true;
    } catch (e) {
        toastr.error(`적용 실패: ${e.message}`);
        return false;
    }
}

// --- UI ---

let dietCache = [];      // current targets
let dietResults = {};    // id -> result

function dietCardHtml() {
    return `
      <section class="bt-card" id="bt_diet_card">
        ${cardHead('Token diet', '토큰 다이어트', '카드와 로어북을 캐릭터성은 살리고 길이만 줄여요. 줄인 결과와 빠진 내용을 확인한 뒤 원하는 것만 적용하세요.')}
        <div class="bt-diet-list" id="bt_diet_list"><p class="bt-note">불러오는 중…</p></div>
        <div class="bt-grid2">
          ${field('줄이는 정도', `<select id="bt_diet_level" class="bt-input">${Object.entries(DIET_LEVELS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>`)}
          <div class="bt-field bt-diet-sum"><span class="bt-field-label">선택한 항목</span><b id="bt_diet_sum">0 토큰</b></div>
        </div>
        <div class="bt-switches">
          ${toggle('diet_protect', '재미 요소 보호 (추천)', '연출 지시·모드 전환·트리거·개그·별명 규칙·샘플 대사는 줄이지 않아요')}
          ${toggle('diet_keepex', '대사는 그대로 두기', '예시 대사·인용 대사는 문장을 바꾸지 않고 개수만 줄여요')}
          ${toggle('diet_positive', '막연한 금지문만 긍정문으로', '대체 행동이 붙은 구체적인 금지문은 그대로 둬요')}
        </div>
        <div class="bt-actions">
          <button type="button" id="bt_diet_run" class="bt-btn bt-btn-primary bt-btn-wide">${ico('scissors')}<span>선택한 항목 줄이기</span></button>
        </div>
      </section>
      <div id="bt_diet_results" class="bt-result"></div>`;
}

function updateDietSum() {
    const ids = [...document.querySelectorAll('#bt_panel .bt-diet-check:checked')].map(x => x.value);
    const sum = dietCache.filter(t => ids.includes(t.id)).reduce((a, t) => a + t.tokens, 0);
    const el = $id('diet_sum');
    if (el) el.textContent = `${ids.length}개 · ${sum.toLocaleString()} 토큰`;
}

async function refreshDietList() {
    const list = $id('diet_list');
    const char = getCurrentCharacter();
    if (!list) return;
    if (!char) { list.innerHTML = '<p class="bt-note">캐릭터 채팅을 열어주세요.</p>'; return; }
    dietCache = await dietTargets(char);
    if (!dietCache.length) { list.innerHTML = '<p class="bt-note">줄일 내용이 없어요.</p>'; return; }
    const max = Math.max(...dietCache.map(t => t.tokens), 1);
    list.innerHTML = dietCache.map(t => `
        <label class="bt-diet-row">
            <input type="checkbox" class="bt-diet-check" value="${escapeHtml(t.id)}" ${t.tokens >= 300 && t.field !== 'mes_example' ? 'checked' : ''}>
            <span class="bt-checkmark" aria-hidden="true">${ico('check')}</span>
            <span class="bt-diet-label">${escapeHtml(t.label)}</span>
            <span class="bt-tokrow-bar"><i style="width:${Math.max(2, t.tokens / max * 100)}%"></i></span>
            <span class="bt-tokrow-n">${t.tokens.toLocaleString()}</span>
        </label>`).join('');
    list.querySelectorAll('.bt-diet-check').forEach(cb => cb.addEventListener('change', updateDietSum));
    updateDietSum();
}

function renderDietResults() {
    const el = $id('diet_results');
    if (!el) return;
    const items = Object.values(dietResults).map(r => r.target).filter(Boolean);
    if (!items.length) { el.innerHTML = ''; return; }
    const totalBefore = items.reduce((a, t) => a + dietResults[t.id].before, 0);
    const totalAfter = items.reduce((a, t) => a + (dietResults[t.id].error ? dietResults[t.id].before : dietResults[t.id].after), 0);
    const pct = totalBefore ? Math.round((1 - totalAfter / totalBefore) * 100) : 0;
    el.innerHTML = `
        <section class="bt-card bt-diet-hero">
            <div><span class="bt-eyebrow">Result</span><h3>${totalBefore.toLocaleString()} → ${totalAfter.toLocaleString()} 토큰</h3></div>
            <span class="bt-diet-pct">−${pct}%</span>
        </section>
        ${items.map(t => {
            const r = dietResults[t.id];
            if (r.error) return `<section class="bt-card bt-card-warn">${cardHead('', escapeHtml(t.label), `실패: ${escapeHtml(r.error)}`)}</section>`;
            const p = r.before ? Math.round((1 - r.after / r.before) * 100) : 0;
            return `<section class="bt-card">
                <div class="bt-diet-head"><h4>${escapeHtml(t.label)}</h4><span class="bt-diet-tok">${r.before.toLocaleString()} → <b>${r.after.toLocaleString()}</b> <span class="bt-delta ${p > 0 ? 'up' : 'down'}">−${p}%</span></span></div>
                ${r.funRisk?.length ? `<div class="bt-diet-removed bt-diet-funrisk"><span>${ico('masks-theater')} 재미가 줄어들 수 있는 부분</span>${renderList(r.funRisk)}</div>` : ''}
                ${r.removed?.length ? `<div class="bt-diet-removed"><span>빠지거나 합쳐진 내용</span>${renderList(r.removed)}</div>` : ''}
                <details class="bt-disclosure bt-disclosure-sm"><summary><span>원래 내용 보기</span>${ico('chevron-down')}</summary><pre class="bt-paste">${escapeHtml(r.original ?? t.text)}</pre></details>
                <pre class="bt-paste bt-diet-out">${escapeHtml(r.compressed)}</pre>
                <div class="bt-actions bt-actions-end">
                    <button type="button" class="bt-btn bt-btn-sm bt-diet-copy" data-id="${escapeHtml(t.id)}">${ico('copy')}<span>복사</span></button>
                    ${t.kind === 'lore' || t.field ? `<button type="button" class="bt-btn bt-btn-sm bt-btn-primary bt-diet-apply" data-id="${escapeHtml(t.id)}">${ico('file-import')}<span>적용</span></button>` : ''}
                </div>
            </section>`;
        }).join('')}`;
    el.querySelectorAll('.bt-diet-copy').forEach(b => b.addEventListener('click', () => copyText(dietResults[b.dataset.id]?.compressed || '')));
    el.querySelectorAll('.bt-diet-apply').forEach(b => b.addEventListener('click', async () => {
        const r = dietResults[b.dataset.id];
        const t = r?.target;
        if (!t || !r) return;
        const ok = await applyReplace(t, r.compressed);
        if (ok) { b.classList.add('disabled'); b.querySelector('span').textContent = '적용됨'; runDoctorLocal(true); }
    }));
}

async function runDiet() {
    if (running) { toastr.warning('다른 작업이 진행 중이에요'); return; }
    const ids = [...document.querySelectorAll('#bt_panel .bt-diet-check:checked')].map(x => x.value);
    const targets = dietCache.filter(t => ids.includes(t.id));
    if (!targets.length) { toastr.warning('줄일 항목을 골라주세요'); return; }
    const level = $id('diet_level').value;
    const keepExamples = $id('diet_keepex').checked;
    const positive = $id('diet_positive').checked;
    const protectFun = $id('diet_protect').checked;
    const dietCharData = await loadCharData(getCurrentCharacter());
    running = true;
    stopRequested = false;
    updateRunState();
    dietResults = {};
    try {
        for (const [i, t] of targets.entries()) {
            if (stopRequested) break;
            try {
                dietResults[t.id] = await withTimer(`✂️ (${i + 1}/${targets.length}) ${t.label} 줄이는 중…`,
                    compressText({ text: t.text, label: t.label, kind: t.kind, level, keepExamples: keepExamples || t.field === 'mes_example', positive, protectFun, charData: dietCharData }));
                dietResults[t.id].original = t.text;
                dietResults[t.id].target = { ...t };
            } catch (e) {
                dietResults[t.id] = { error: e.message, before: t.tokens, target: { ...t } };
            }
            renderDietResults();
        }
        const done = Object.values(dietResults).filter(r => !r.error);
        const saved = done.reduce((a, r) => a + (r.before - r.after), 0);
        setStatus(`✅ 토큰 다이어트 완료 — ${saved.toLocaleString()} 토큰 줄일 수 있어요`);
        toastr.success(`${saved.toLocaleString()} 토큰을 줄일 수 있어요. 확인 후 적용하세요.`);
        setMinimized(false);
        scrollPanelTo($id('diet_results'));
    } finally {
        running = false;
        updateRunState();
    }
}

async function runReferenceDiet() {
    if (running) { toastr.warning('다른 작업이 진행 중이에요'); return; }
    const char = getCurrentCharacter();
    if (!char) { toastr.error('캐릭터 채팅을 먼저 열어주세요'); return; }
    const ta = $id('reftext');
    const text = ta.value.trim();
    if (!text) { toastr.warning('원작 자료가 비어 있어요'); return; }
    running = true;
    updateRunState();
    try {
        const r = await withTimer('✂️ 원작 자료 요약 중…', compressText({ text: truncate(text, 60000), label: '원작 자료', kind: 'reference', level: 'normal', keepExamples: true, positive: false, isReference: true }));
        const cd = await loadCharData(char);
        cd.refBackup = ta.value; // what is on screen right now (may be unsaved edits)
        cd.refText = r.compressed;
        await saveCharData(char, cd);
        ta.value = r.compressed;
        updateRefCount();
        $id('ref_undo').style.display = '';
        setStatus(`✅ 원작 자료 요약 완료 — ${r.before.toLocaleString()} → ${r.after.toLocaleString()} 토큰`);
        toastr.success('원작 자료를 요약했어요. 마음에 안 들면 되돌리기를 누르세요.');
    } catch (e) {
        setStatus(`❌ 요약 실패: ${e.message}`);
        toastr.error(`요약 실패: ${e.message}`);
    } finally {
        running = false;
        updateRunState();
    }
}

async function undoReferenceDiet() {
    const char = getCurrentCharacter();
    if (!char) return;
    const cd = await loadCharData(char);
    if (!cd.refBackup) return;
    cd.refText = cd.refBackup;
    cd.refBackup = '';
    await saveCharData(char, cd);
    $id('reftext').value = cd.refText;
    updateRefCount();
    $id('ref_undo').style.display = 'none';
    toastr.success('원작 자료를 요약 전으로 되돌렸어요');
}

function bindDietUI() {
    $id('diet_run').addEventListener('click', runDiet);
    $id('diet_keepex').checked = true;
    $id('diet_positive').checked = true;
    $id('diet_level').value = 'light';
    $id('diet_protect').checked = true;
    $id('ref_diet').addEventListener('click', runReferenceDiet);
    $id('ref_undo').addEventListener('click', undoReferenceDiet);
}


// ---------------------------------------------------------------------------
// Fun analysis (재미 분석): why a card plays well, what must be protected
// ---------------------------------------------------------------------------

const ENGINE_STRENGTH = { strong: '강함', ok: '있음', weak: '약함', missing: '없음' };

async function runFunAnalysis() {
    if (running) { toastr.warning('다른 작업이 진행 중이에요'); return; }
    const char = getCurrentCharacter();
    if (!char) { toastr.error('1:1 캐릭터 채팅을 열어주세요'); return; }
    const s = getSettings();
    running = true;
    updateRunState();
    try {
        const stats = await analyzeTokens(char);
        const greetings = [char.first_mes || char.data?.first_mes || '', ...(char.data?.alternate_greetings || [])].filter(Boolean);
        const lore = stats.lore.filter(e => e.enabled).slice(0, 30)
            .map(e => `- ${e.constant ? '[상시]' : `[키: ${e.keys.slice(0, 4).join(', ')}]`} ${e.name}: ${truncate(e.content.replace(/\s+/g, ' '), e.constant ? 900 : 300)}`).join('\n');
        const system = [
            'You are a veteran roleplay-bot designer. The creator says this bot is genuinely FUN to roleplay with. Analyze WHY, at the level of format and technique, so the fun can be protected and reused.',
            FUN_PRINCIPLES,
            'Find the concrete fun engines in THIS card (quote them), rate each, list what must never be cut, and suggest a few additions that would make it even more fun without flattening anything.',
            'style_summary: write the creator\'s "fun formula" as 6-10 short, reusable rules (in 한국어) that could guide edits to OTHER bots by the same creator.',
            'Everything human-readable in natural 한국어; quotes stay in the card\'s language.',
            NO_SHIP_RULE,
            'Limits: engines ≤ 10, protect ≤ 12, improve ≤ 5. JSON rules: straight double quotes, escape " inside strings, no trailing commas. Output ONE JSON object only:',
            '{"fun": <0-100>, "summary": "<3-4 문장: 이 봇이 왜 재밌는지>",',
            ' "engines": [{"name": "<연출 지시|모드 전환 비트|단계별 에스컬레이션|언어별 말투 설계|대체 행동이 붙은 금지문|관계·호칭 시스템|반복 개그|시그니처 대사|서브텍스트·갭|장면 훅(첫 메시지)|희소성|기타>", "strength": "strong"|"ok"|"weak"|"missing", "evidence": "<카드 인용>", "why": "<왜 재밌게 만드는지>"}],',
            ' "protect": [{"what": "<지키야 할 요소>", "where": "<필드/로어북 항목>", "quote": "<짧은 인용>"}],',
            ` "improve": [{"idea": "", "why": "", "where": "description|first_mes|mes_example|lorebook|personality|scenario", "paste": "<붙여넣을 문장, 카드 언어로>", ${FUN_IMPACT_DOC}}],`,
            ' "style_summary": "<재미 공식 6-10줄>"}',
        ].join('\n');
        const prompt = [
            `[캐릭터 카드]\n${truncate(stats.rows.filter(r => r.key !== 'firstMessage').map(r => `### ${r.label}\n${r.text}`).join('\n\n'), 12000)}`,
            `[첫 메시지 ${greetings.length}개]\n${greetings.slice(0, 4).map((g, i) => `--- ${i + 1}\n${truncate(g, 1400)}`).join('\n')}`,
            lore ? `[로어북]\n${lore}` : '',
            'Now output the JSON analysis.',
        ].filter(Boolean).join('\n\n');
        const result = await requestJsonComplete({ system, prompt, profileId: s.evalProfile, maxTokens: evalTokens(), label: '🎭 이 봇이 왜 재밌는지 분석 중…' });
        const cd = await loadCharData(char);
        cd.funProfile = { time: Date.now(), result, protect: (result.protect || []).filter(p => p && p.what) };
        await saveCharData(char, cd);
        renderFunAnalysis(cd);
        setStatus(`✅ 재미 분석 완료 — 재미 ${result.fun ?? '?'}% · 보호 항목 ${cd.funProfile.protect.length}개 저장`);
        toastr.success('재미 분석 완료. 보호 항목은 이제 모든 제안·토큰 다이어트에서 지켜져요.');
        setMinimized(false);
        scrollPanelTo($id('doc_fun'));
    } catch (e) {
        console.error(LOG, e);
        if (e.raw) { $id('doc_fun').innerHTML = `<section class="bt-card bt-card-warn">${cardHead('Format error', '결과를 표로 만들지 못했어요', '한 번 더 눌러보세요.')}<pre class="bt-paste">${escapeHtml(e.raw)}</pre></section>`; }
        else { setStatus(`❌ 재미 분석 실패: ${e.message}`); toastr.error(`재미 분석 실패: ${e.message}`); }
    } finally {
        running = false;
        updateRunState();
    }
}

function renderFunAnalysis(data) {
    const el = $id('doc_fun');
    if (!el) return;
    const fp = data?.funProfile;
    const r = fp?.result;
    const refSaved = !!getSettings().funReference;
    if (!r) { el.innerHTML = refSaved ? `<p class="bt-note bt-fun-ref">${ico('star')} 기준 재미 스타일이 저장돼 있어요. 모든 제안이 그 스타일을 따라요.</p>` : ''; return; }
    const fun = Math.max(0, Math.min(100, Number(r.fun) || 0));
    const order = { strong: 0, ok: 1, weak: 2, missing: 3 };
    const engines = [...(r.engines || [])].sort((a, b) => (order[a.strength] ?? 4) - (order[b.strength] ?? 4)).map(e => `
        <article class="bt-engine bt-engine-${escapeHtml(e.strength || 'ok')}">
            <div class="bt-issue-head"><span class="bt-tag bt-eng-${escapeHtml(e.strength || 'ok')}">${ENGINE_STRENGTH[e.strength] || e.strength || ''}</span><span class="bt-issue-cat">${escapeHtml(e.name || '')}</span></div>
            ${e.evidence ? `<blockquote class="bt-quote">${escapeHtml(e.evidence)}</blockquote>` : ''}
            ${e.why ? `<div class="bt-prose bt-muted">${prose(e.why)}</div>` : ''}
        </article>`).join('');
    const protect = (fp.protect || []).map(p => `<li><b>${escapeHtml(p.what)}</b>${p.where ? ` <span class="bt-muted">· ${escapeHtml(p.where)}</span>` : ''}${p.quote ? `<div class="bt-quote">${escapeHtml(p.quote)}</div>` : ''}</li>`).join('');
    const improve = (r.improve || []).map((x, i) => `
        <article class="bt-sugg">
            <div class="bt-sugg-head"><span class="bt-tag">${escapeHtml(FIELD_LABEL[x.where] || x.where || '')}</span>${funBadge(x.fun_impact || '+', x.fun_note)}
                <span class="bt-sugg-btns">${copyBtn('bt-funcopy', i)}${applyBtn('bt-funapply', i)}</span></div>
            <div class="bt-fixwhat" style="margin-top:6px">${escapeHtml(x.idea || '')}</div>
            ${x.why ? `<div class="bt-prose bt-muted">${prose(x.why)}</div>` : ''}
            ${x.paste ? `<pre class="bt-paste">${escapeHtml(x.paste)}</pre>` : ''}
        </article>`).join('');
    el.innerHTML = `
        <section class="bt-card bt-hero">
            ${ringHtml(fun)}
            <div class="bt-hero-meta">
                <span class="bt-eyebrow">Fun analysis</span>
                <h3>재미 분석</h3>
                <div class="bt-hero-sub"><span>${escapeHtml(new Date(fp.time).toLocaleString())}</span></div>
            </div>
        </section>
        ${r.summary ? `<section class="bt-card bt-summary">${ico('masks-theater')}<div class="bt-prose">${prose(r.summary)}</div></section>` : ''}
        ${engines ? `<section class="bt-card">${cardHead('Fun engines', '재미를 만드는 장치', '이 카드에서 롤플을 재밌게 만드는 형식이에요.')}<div class="bt-stack">${engines}</div></section>` : ''}
        ${protect ? `<section class="bt-card bt-card-accent">${cardHead('Protected', '지켜야 할 부분', '이 항목들은 이제 수정 제안·토큰 다이어트에서 지우거나 줄이지 않아요.')}<ul class="bt-list bt-protect">${protect}</ul></section>` : ''}
        ${improve ? `<section class="bt-card">${cardHead('Level up', '더 재밌게 만들기')}<div class="bt-stack">${improve}</div></section>` : ''}
        ${r.style_summary ? `<section class="bt-card">${cardHead('Formula', '이 봇의 재미 공식', '저장하면 다른 봇을 평가·수정할 때도 이 스타일을 기준으로 제안해요.')}
            <div class="bt-prose">${prose(r.style_summary, 99)}</div>
            <div class="bt-actions">
                <button type="button" id="bt_fun_saveref" class="bt-btn bt-btn-primary">${ico('star')}<span>${refSaved ? '기준 스타일 덮어쓰기' : '기준 스타일로 저장'}</span></button>
                ${refSaved ? `<button type="button" id="bt_fun_clearref" class="bt-btn">${ico('xmark')}<span>기준 스타일 지우기</span></button>` : ''}
            </div>
        </section>` : ''}`;
    el.querySelectorAll('.bt-funcopy').forEach(b => b.addEventListener('click', () => copyText(r.improve?.[Number(b.dataset.idx)]?.paste || '')));
    el.querySelectorAll('.bt-funapply').forEach(b => b.addEventListener('click', () => {
        const x = r.improve?.[Number(b.dataset.idx)];
        if (x) openApplyDialog({ field: x.where, text: x.paste || '', reason: x.idea || '' });
    }));
    $id('fun_saveref')?.addEventListener('click', () => {
        getSettings().funReference = `(${getCurrentCharacter()?.name || ''} 기준)\n${r.style_summary}`;
        saveSettings();
        toastr.success('기준 재미 스타일로 저장했어요. 이제 모든 봇의 제안이 이 스타일을 따라요.');
        renderFunAnalysis(data);
    });
    $id('fun_clearref')?.addEventListener('click', () => {
        getSettings().funReference = '';
        saveSettings();
        toastr.info('기준 재미 스타일을 지웠어요');
        renderFunAnalysis(data);
    });
}


// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(function init() {
    getSettings();
    const { eventSource, event_types } = ctx();

    const setup = () => {
        addMenuButton();
        addSettingsDrawer();
        buildPanel();
    };

    if (document.getElementById('extensionsMenu')) setup();
    eventSource.on(event_types.APP_READY, setup);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if ($id('panel') && $id('panel').style.display !== 'none') refreshPanelForChar();
    });

    try { registerCommands(); } catch (e) { console.warn(LOG, 'slash command registration failed', e); }
    console.log(LOG, 'loaded');
})();
