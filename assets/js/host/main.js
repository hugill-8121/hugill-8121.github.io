// 图床独立页：host.html 的唯一入口。
// 复用 lib/github-api.js 的仓库读写能力和 core 里的 Token/工具函数，不依赖首页的 dom/state 视图层。

import { config } from '../app/core/state.js';
import { encodePath, getGithubToken, readFileAsBase64, safeClearToken, safeSetStorage, showToast } from '../app/core/utils.js';
import { CommitBatch, createOctokit, getUserInfo, isAuthError, listRepoPaths } from '../lib/github-api.js';

const HOST_ROOT = 'media';
const WARN_MB = 5;
const HARD_MB = 25;

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'];
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'avi', 'mkv'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'];

// 页面内的常用节点：一次性取好，各处直接引用
const $ = id => document.getElementById(id);
const el = {
    authChip: $('auth-chip'),
    authAvatar: $('auth-avatar'),
    authName: $('auth-name'),
    loginToggle: $('login-toggle'),
    logoutBtn: $('logout-btn'),
    loginBar: $('login-bar'),
    tokenInput: $('token-input'),
    tokenSave: $('token-save'),
    baseUrl: $('host-base-url'),
    dropzone: $('host-dropzone'),
    target: $('host-target'),
    folderOptions: $('host-folder-options'),
    search: $('host-search'),
    filters: $('host-filters'),
    count: $('host-count'),
    grid: $('host-grid'),
    empty: $('host-empty'),
    status: $('host-status'),
    refresh: $('host-refresh'),
    copyAll: $('host-copy-all')
};

let items = [];
let loaded = false;
let busy = false;
let filter = 'all';
let keyword = '';
let currentUser = null;

// ==================== 基础 ====================

// Pages 站点根：仓库名形如 xxx.github.io 时站点在域名根，否则在 /repo/ 子路径下
function pagesBaseUrl() {
    const owner = String(config.owner || '').toLowerCase();
    const repo = String(config.repo || '');
    if (!owner) return `${location.origin}/`;
    if (/\.github\.io$/i.test(repo)) return `https://${owner}.github.io/`;
    return `https://${owner}.github.io/${repo}/`;
}

// media 下任意文件的公开直链（中文、空格按 URL 规则编码）
function hostUrlFor(path) {
    return pagesBaseUrl() + encodePath(path);
}

function fileKind(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (IMAGE_EXT.includes(ext)) return 'image';
    if (VIDEO_EXT.includes(ext)) return 'video';
    if (AUDIO_EXT.includes(ext)) return 'audio';
    return 'other';
}

function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function normalizeTarget(raw) {
    let target = String(raw || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
    if (!target) return HOST_ROOT;
    if (target === HOST_ROOT) return target;
    if (!target.startsWith(HOST_ROOT + '/')) target = `${HOST_ROOT}/${target}`;
    return target;
}

function setStatus(text, isError = false) {
    if (!el.status) return;
    el.status.textContent = text || '';
    el.status.classList.toggle('error', !!isError);
    el.status.style.display = text ? 'block' : 'none';
}

async function copyText(text, message = '已复制') {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            const holder = document.createElement('textarea');
            holder.value = text;
            holder.style.position = 'fixed';
            holder.style.opacity = '0';
            document.body.appendChild(holder);
            holder.select();
            document.execCommand('copy');
            holder.remove();
        }
        showToast(message);
    } catch (error) {
        console.error('复制失败:', error);
        showToast(`复制失败，请手动复制：${text}`, true);
    }
}

// ==================== 登录态 ====================

function renderAuthChip(user) {
    currentUser = user || null;
    const logged = !!user;
    el.authChip.classList.toggle('logged', logged);
    el.authName.textContent = logged ? user.login : '未登录';
    if (logged && user.avatar_url) {
        el.authAvatar.src = user.avatar_url;
        el.authAvatar.style.display = 'block';
    } else {
        el.authAvatar.removeAttribute('src');
        el.authAvatar.style.display = 'none';
    }
    el.loginToggle.style.display = logged ? 'none' : 'inline-flex';
    el.logoutBtn.style.display = logged ? 'inline-flex' : 'none';
    if (logged) el.loginBar.classList.remove('show');
    if (el.tokenInput) el.tokenInput.value = logged ? getGithubToken() : '';
}

