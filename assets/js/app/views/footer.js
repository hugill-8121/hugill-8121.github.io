// 底部个人介绍栏：内容全部来自 blog-config.json 的 profile 字段，没配就不显示。
//
// profile 支持的字段：
//   name      显示名（必填，没有就不渲染整栏）
//   avatar    头像地址（站内相对路径或 http(s) 均可）
//   bio       一句话简介（纯文本，自动断行）
//   links     [{ label, url, icon }]，icon 用 Font Awesome 类名（如 fa-github）
//   note      底部小字，支持 {year} 占位（如 "© {year} hugill"）

import { dom } from '../core/dom.js';
import { state } from '../core/state.js';

const SAFE_LINK_RE = /^(https?:|mailto:)/i;
const SAFE_AVATAR_RE = /^(https?:|\/|\.\/|assets\/|media\/)/i;

function safeAvatar(url) {
    const raw = String(url || '').trim();
    return SAFE_AVATAR_RE.test(raw) ? raw : '';
}

function safeLink(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    return SAFE_LINK_RE.test(raw) ? raw : '';
}

function buildLink(item) {
    const url = safeLink(item && item.url);
    const label = String((item && item.label) || '').trim();
    if (!url || !label) return null;

    const a = document.createElement('a');
    a.className = 'footer-link';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    if (/^(https?:)/i.test(url)) {
        // 外链加上图标与域名提示
        a.title = url;
    }
    const icon = document.createElement('i');
    icon.className = `fa ${String(item.icon || 'fa-link').trim().replace(/^fa\s+/, 'fa ')}`;
    a.appendChild(icon);
    const span = document.createElement('span');
    span.textContent = label;
    a.appendChild(span);
    return a;
}

export function renderSiteFooter() {
    const footer = dom.siteFooter;
    if (!footer) return;

    const profile = state.siteProfile;
    const name = String((profile && profile.name) || '').trim();
    if (!name) {
        footer.style.display = 'none';
        return;
    }

    // 头像：配了就用，加载失败回退成默认图标
    const avatar = safeAvatar(profile.avatar);
    if (avatar && dom.footerAvatar) {
        dom.footerAvatar.src = avatar;
        dom.footerAvatar.alt = `${name} 的头像`;
        dom.footerAvatar.style.display = 'block';
        dom.footerAvatarFallback.style.display = 'none';
        dom.footerAvatar.onerror = () => {
            dom.footerAvatar.style.display = 'none';
            dom.footerAvatarFallback.style.display = 'block';
        };
    } else {
        dom.footerAvatar.style.display = 'none';
        dom.footerAvatar.removeAttribute('src');
        dom.footerAvatarFallback.style.display = 'block';
    }

    dom.footerName.textContent = name;

    const bio = String(profile.bio || '').trim();
    dom.footerBio.textContent = bio;
    dom.footerBio.style.display = bio ? 'block' : 'none';

    const links = Array.isArray(profile.links) ? profile.links : [];
    dom.footerLinks.innerHTML = '';
    links.forEach(item => {
        const node = buildLink(item);
        if (node) dom.footerLinks.appendChild(node);
    });
    dom.footerLinks.style.display = dom.footerLinks.childElementCount ? 'flex' : 'none';

    const note = String(profile.note || '').trim().replace(/\{year\}/g, String(new Date().getFullYear()));
    dom.footerMeta.textContent = note;
    dom.footerMeta.style.display = note ? 'block' : 'none';

    footer.style.display = 'block';
}
