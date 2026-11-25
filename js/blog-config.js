/**
 * blog-config.json 的编解码与增改逻辑（纯函数，无 DOM / 无网络依赖，便于单测）
 *
 * 配置文件结构：
 * {
 *   browser_tag, web_title, web_introduction,
 *   blogs: { <group>: [ { blog_uuid, title, description, path, tags } ] }
 * }
 */

/**
 * 解码 GitHub API 返回的 base64 文本（按 UTF-8 解码，避免中文乱码）
 * @param {string} base64
 * @returns {string}
 */
export function decodeBase64Utf8(base64) {
    const clean = String(base64 || '').replace(/\s+/g, '');
    const binary = atob(clean);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 将文本编码为 base64（按 UTF-8 编码，避免中文被截断/双重编码）
 * @param {string} text
 * @returns {string}
 */
export function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(String(text ?? ''));
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

/**
 * 规范化配置对象：保证 blogs 是对象
 * @param {Object} raw
 * @returns {Object}
 */
export function normalizeBlogConfig(raw) {
    const cfg = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    if (!cfg.blogs || typeof cfg.blogs !== 'object' || Array.isArray(cfg.blogs)) {
        cfg.blogs = {};
    }
    return cfg;
}

/**
 * 查找某篇博客在配置中的位置
 * @param {Object} config
 * @param {{uuid?: string|number, path?: string, group?: string, title?: string}} key
 * @returns {{group: string, entry: Object, index: number}|null}
 */
export function findBlogEntry(config, key = {}) {
    const cfg = normalizeBlogConfig(config);
    const hasUuid = key.uuid !== undefined && key.uuid !== null && key.uuid !== '';
    for (const group of Object.keys(cfg.blogs)) {
        const list = cfg.blogs[group];
        if (!Array.isArray(list)) continue;
        for (let index = 0; index < list.length; index++) {
            const entry = list[index];
            if (!entry) continue;
            if (hasUuid && String(entry.blog_uuid ?? entry.uuid ?? '') === String(key.uuid)) {
                return { group, entry, index };
            }
            if (key.path && entry.path === key.path) {
                // uuid 给了但不匹配时，只有路径完全一致才认定为同一篇（兼容 uuid 丢失的旧数据）
                if (!hasUuid) return { group, entry, index };
            }
            if (!hasUuid && !key.path && key.group && key.title && group === key.group && entry.title === key.title) {
                return { group, entry, index };
            }
        }
    }
    return null;
}

function assertSegment(value, label, options = {}) {
    const v = String(value ?? '').trim();
    if (!v) throw new Error(`${label}不能为空`);
    if (options.allowSlash) {
        // 分组允许映射到 blog 下的多级目录，但每一段仍必须合法
        const parts = v.split('/');
        if (v.includes('\\') || parts.some(part => !part || part === '.' || part === '..')) {
            throw new Error(`${label}不合法：不能包含反斜杠，也不能有空段`);
        }
        return v;
    }
    if (v.includes('/') || v.includes('\\')) throw new Error(`${label}不能包含斜杠`);
    return v;
}

/**
 * 新增或更新一篇博客的配置记录（只改配置对象，不落盘）
 *
 * @param {Object} config 现有配置对象
 * @param {Object} input
 * @param {string} input.group 分组名（新增必填；编辑时用于兜底）
 * @param {string} input.title 标题
 * @param {string[]} [input.tags] 标签
 * @param {string} input.path 文件路径（相对仓库根，如 blog/grpc/x.md）
 * @param {string|number} [input.uuid] blog_uuid（编辑时传入原值，新增时传入新生成值）
 * @param {string} [input.description] 描述（不传则沿用旧值 / 新增时取标题）
 * @param {'create'|'update'} [input.mode='update'] create 时同路径视为冲突并报错
 * @returns {{config: Object, action: 'added'|'updated', group: string, entry: Object}}
 */
export function upsertBlogEntry(config, input) {
    const cfg = normalizeBlogConfig(config);
    const title = assertSegment(input.title, '标题');
    const path = String(input.path ?? '').trim();
    if (!path) throw new Error('文件路径不能为空');
    if (path.startsWith('/')) throw new Error('文件路径不能以 / 开头');

    const tags = Array.isArray(input.tags)
        ? input.tags.map(t => String(t).trim()).filter(Boolean)
        : [];

    const mode = input.mode === 'create' ? 'create' : 'update';
    const hasUuid = input.uuid !== undefined && input.uuid !== null && input.uuid !== '';
    const matchedByUuid = hasUuid ? findBlogEntry(cfg, { uuid: input.uuid }) : null;
    const matchedByPath = findBlogEntry(cfg, { path });

    if (mode === 'create' && matchedByPath) {
        throw new Error(`配置中已存在相同路径的文章：${path}（标题：${matchedByPath.entry.title}）`);
    }

    const existing = mode === 'create' ? null : (matchedByUuid || matchedByPath);

    if (existing) {
        const { entry, group } = existing;
        entry.title = title;
        entry.tags = tags.length > 0 ? tags : (Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags : ['未分类']);
        if (input.description !== undefined && input.description !== null && input.description !== '') {
            entry.description = input.description;
        } else if (!entry.description) {
            entry.description = title;
        }
        if (!entry.path) entry.path = path;
        return { config: cfg, action: 'updated', group, entry };
    }

    const group = assertSegment(input.group, '分组', { allowSlash: true });
    if (!Array.isArray(cfg.blogs[group])) {
        cfg.blogs[group] = [];
    }
    const entry = {
        blog_uuid: hasUuid ? input.uuid : makeUuid(),
        title,
        description: input.description || title,
        path,
        tags: tags.length > 0 ? tags : ['未分类']
    };
    cfg.blogs[group].push(entry);
    return { config: cfg, action: 'added', group, entry };
}

/**
 * 序列化配置（统一 2 空格缩进、末尾换行）
 * @param {Object} config
 * @returns {string}
 */
export function serializeBlogConfig(config) {
    return JSON.stringify(normalizeBlogConfig(config), null, 2) + '\n';
}

/**
 * 生成 UUID（优先使用 crypto.randomUUID）
 * @returns {string}
 */
export function makeUuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