// 启动时静默校验本地 Token：失效就清掉，不留假登录态
async function restoreAuth() {
    const token = getGithubToken();
    if (!token) {
        renderAuthChip(null);
        return;
    }
    try {
        renderAuthChip(await getUserInfo(token));
    } catch (error) {
        if (isAuthError(error)) {
            safeClearToken();
            renderAuthChip(null);
            showToast('本地保存的 Token 已失效，已清除；上传/删除需要重新登录。', true);
        } else {
            console.warn('校验 Token 失败:', error);
            renderAuthChip(null);
        }
    }
}

async function saveToken() {
    const raw = String(el.tokenInput.value || '').trim();
    if (!raw) {
        showToast('请先粘贴 GitHub Token', true);
        return;
    }
    el.tokenSave.disabled = true;
    try {
        const user = await getUserInfo(raw);
        safeSetStorage('github-token', raw);
        renderAuthChip(user);
        showToast(`已登录为 ${user.login}`);
        if (!loaded) loadItems(false);
    } catch (error) {
        if (isAuthError(error)) showToast('Token 无效（Bad credentials），请检查权限是否包含 repo', true);
        else showToast(`校验失败：${error.message || error}`, true);
    } finally {
        el.tokenSave.disabled = false;
    }
}

function logout() {
    safeClearToken();
    renderAuthChip(null);
    showToast('已登出');
}

// ==================== 渲染 ====================

function visibleItems() {
    const kw = keyword.toLowerCase();
    return items.filter(item => {
        if (filter !== 'all' && fileKind(item.name) !== filter) return false;
        if (kw && !item.path.toLowerCase().includes(kw)) return false;
        return true;
    });
}

function kindIcon(name) {
    const wrap = document.createElement('div');
    wrap.className = 'host-media-icon';
    const iconMap = { image: 'fa-file-image-o', video: 'fa-file-video-o', audio: 'fa-file-audio-o', other: 'fa-file-o' };
    const icon = document.createElement('i');
    icon.className = `fa ${iconMap[fileKind(name)] || 'fa-file-o'}`;
    wrap.appendChild(icon);
    const ext = document.createElement('span');
    ext.textContent = (String(name || '').split('.').pop() || '').toUpperCase();
    wrap.appendChild(ext);
    return wrap;
}

function opButton(iconClass, title, onClick, extraClass = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `host-op-btn${extraClass ? ` ${extraClass}` : ''}`;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    const icon = document.createElement('i');
    icon.className = `fa ${iconClass}`;
    btn.appendChild(icon);
    btn.addEventListener('click', event => {
        event.stopPropagation();
        onClick();
    });
    return btn;
}

function hostCard(item) {
    const card = document.createElement('div');
    card.className = 'host-card';
    card.dataset.path = item.path;

    const url = hostUrlFor(item.path);
    const kind = fileKind(item.name);
    const media = document.createElement('div');
    media.className = `host-media ${kind}`;

    if (kind === 'image') {
        const img = document.createElement('img');
        img.className = 'host-thumb';
        img.loading = 'lazy';
        img.alt = item.name;
        img.src = url;
        img.addEventListener('error', () => {
            media.innerHTML = '';
            media.appendChild(kindIcon(item.name));
        });
        media.appendChild(img);
    } else {
        media.appendChild(kindIcon(item.name));
    }
    media.addEventListener('click', () => window.open(url, '_blank', 'noopener'));

    const meta = document.createElement('div');
    meta.className = 'host-meta';

    const name = document.createElement('div');
    name.className = 'host-name';
    name.textContent = item.name;
    name.title = item.path;

    const sub = document.createElement('div');
    sub.className = 'host-sub';
    sub.textContent = `${formatSize(item.size)} · ${item.path}`;
    sub.title = item.path;

    const ops = document.createElement('div');
    ops.className = 'host-ops';
    ops.appendChild(opButton('fa-link', '复制直链', () => copyText(url, '直链已复制')));
    ops.appendChild(opButton('fa-code', '复制 Markdown', () => {
        const markdown = kind === 'image' ? `![${item.name}](${url})` : `[${item.name}](${url})`;
        copyText(markdown, 'Markdown 已复制');
    }));
    ops.appendChild(opButton('fa-external-link', '新标签页打开原文件', () => window.open(url, '_blank', 'noopener')));
    ops.appendChild(opButton('fa-trash-o', '删除（外链随之失效）', () => deleteItem(item), 'danger'));

    meta.appendChild(name);
    meta.appendChild(sub);
    meta.appendChild(ops);

    card.appendChild(media);
    card.appendChild(meta);
    return card;
}

