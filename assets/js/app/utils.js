// 通用工具：路径编码、localStorage、Token、toast、favicon、URL 参数。

import { state } from './state.js';
import { sanitizeToken } from '../github-api.js';

// 仓库路径分段编码（兼容中文 / 空格）
export function encodePath(path) {
    return String(path || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

// 安全的 localStorage 访问函数
function safeGetStorage(key) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        console.warn('无法访问 localStorage:', e);
        return null;
    }
}

export function safeSetStorage(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        console.warn('无法写入 localStorage:', e);
        return false;
    }
}

// 读取 Token：自动清掉粘贴时带进来的换行、空格、BOM、"token " 前缀
export function getGithubToken() {
    const raw = safeGetStorage('github-token');
    if (!raw) return '';
    const clean = sanitizeToken(raw);
    if (clean !== raw) {
        if (clean) safeSetStorage('github-token', clean);
        else safeClearToken();
    }
    return clean;
}

export function safeClearToken() {
    try {
        localStorage.removeItem('github-token');
    } catch (e) {
        console.warn('无法清理 localStorage:', e);
    }
}

// 读取本地文件为 base64（去掉 data URL 前缀）：资源上传和图床共用
export function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
        reader.readAsDataURL(file);
    });
}

// 轻量提示条，不打断浏览
let toastTimer = null;

export function showToast(message, isError = false) {
    let el = document.getElementById('app-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'app-toast';
        el.className = 'app-toast';
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 5000);
}
/**
 * 设置标签页图标。同一 <link> 上换 href：Chrome/Edge 会立即更新标签页图标。
 * @param {string} href
 */

export function setPageFavicon(href) {
    const link = document.getElementById('page-favicon');
    if (!link) return;
    const finalHref = href || state.siteFavicon;
    if (link.href === finalHref) return;
    link.type = /\.svg([?#]|$)/.test(finalHref) ? 'image/svg+xml' : 'image/png';
    link.href = finalHref;
}

// 登录用户头像作为图标：先预加载确认可用，失败则回退站点图标
export function setFaviconToAvatar(avatarUrl) {
    const base = String(avatarUrl || '').trim();
    if (!base) {
        setPageFavicon(state.siteFavicon);
        return;
    }
    // GitHub 头像支持 s=64 参数，请求小图避免拿 460px 大图做图标
    const url = base + (base.includes('?') ? '&' : '?') + 's=64';
    const probe = new Image();
    probe.onload = () => setPageFavicon(url);
    probe.onerror = () => setPageFavicon(state.siteFavicon);
    probe.src = url;
    // 立即先挂上，避免首次登录时要等预加载
    setPageFavicon(url);
}

// 解析URL参数
// 用 URLSearchParams 解析：文件名里带 = 号（或 + 号）时不会被截断
export function getUrlParams() {
    const params = {};
    new URLSearchParams(window.location.search).forEach((value, key) => {
        if (key) params[key] = value;
    });
    return params;
}
