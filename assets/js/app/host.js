// 图床：把仓库 media/ 目录封装成对外可用的图床——上传即得 Pages 直链，站外页面/编辑器可直接引用。

import { config, state } from './state.js';
import { dom } from './dom.js';
import { encodePath, getGithubToken, readFileAsBase64, showToast } from './utils.js';
import { loadRepoTreeOnce } from './repo-tree.js';
import { CommitBatch, createOctokit } from '../github-api.js';

const HOST_ROOT = 'media';
const WARN_MB = 5;
const HARD_MB = 25;

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'];
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'avi', 'mkv'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'];

let hostItems = [];
let hostLoaded = false;
let hostBusy = false;
let hostFilter = 'all';
let hostKeyword = '';

// Pages 站点根：仓库名形如 xxx.github.io 时站点在域名根，否则在 /repo/ 子路径下
export function pagesBaseUrl() {
    const owner = String(config.owner || '').toLowerCase();
    const repo = String(config.repo || '');
    if (!owner) return `${location.origin}/`;
    if (/\.github\.io$/i.test(repo)) return `https://${owner}.github.io/`;
    return `https://${owner}.github.io/${repo}/`;
}

// media 下任意文件的公开直链（中文、空格按 URL 规则编码）
export function hostUrlFor(path) {
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
    if (!dom.hostStatus) return;
    dom.hostStatus.textContent = text || '';
    dom.hostStatus.classList.toggle('error', !!isError);
    dom.hostStatus.style.display = text ? 'block' : 'none';
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

// ==================== 渲染 ====================

function visibleItems() {
    const keyword = hostKeyword.toLowerCase();
    return hostItems.filter(item => {
        if (hostFilter !== 'all') {
            const kind = fileKind(item.name);
            if (hostFilter === 'other') {
                if (kind !== 'other') return false;
            } else if (kind !== hostFilter) {
                return false;
            }
        }
        if (keyword && !item.path.toLowerCase().includes(keyword)) return false;
        return true;
    });
}

function kindIcon(name) {
    const wrap = document.createElement('div');
    wrap.className = 'host-media-icon';
    const kind = fileKind(name);
    const iconMap = {
        image: 'fa-file-image-o',
        video: 'fa-file-video-o',
        audio: 'fa-file-audio-o',
        other: 'fa-file-o'
    };
    const icon = document.createElement('i');
    icon.className = `fa ${iconMap[kind] || 'fa-file-o'}`;
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
            media.classList.add('broken');
        });
        media.appendChild(img);
        media.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
    } else {
        media.appendChild(kindIcon(item.name));
        media.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
    }

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
    ops.appendChild(opButton('fa-trash-o', '删除（外链随之失效）', () => deleteHostItem(item), 'danger'));

    meta.appendChild(name);
    meta.appendChild(sub);
    meta.appendChild(ops);

    card.appendChild(media);
    card.appendChild(meta);
    return card;
}

function renderFolderOptions() {
    if (!dom.hostFolderOptions) return;
    const folders = new Set([HOST_ROOT]);
    hostItems.forEach(item => {
        const parts = item.path.split('/');
        for (let i = 1; i < parts.length - 1; i++) {
            folders.add(parts.slice(0, i + 1).join('/'));
        }
    });
    dom.hostFolderOptions.innerHTML = '';
    Array.from(folders)
        .sort((a, b) => a.localeCompare(b, 'zh'))
        .forEach(path => dom.hostFolderOptions.appendChild(new Option(path, path)));
}

function renderHostGrid() {
    if (!dom.hostGrid) return;
    const items = visibleItems();
    dom.hostGrid.innerHTML = '';
    items.forEach(item => dom.hostGrid.appendChild(hostCard(item)));

    if (dom.hostCount) dom.hostCount.textContent = `${items.length} / ${hostItems.length} 项`;
    if (dom.hostEmpty) {
        dom.hostEmpty.textContent = hostItems.length ? '当前筛选没有匹配的资源' : '还没有资源，上传第一张图试试。';
        dom.hostEmpty.style.display = items.length ? 'none' : 'block';
    }
    if (dom.hostBaseUrl) dom.hostBaseUrl.textContent = `${pagesBaseUrl()}${HOST_ROOT}/`;
    renderFolderOptions();
}

// ==================== 数据 ====================

async function loadHostItems(force = false) {
    setStatus('正在读取 media/ 目录...');
    try {
        const items = await loadRepoTreeOnce(force);
        hostItems = items
            .filter(item => item.type === 'file' && item.path.startsWith(HOST_ROOT + '/') && !item.path.endsWith('/.gitkeep'))
            .map(item => ({ path: item.path, name: item.path.split('/').pop(), size: item.size || 0 }))
            .sort((a, b) => a.path.localeCompare(b.path, 'zh'));
        hostLoaded = true;
        renderHostGrid();
        setStatus('');
    } catch (error) {
        console.error('读取 media/ 失败:', error);
        setStatus(`读取 media/ 失败: ${error.message || error}`, true);
    }
}

// ==================== 上传 / 删除 ====================

