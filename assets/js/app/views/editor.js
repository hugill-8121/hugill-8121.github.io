// 编辑区：多标签页、表单快照与脏标记、标签 chip、commit message、分类/目录候选。

import { config, state } from '../core/state.js';
import { dom } from '../core/dom.js';
import { renderFileTree } from './file-tree.js';
import { renderResourceTree } from './resource-tree.js';
import { escapeHtml } from '../../lib/blog-utils.js';

// ==================== 编辑界面相关函数 ====================

// 是否有未保存修改（供新建/关闭/离开时确认）
function hasUnsavedChanges() {
    return state.dirtyTabs.size > 0;
}

function confirmDiscardChanges(action) {
    if (!hasUnsavedChanges()) return true;
    return confirm(`当前有 ${state.dirtyTabs.size} 个标签页存在未保存的修改，确定要${action}吗？未保存的内容将丢失。`);
}

// 文章所在的 blog 目录（相对 blog/，多级用 / 连接）
export function getBlogFolder(blog) {
    if (!blog) return '';
    if (blog.folder) return String(blog.folder).replace(/^blog\//, '').replace(/^\/+|\/+$/g, '');
    const path = String(blog.path || '').replace(/^blog\//, '').replace(/\.md$/i, '');
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
}

// 新增模式下直接创建一个分类（分类只用于首页卡片分组，不能包含 /）
export function createNewCategory() {
    const raw = prompt('请输入新分类名称（分类只用于首页卡片分组，不能包含 /）：');
    if (raw === null) return;

    const name = raw.trim();
    if (!name) return;
    if (name.includes('/') || name.includes('\\')) {
        alert('分类名称不能包含斜杠；如需多级目录，请填写“文件目录”');
        return;
    }
    if (name === '.' || name === '..') {
        alert('分类名称不合法');
        return;
    }
    if (/[<>:"|?*]/.test(name)) {
        alert('分类名称不能包含 < > : " | ? *');
        return;
    }

    const groupSelect = dom.editGroup;
    let option = Array.from(groupSelect.options).find(item => item.value === name);
    if (!option) {
        option = new Option(name, name);
        groupSelect.appendChild(option);
        showEditStatus(`已新建分类「${name}」，保存文章后生效`);
    }
    groupSelect.value = name;
    groupSelect.dispatchEvent(new Event('change', { bubbles: true }));
    groupSelect.focus();
}

// 打开新增模式：与编辑共用同一条标签页/表单/保存链路，且不丢弃已打开的文章
export async function openNewBlogMode() {
    const existingDraft = state.openTabs.find(tab => tab.isNew);
    if (existingDraft) {
        switchToTab(existingDraft.id);
        showEditContainer();
        await loadGroupsForEdit();
        document.getElementById('edit-group').value = existingDraft.blog.group || '';
        dom.editFolder.value = existingDraft.blog.folder || '';
        loadFoldersForEdit();
        if (!state.resourceTreeLoaded) await renderResourceTree();
        return;
    }

    const draftBlog = {
        uuid: generateTabId(),
        title: '',
        tags: [],
        group: '',
        folder: '',
        path: ''
    };
    await openFileInTab(draftBlog, true);
}

// 生成唯一标签ID
function generateTabId() {
    return 'tab-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// 切换编辑表单的"新增/编辑"外观
function setEditFormMode(isNew) {
    document.getElementById('edit-form-title').textContent = isNew ? '新增博客' : '编辑文章';
    document.getElementById('edit-group-group').style.display = isNew ? 'block' : 'none';
    document.getElementById('edit-folder-group').style.display = 'block';
    document.getElementById('edit-folder-label').textContent = isNew ? '文件目录' : '文件目录（保存路径，不可修改）';
    dom.editFolder.readOnly = !isNew;
    dom.editFolder.title = isNew ? '' : '已有文章的文件路径不可修改';
    document.getElementById('save-edit').textContent = isNew ? '确认新增' : '保存修改';
    updateCommitMessagePlaceholder();
}

function showEditContainer() {
    dom.containers.list.classList.add('container-hidden');
    dom.containers.list.classList.remove('container-active');
    dom.containers.show.classList.add('container-hidden');
    dom.containers.show.classList.remove('container-active');
    dom.containers.edit.classList.add('container-active');
    dom.containers.edit.classList.remove('container-hidden');
    document.querySelector('.sidebar-left').style.display = 'none';
}

// 打开文件到标签页（isNew = false 表示编辑已有博客）
export async function openFileInTab(blog, isNew = false) {
    setEditFormMode(isNew);

    const tabId = String(blog.uuid ?? blog.blog_uuid ?? blog.path ?? generateTabId());
    const existingTab = state.openTabs.find(t => t.id === tabId);

    if (existingTab) {
        snapshotActiveTab();
        state.activeTabId = tabId;
        renderTabs();
        switchToTab(tabId);
        showEditContainer();
        if (!state.resourceTreeLoaded) await renderResourceTree();
        return;
    }

    // 保存当前标签的编辑状态
    snapshotActiveTab();

    // 用副本，避免表单输入直接改到 allBlogs 里的对象
    const tabBlog = Object.assign({}, blog, {
        tags: Array.isArray(blog.tags) ? blog.tags.slice() : []
    });

    const newTab = {
        id: tabId,
        title: tabBlog.title || '(未命名)',
        blog: tabBlog,
        isNew,
        originalTitle: tabBlog.title || '',
        originalTags: (tabBlog.tags || []).slice(),
        commitMessage: ''
    };
    state.openTabs.push(newTab);

    let content = '';
    if (!isNew && blog.path) {
        const cached = state.blogContentCache.get(blog.path);
        if (typeof cached === 'string') {
            content = cached;
        } else {
            try {
                const res = await fetch(`${blog.path}?t=${Date.now()}`, { cache: 'no-store' });
                if (!res.ok) throw new Error(`加载失败: ${res.statusText}`);
                // 统一成 LF：textarea 会自动把 CRLF 归一为 LF，
                // 若保留原始 CRLF，脏检查会永远判定为“已修改”
                content = (await res.text()).replace(/\r\n?/g, '\n');
                state.blogContentCache.set(blog.path, content);
            } catch (err) {
                console.error('加载文件失败:', err);
                showEditStatus(`加载文件失败: ${err.message}`, true);
            }
        }
    }

    state.editedContents.set(tabId, content);
    state.originalContents.set(tabId, content);
    state.dirtyTabs.delete(tabId);

    state.activeTabId = tabId;
    state.currentEditFile = tabBlog;

    dom.editTitle.value = tabBlog.title || '';
    renderEditorTags(tabBlog.tags || []);
    dom.editTags.value = '';
    dom.editContent.value = content;
    dom.editHidden.checked = !!tabBlog.hidden;
    dom.editCommitMessage.value = '';
    updateCommitMessagePlaceholder();

    renderTabs();
    showEditContainer();

    // 新增与编辑统一在这里加载分组列表；新增时从空值开始选
    await loadGroupsForEdit();
    const groupSelect = document.getElementById('edit-group');
    groupSelect.value = isNew ? '' : (blog.group || '');

    // 分类与文件目录解耦：编辑已有文章时目录只读，新增时可自由填写多级目录
    dom.editFolder.value = isNew ? (tabBlog.folder || '') : getBlogFolder(tabBlog);
    loadFoldersForEdit();

    renderFileTree();
    if (!state.resourceTreeLoaded) await renderResourceTree();
}

// 解析标签输入框（兼容旧的逗号输入）
function parseTagsInput(value) {
    return String(value || '')
        .split(/[,，]/)
        .map(t => t.trim())
        .filter(Boolean);
}

// ==================== 标签编辑器（chip） ====================

function normalizeEditorTags(tags) {
    const seen = new Set();
    const list = [];
    (tags || []).forEach(raw => {
        const tag = String(raw || '').trim();
        if (!tag) return;
        const key = tag.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        list.push(tag);
    });
    return list;
}

function renderEditorTags(tags) {
    state.editorTags = normalizeEditorTags(tags);
    dom.tagChips.innerHTML = '';
    state.editorTags.forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.dataset.tag = tag;
        chip.innerHTML = `${escapeHtml(tag)}<span class="tag-chip-remove" title="删除标签">×</span>`;
        chip.querySelector('.tag-chip-remove').addEventListener('click', (e) => {
            e.stopPropagation();
            removeEditorTag(tag);
        });
        dom.tagChips.appendChild(chip);
    });
}

export function addEditorTag(raw) {
    const parts = parseTagsInput(raw);
    if (parts.length === 0) return false;
    let changed = false;
    parts.forEach(part => {
        if (!state.editorTags.some(t => t.toLowerCase() === part.toLowerCase())) {
            state.editorTags.push(part);
            changed = true;
        }
    });
    if (changed) {
        renderEditorTags(state.editorTags);
        if (state.activeTabId) snapshotActiveTab();
    }
    return changed;
}

export function removeEditorTag(tag) {
    const next = state.editorTags.filter(t => t !== tag);
    renderEditorTags(next);
    if (state.activeTabId) snapshotActiveTab();
}

// 读取当前标签（含输入框里还没按回车的部分）
export function getEditorTags() {
    const pending = parseTagsInput(dom.editTags.value);
    if (pending.length > 0) {
        renderEditorTags(state.editorTags.concat(pending));
        dom.editTags.value = '';
    }
    return state.editorTags.slice();
}

// ==================== 提交信息（commit message） ====================
// 默认提交信息：新增博客: <标题> / 更新博客: <标题>
function defaultCommitMessage(isNew, title) {
    const subject = String(title || '').trim() || '(未命名)';
    return `${isNew ? '新增博客' : '更新博客'}: ${subject}`;
}

// 占位符实时显示“本次保存实际会写入的默认提交信息”
export function updateCommitMessagePlaceholder() {
    if (!dom.editCommitMessage) return;
    const tab = state.openTabs.find(t => t.id === state.activeTabId);
    dom.editCommitMessage.placeholder = `留空则使用默认：${defaultCommitMessage(!!(tab && tab.isNew), dom.editTitle.value)}`;
}

// 实际写入 commit 的信息：自定义内容优先（压缩空白、去首尾空白），留空则用默认
export function resolveCommitMessage(isNew, title) {
    const custom = String(dom.editCommitMessage?.value || '').replace(/\s+/g, ' ').trim();
    return custom || defaultCommitMessage(isNew, title);
}

// 把当前表单内容写回标签状态，并更新脏标记
export function snapshotActiveTab() {
    if (!state.activeTabId) return;
    const tab = state.openTabs.find(t => t.id === state.activeTabId);
    if (!tab) return;

    state.editedContents.set(state.activeTabId, dom.editContent.value);
    tab.blog.title = dom.editTitle.value.trim();
    tab.blog.tags = getEditorTags();
    tab.blog.hidden = dom.editHidden.checked;
    // 自定义提交信息随标签页保存，切换标签后不丢；不计入脏标记
    tab.commitMessage = String(dom.editCommitMessage?.value || '').trim();
    if (tab.isNew) {
        const groupSelect = document.getElementById('edit-group');
        if (groupSelect) tab.blog.group = groupSelect.value;
        tab.blog.folder = dom.editFolder.value.trim();
    }
    tab.title = tab.blog.title || '(未命名)';
    updateDirtyState(state.activeTabId);
}

function isTabDirty(tabId) {
    const tab = state.openTabs.find(t => t.id === tabId);
    if (!tab) return false;

    const content = state.editedContents.get(tabId) ?? '';
    if (tab.isNew) {
        return content.trim() !== '' || (tab.blog.title || '') !== '' || (tab.blog.tags || []).length > 0
            || (tab.blog.group || '') !== '' || (tab.blog.folder || '') !== '';
    }

    const originalContent = state.originalContents.get(tabId) ?? '';
    const titleChanged = (tab.blog.title || '') !== (tab.originalTitle || '');
    const tagsChanged = (tab.blog.tags || []).join(',') !== (tab.originalTags || []).join(',');
    return content !== originalContent || titleChanged || tagsChanged;
}

function updateDirtyState(tabId) {
    const wasDirty = state.dirtyTabs.has(tabId);
    if (isTabDirty(tabId)) {
        state.dirtyTabs.add(tabId);
    } else {
        state.dirtyTabs.delete(tabId);
    }
    // 仅在脏状态变化时重绘标签，避免每次按键都重建
    if (wasDirty !== state.dirtyTabs.has(tabId)) renderTabs();
}

// 切换到指定标签
function switchToTab(tabId) {
    if (state.activeTabId && state.activeTabId !== tabId) snapshotActiveTab();

    const tab = state.openTabs.find(t => t.id === tabId);
    if (!tab) return;

    state.activeTabId = tabId;
    setEditFormMode(tab.isNew);

    dom.editTitle.value = tab.blog.title || '';
    renderEditorTags(tab.blog.tags || []);
    dom.editTags.value = '';
    dom.editContent.value = state.editedContents.get(tabId) ?? '';
    dom.editHidden.checked = !!tab.blog.hidden;
    dom.editCommitMessage.value = tab.commitMessage || '';
    updateCommitMessagePlaceholder();
    state.currentEditFile = tab.blog;

    if (tab.isNew) {
        loadGroupsForEdit().then(() => {
            const groupSelect = document.getElementById('edit-group');
            if (groupSelect && state.activeTabId === tabId) groupSelect.value = tab.blog.group || '';
        });
    }

    dom.editFolder.value = tab.isNew ? (tab.blog.folder || '') : getBlogFolder(tab.blog);
    loadFoldersForEdit();

    renderTabs();
    renderFileTree();
}

// 关闭标签
function closeTab(tabId, event) {
    if (event) event.stopPropagation();

    // 当前标签的内容先落回状态，再判断是否真的脏
    if (state.activeTabId === tabId) snapshotActiveTab();

    if (isTabDirty(tabId) && !confirm('当前文件有未保存的更改，确定要关闭吗？')) {
        return;
    }

    // 删除标签
    const index = state.openTabs.findIndex(t => t.id === tabId);
    if (index > -1) {
        state.openTabs.splice(index, 1);
        state.editedContents.delete(tabId);
        state.originalContents.delete(tabId);
        state.dirtyTabs.delete(tabId);
    }

    // 如果关闭的是当前标签，切换到另一个
    if (state.activeTabId === tabId) {
        if (state.openTabs.length > 0) {
            const newIndex = Math.min(index, state.openTabs.length - 1);
            switchToTab(state.openTabs[newIndex].id);
        } else {
            state.activeTabId = null;
            state.currentEditFile = null;
            dom.containers.edit.classList.add('container-hidden');
            dom.containers.edit.classList.remove('container-active');
            dom.containers.list.classList.add('container-active');
            dom.containers.list.classList.remove('container-hidden');
            // 回到列表时恢复左侧时间过滤器
            document.querySelector('.sidebar-left').style.display = 'block';
        }
    }

    renderTabs();
}

// 渲染标签页
export function renderTabs() {
    dom.editTabs.innerHTML = '';

    state.openTabs.forEach(tab => {
        const tabEl = document.createElement('div');
        const dirty = state.dirtyTabs.has(tab.id);
        tabEl.className = 'edit-tab' + (tab.id === state.activeTabId ? ' active' : '');
        tabEl.innerHTML = `
            <span class="edit-tab-title">${dirty ? '<span class="edit-tab-dirty">●</span>' : ''}${escapeHtml(tab.title)}</span>
            <span class="edit-tab-close" data-tab-id="${escapeHtml(tab.id)}">×</span>
        `;

        tabEl.addEventListener('click', () => switchToTab(tab.id));

        tabEl.querySelector('.edit-tab-close').addEventListener('click', (e) => {
            closeTab(tab.id, e);
        });

        // 右键菜单
        tabEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            // 这里可以添加标签页的右键菜单（固定、关闭等）
        });

        dom.editTabs.appendChild(tabEl);
    });
}