function renderFolderOptions() {
    const folders = new Set([HOST_ROOT]);
    items.forEach(item => {
        const parts = item.path.split('/');
        for (let i = 1; i < parts.length - 1; i++) {
            folders.add(parts.slice(0, i + 1).join('/'));
        }
    });
    el.folderOptions.innerHTML = '';
    Array.from(folders)
        .sort((a, b) => a.localeCompare(b, 'zh'))
        .forEach(path => el.folderOptions.appendChild(new Option(path, path)));
}

function renderGrid() {
    const list = visibleItems();
    el.grid.innerHTML = '';
    list.forEach(item => el.grid.appendChild(hostCard(item)));

    const total = items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    el.count.textContent = `${list.length} / ${items.length} 项 · ${formatSize(total)}`;
    el.empty.textContent = items.length ? '当前筛选没有匹配的资源' : 'media/ 下还没有资源，上传第一张图试试。';
    el.empty.style.display = list.length ? 'none' : 'block';
    if (el.baseUrl) el.baseUrl.textContent = `${pagesBaseUrl()}${HOST_ROOT}/`;
    renderFolderOptions();
}

// ==================== 数据 ====================

// GitHub API 走不通时（匿名 60 次/小时的限流最常见）改用 jsDelivr 的公开文件清单，
// 只读元数据、不依赖 Token，列表照样能出来
async function loadFromJsdelivr() {
    const url = `https://data.jsdelivr.com/v1/packages/gh/${config.owner}/${config.repo}@${config.branch}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`jsDelivr 清单请求失败（HTTP ${response.status}）`);
    const data = await response.json();
    const root = (data.files || []).find(entry => entry.type === 'directory' && entry.name === HOST_ROOT);
    if (!root) return [];

    const result = [];
    const walk = (node, prefix) => {
        (node.files || []).forEach(entry => {
            const path = `${prefix}/${entry.name}`;
            if (entry.type === 'directory') {
                walk(entry, path);
                return;
            }
            if (path.endsWith('/.gitkeep')) return;
            result.push({ path, name: entry.name, size: entry.size || 0 });
        });
    };
    walk(root, HOST_ROOT);
    return result;
}

async function loadItems(force = false) {
    if (busy && force) {
        showToast('正在提交，稍后再刷新', true);
        return;
    }
    setStatus('正在读取 media/ 目录...');
    let list;
    let fallbackUsed = false;
    const token = getGithubToken();
    try {
        const octokit = createOctokit(token);
        list = await listRepoPaths(octokit, { owner: config.owner, repo: config.repo, branch: config.branch }, HOST_ROOT);
    } catch (error) {
        if (token && isAuthError(error)) {
            safeClearToken();
            renderAuthChip(null);
            showToast('Token 已失效，已切换为匿名只读', true);
        }
        console.warn('仓库树读取失败，改用 jsDelivr 文件清单:', error);
        try {
            list = await loadFromJsdelivr();
            fallbackUsed = true;
        } catch (fallbackError) {
            console.error('读取 media/ 失败:', fallbackError);
            setStatus(`读取 media/ 失败: ${error.message || error}；备用清单也失败：${fallbackError.message || fallbackError}`, true);
            return;
        }
    }

    items = list
        .filter(item => item.type !== 'folder' && item.path.startsWith(HOST_ROOT + '/') && !item.path.endsWith('/.gitkeep'))
        .map(item => ({ path: item.path, name: item.name || item.path.split('/').pop(), size: item.size || 0 }))
        .sort((a, b) => a.path.localeCompare(b.path, 'zh'));
    loaded = true;
    renderGrid();
    setStatus(fallbackUsed
        ? 'GitHub API 匿名限流，已改用 jsDelivr 文件清单（内容一致，但可能比仓库最新提交晚几分钟）'
        : '');
}

// ==================== 上传 / 删除 ====================

function pickFiles() {
    if (busy) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,video/*,audio/*,.pdf,.zip,.md,.txt,.json';
    input.onchange = event => uploadFiles(event.target.files);
    input.click();
}

async function uploadFiles(fileList) {
    const files = Array.from(fileList || []).filter(file => file && file.size > 0);
    if (!files.length) return;
    if (busy) {
        showToast('上一批还在提交，稍等一下', true);
        return;
    }
    if (!getGithubToken()) {
        showToast('上传需要先登录：点右上角「登录」粘贴 Token', true);
        el.loginBar.classList.add('show');
        return;
    }

    const target = normalizeTarget(el.target ? el.target.value : HOST_ROOT);
    const picked = [];
    const skipped = [];
    const seen = new Set();
    files.forEach(file => {
        if (seen.has(file.name)) return;
        seen.add(file.name);
        if (file.size > HARD_MB * 1024 * 1024) {
            skipped.push(`${file.name}（${formatSize(file.size)}）`);
            return;
        }
        picked.push({ file, path: `${target}/${file.name}` });
    });

    if (!picked.length) {
        showToast(skipped.length ? `文件太大，单个上限 ${HARD_MB}MB：${skipped.join('、')}` : '没有可用文件', true);
        return;
    }
    if (skipped.length) showToast(`已跳过超大文件：${skipped.join('、')}`, true);

    const conflicts = picked.filter(item => items.some(exist => exist.path === item.path));
    if (conflicts.length && !confirm(
        `以下文件已存在，将覆盖旧文件（引用旧链接的页面可能因此变化）：\n${conflicts.map(item => item.path).join('\n')}\n\n继续吗？`
    )) return;

    const bigOnes = picked.filter(item => item.file.size > WARN_MB * 1024 * 1024);
    if (bigOnes.length && !confirm(
        `较大的文件提交会慢一些：\n${bigOnes.map(item => `${item.file.name}（${formatSize(item.file.size)}）`).join('\n')}\n\n继续吗？`
    )) return;

    busy = true;
    el.dropzone.classList.add('busy');
    setStatus(`正在上传 ${picked.length} 个文件到 ${target} ...`);

    try {
        const octokit = createOctokit(getGithubToken());
        const batch = new CommitBatch({ octokit, owner: config.owner, repo: config.repo, branch: config.branch });
        for (const item of picked) {
            batch.addBinary(item.path, await readFileAsBase64(item.file));
        }

        setStatus(`正在提交 ${picked.length} 个文件...`);
        const result = await batch.commit(`图床上传: ${picked.length} 个文件`);
        if (!result.success) throw new Error(result.error || '提交失败');

        // 提交成功：新文件直接并进本地列表，不再额外打一次 GitHub API（匿名额度很紧）
        picked.forEach(item => {
            const entry = { path: item.path, name: item.file.name, size: item.file.size };
            const index = items.findIndex(exist => exist.path === entry.path);
            if (index >= 0) items[index] = entry;
            else items.push(entry);
        });
        items.sort((a, b) => a.path.localeCompare(b.path, 'zh'));
        loaded = true;
        renderGrid();
        await copyText(hostUrlFor(picked[0].path), `已上传 ${picked.length} 个文件，首个直链已复制`);
        setStatus(picked.length > 1 ? `已上传 ${picked.length} 个文件（Pages 重建后外链生效）` : '已上传（Pages 重建后外链生效）');
    } catch (error) {
        if (isAuthError(error)) {
            safeClearToken();
            renderAuthChip(null);
        }
        console.error('图床上传失败:', error);
        setStatus(`上传失败: ${error.message || error}`, true);
    } finally {
        busy = false;
        el.dropzone.classList.remove('busy');
    }
}

async function deleteItem(item) {
    if (busy) return;
    if (!getGithubToken()) {
        showToast('删除需要先登录：点右上角「登录」粘贴 Token', true);
        el.loginBar.classList.add('show');
        return;
    }
    if (!confirm(`确定从图床删除 ${item.path} 吗？\n已引用这个外链的站外页面会变成 404。`)) return;

    busy = true;
    setStatus(`正在删除 ${item.name} ...`);
    try {
        const octokit = createOctokit(getGithubToken());
        const batch = new CommitBatch({ octokit, owner: config.owner, repo: config.repo, branch: config.branch });
        batch.delete(item.path);
        const result = await batch.commit(`图床删除: ${item.path}`);
        if (!result.success) throw new Error(result.error || '提交失败');

        items = items.filter(exist => exist.path !== item.path);
        renderGrid();
        setStatus('');
        showToast('已删除');
    } catch (error) {
        console.error('图床删除失败:', error);
        setStatus(`删除失败: ${error.message || error}`, true);
    } finally {
        busy = false;
    }
}

// ==================== 事件 ====================

function bindEvents() {
    el.loginToggle.addEventListener('click', () => {
        const shown = el.loginBar.classList.toggle('show');
        if (shown) el.tokenInput.focus();
    });
    el.tokenSave.addEventListener('click', saveToken);
    el.tokenInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') saveToken();
    });
    el.logoutBtn.addEventListener('click', logout);

    // 点击上传区选择文件；点目标目录输入框时不触发
    el.dropzone.addEventListener('click', event => {
        if (event.target.closest('input, label, datalist')) return;
        pickFiles();
    });
    ['dragenter', 'dragover'].forEach(type => {
        el.dropzone.addEventListener(type, event => {
            event.preventDefault();
            el.dropzone.classList.add('dragover');
        });
    });
    ['dragleave', 'drop'].forEach(type => {
        el.dropzone.addEventListener(type, () => el.dropzone.classList.remove('dragover'));
    });
    el.dropzone.addEventListener('drop', event => {
        event.preventDefault();
        uploadFiles(event.dataTransfer ? event.dataTransfer.files : null);
    });

    // Ctrl+V 粘贴剪贴板里的图片（焦点在输入框时不接管）
    document.addEventListener('paste', event => {
        const tag = (event.target && event.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        const files = event.clipboardData ? event.clipboardData.files : null;
        if (!files || !files.length) return;
        event.preventDefault();
        uploadFiles(files);
    });

    el.search.addEventListener('input', () => {
        keyword = el.search.value.trim();
        renderGrid();
    });

    el.filters.addEventListener('click', event => {
        const btn = event.target.closest('.host-filter');
        if (!btn) return;
        filter = btn.dataset.kind || 'all';
        Array.from(el.filters.querySelectorAll('.host-filter')).forEach(node => {
            node.classList.toggle('active', node === btn);
        });
        renderGrid();
    });

    el.refresh.addEventListener('click', () => {
        if (busy) return;
        loadItems(true);
    });

    el.copyAll.addEventListener('click', () => {
        const list = visibleItems();
        if (!list.length) {
            showToast('当前没有可复制的链接', true);
            return;
        }
        copyText(list.map(item => hostUrlFor(item.path)).join('\n'), `已复制 ${list.length} 条直链`);
    });
}

// ==================== 启动 ====================

async function init() {
    el.empty.textContent = '正在读取 media/ 目录...';
    setStatus('正在读取 media/ 目录...');
    bindEvents();
    await restoreAuth();
    await loadItems(false);
}

init();