function pickFiles() {
    if (hostBusy) return;
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
    if (hostBusy) {
        showToast('上一批还在提交，稍等一下', true);
        return;
    }
    if (!getGithubToken()) {
        showToast('上传需要先登录（右上角头像 → 登录）', true);
        return;
    }

    const target = normalizeTarget(dom.hostTarget ? dom.hostTarget.value : HOST_ROOT);
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

    const conflicts = picked.filter(item => hostItems.some(exist => exist.path === item.path));
    if (conflicts.length && !confirm(
        `以下文件已存在，将覆盖旧文件（引用旧链接的页面可能因此变化）：\n${conflicts.map(item => item.path).join('\n')}\n\n继续吗？`
    )) return;

    const bigOnes = picked.filter(item => item.file.size > WARN_MB * 1024 * 1024);
    if (bigOnes.length && !confirm(
        `较大的文件提交会慢一些：\n${bigOnes.map(item => `${item.file.name}（${formatSize(item.file.size)}）`).join('\n')}\n\n继续吗？`
    )) return;

    hostBusy = true;
    dom.hostDropzone.classList.add('busy');
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

        setStatus('已提交，正在刷新列表...');
        await loadHostItems(true);
        await copyText(hostUrlFor(picked[0].path), `已上传 ${picked.length} 个文件，首个直链已复制`);
        setStatus(picked.length > 1 ? `已上传 ${picked.length} 个文件` : '');
    } catch (error) {
        console.error('图床上传失败:', error);
        setStatus(`上传失败: ${error.message || error}`, true);
    } finally {
        hostBusy = false;
        dom.hostDropzone.classList.remove('busy');
    }
}

async function deleteHostItem(item) {
    if (hostBusy) return;
    if (!getGithubToken()) {
        showToast('删除需要先登录', true);
        return;
    }
    if (!confirm(`确定从图床删除 ${item.path} 吗？\n已引用这个外链的站外页面会变成 404。`)) return;

    hostBusy = true;
    setStatus(`正在删除 ${item.name} ...`);
    try {
        const octokit = createOctokit(getGithubToken());
        const batch = new CommitBatch({ octokit, owner: config.owner, repo: config.repo, branch: config.branch });
        batch.delete(item.path);
        const result = await batch.commit(`图床删除: ${item.path}`);
        if (!result.success) throw new Error(result.error || '提交失败');

        hostItems = hostItems.filter(exist => exist.path !== item.path);
        if (state.repoTreeState.items) {
            state.repoTreeState.items = state.repoTreeState.items.filter(entry => entry.path !== item.path);
        }
        renderHostGrid();
        setStatus('');
        showToast('已删除');
    } catch (error) {
        console.error('图床删除失败:', error);
        setStatus(`删除失败: ${error.message || error}`, true);
    } finally {
        hostBusy = false;
    }
}

// ==================== 面板 ====================

export function openHostPanel() {
    if (!dom.hostModal) return;
    dom.hostModal.style.display = 'flex';
    if (dom.hostBaseUrl) dom.hostBaseUrl.textContent = `${pagesBaseUrl()}${HOST_ROOT}/`;
    setStatus('');
    if (!hostLoaded) {
        loadHostItems(false);
    } else {
        renderHostGrid();
    }
}

export function closeHostPanel() {
    if (dom.hostModal) dom.hostModal.style.display = 'none';
}

export function bindHostEvents() {
    if (!dom.hostModal || !dom.openHostBtn) return;

    dom.openHostBtn.addEventListener('click', openHostPanel);
    dom.hostClose.addEventListener('click', closeHostPanel);
    dom.hostModal.addEventListener('click', event => {
        if (event.target === dom.hostModal) closeHostPanel();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && dom.hostModal.style.display === 'flex') closeHostPanel();
    });

    // 点击上传区选择文件；点目标目录输入框时不触发
    dom.hostDropzone.addEventListener('click', event => {
        if (event.target.closest('input, label, datalist')) return;
        pickFiles();
    });
    ['dragenter', 'dragover'].forEach(type => {
        dom.hostDropzone.addEventListener(type, event => {
            event.preventDefault();
            dom.hostDropzone.classList.add('dragover');
        });
    });
    ['dragleave', 'drop'].forEach(type => {
        dom.hostDropzone.addEventListener(type, () => dom.hostDropzone.classList.remove('dragover'));
    });
    dom.hostDropzone.addEventListener('drop', event => {
        event.preventDefault();
        uploadFiles(event.dataTransfer ? event.dataTransfer.files : null);
    });

    // Ctrl+V 粘贴剪贴板里的图片（只在图床面板打开、且焦点不在输入框时接管）
    document.addEventListener('paste', event => {
        if (dom.hostModal.style.display !== 'flex') return;
        const tag = (event.target && event.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        const files = event.clipboardData ? event.clipboardData.files : null;
        if (!files || !files.length) return;
        event.preventDefault();
        uploadFiles(files);
    });

    dom.hostSearch.addEventListener('input', () => {
        hostKeyword = dom.hostSearch.value.trim();
        renderHostGrid();
    });

    dom.hostFilters.addEventListener('click', event => {
        const btn = event.target.closest('.host-filter');
        if (!btn) return;
        hostFilter = btn.dataset.kind || 'all';
        Array.from(dom.hostFilters.querySelectorAll('.host-filter')).forEach(el => {
            el.classList.toggle('active', el === btn);
        });
        renderHostGrid();
    });

    dom.hostRefresh.addEventListener('click', () => {
        if (hostBusy) return;
        loadHostItems(true);
    });

    dom.hostCopyAll.addEventListener('click', () => {
        const items = visibleItems();
        if (!items.length) {
            showToast('当前没有可复制的链接', true);
            return;
        }
        copyText(items.map(item => hostUrlFor(item.path)).join('\n'), `已复制 ${items.length} 条直链`);
    });
}