// 加载编辑界面的分类列表（分类只来自配置/文章，不包含 blog 目录）
async function loadGroupsForEdit() {
    try {
        let cfg = state.blogConfigData;
        if (!config) {
            const response = await fetch(`blog-config.json?t=${Date.now()}`, { cache: 'no-store' });
            if (!response.ok) return;
            cfg = await response.json();
            state.blogConfigData = cfg;
        }
        const groupSelect = document.getElementById('edit-group');
        const previous = groupSelect.value;
        groupSelect.innerHTML = '<option value="">请选择分类</option>';

        // 分类候选 = 配置文件里的分类 + 已加载文章的分类
        const blogs = cfg.blogs || cfg;
        const groups = new Set(Object.keys(blogs));
        state.allBlogs.forEach(blog => {
            if (blog.group) groups.add(blog.group);
        });
        // 新增草稿里刚创建、尚未保存的分类也要保留在下拉里
        state.openTabs.forEach(tab => {
            if (tab.isNew && tab.blog.group) groups.add(tab.blog.group);
        });

        Array.from(groups).sort((a, b) => a.localeCompare(b, 'zh')).forEach(group => {
            const option = document.createElement('option');
            option.value = group;
            option.textContent = group;
            groupSelect.appendChild(option);
        });

        if (previous && groups.has(previous)) groupSelect.value = previous;
    } catch (err) {
        console.error('加载分类失败:', err);
    }
}

// 加载“文件目录”候选：blog 下真实存在的多级目录 + 已有文章目录 + 草稿目录
export function loadFoldersForEdit() {
    if (!dom.editFolderList) return;
    const folders = new Set();
    (state.blogFolderPaths || []).forEach(path => {
        const relative = String(path || '').replace(/^blog\//, '').replace(/^\/+|\/+$/g, '');
        if (relative) folders.add(relative);
    });
    state.allBlogs.forEach(blog => {
        const folder = getBlogFolder(blog);
        if (folder) folders.add(folder);
    });
    state.openTabs.forEach(tab => {
        if (tab.isNew && tab.blog.folder) folders.add(tab.blog.folder);
    });

    dom.editFolderList.innerHTML = '';
    Array.from(folders).sort((a, b) => a.localeCompare(b, 'zh')).forEach(folder => {
        dom.editFolderList.appendChild(new Option(folder, folder));
    });
}


// 显示编辑状态
export function showEditStatus(msg, isError = false) {
    dom.editStatus.textContent = msg;
    dom.editStatus.className = isError ? 'status error' : 'status success';
}
