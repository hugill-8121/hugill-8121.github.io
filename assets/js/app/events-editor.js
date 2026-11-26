// 编辑表单与保存流程的事件绑定。

import { config, state } from './state.js';
import { dom } from './dom.js';
import { getGithubToken } from './utils.js';
import { renderBlogs, renderMonthList, renderTags } from './list.js';
import { buildBlogShowUrl } from './show.js';
import { addEditorTag, createNewCategory, getBlogFolder, getEditorTags, removeEditorTag, renderTabs, resolveCommitMessage, showEditStatus, snapshotActiveTab, updateCommitMessagePlaceholder } from './editor.js';
import { renderFileTree } from './file-tree.js';
import { applyCommittedResourceMoves, renderResourceTreeFromCache } from './resource-tree.js';
import { appendPendingResources, updatePendingResourceBadge } from './resource-queue.js';
import { CommitBatch, createOctokit, fetchBlogConfig } from '../github-api.js';
import { findBlogEntry, makeUuid, serializeBlogConfig, upsertBlogEntry } from '../blog-config.js';

export function bindEditorEvents() {
    // 编辑内容变化时实时更新未保存状态；标题变化时同步刷新默认提交信息的占位符
    [dom.editTitle, dom.editContent].forEach(el => {
        el.addEventListener('input', () => {
            if (state.activeTabId) snapshotActiveTab();
            if (el === dom.editTitle) updateCommitMessagePlaceholder();
        });
    });

    // 自定义提交信息只跟随标签页保存，不影响脏标记
    dom.editCommitMessage.addEventListener('input', () => {
        if (state.activeTabId) snapshotActiveTab();
    });

    // 标签编辑器：回车/逗号添加，退格删除最后一个，失焦时把残留文字也加入
    dom.editTags.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
            e.preventDefault();
            if (addEditorTag(dom.editTags.value)) dom.editTags.value = '';
            return;
        }
        if (e.key === 'Backspace' && dom.editTags.value === '' && state.editorTags.length > 0) {
            removeEditorTag(state.editorTags[state.editorTags.length - 1]);
        }
    });
    dom.editTags.addEventListener('blur', () => {
        if (addEditorTag(dom.editTags.value)) dom.editTags.value = '';
    });
    dom.tagEditor.addEventListener('click', (e) => {
        if (e.target === dom.tagEditor || e.target === dom.tagChips) dom.editTags.focus();
    });

    // 新增模式的分组选择也纳入未保存状态
    document.getElementById('edit-group').addEventListener('change', () => {
        if (state.activeTabId) snapshotActiveTab();
    });
    dom.editFolder.addEventListener('input', () => {
        if (state.activeTabId) snapshotActiveTab();
    });
    dom.newCategoryBtn.addEventListener('click', createNewCategory);

    // 保存编辑事件（新增/编辑：一次提交同时写入 md 与 blog-config.json）
    dom.saveEdit.addEventListener('click', async () => {
        const token = getGithubToken();
        if (!token) {
            showEditStatus('请先登录', true);
            return;
        }
        if (!state.activeTabId) {
            showEditStatus('没有打开的文章', true);
            return;
        }

        const tab = state.openTabs.find(t => t.id === state.activeTabId);
        if (!tab) {
            showEditStatus('没有打开的文章', true);
            return;
        }

        // 把表单内容写回标签状态
        snapshotActiveTab();

        const title = dom.editTitle.value.trim();
        const tags = getEditorTags();
        const content = dom.editContent.value;
        const isNew = tab.isNew;

        if (!title) {
            showEditStatus('标题不能为空', true);
            return;
        }
        if (title.includes('/') || title.includes('\\')) {
            showEditStatus('标题不能包含斜杠', true);
            return;
        }

        let group = '';
        let folder = '';
        if (isNew) {
            group = dom.editGroup.value.trim();
            if (!group) {
                showEditStatus('请选择分类', true);
                return;
            }
            // 分类只用于首页卡片分组，必须是单层的纯标识，不能带 /
            if (group.includes('/') || group.includes('\\')) {
                showEditStatus('分类名称不能包含斜杠；多级目录请填写“文件目录”', true);
                return;
            }

            // 文件目录独立于分类，允许多级
            folder = dom.editFolder.value.trim().replace(/^\/+|\/+$/g, '');
            if (folder.toLowerCase().startsWith('blog/')) folder = folder.slice(5);
            if (!folder) folder = group;
            if (/[\\<>:"|?*]/.test(folder) || folder.split('/').some(part => !part || part === '.' || part === '..')) {
                showEditStatus('文件目录不合法（不能含 \\ < > : " | ? *，也不能有空段）', true);
                return;
            }
        }

        const filePath = isNew
            ? `blog/${folder}/${title}.md`
            : (tab.blog.path || '');
        if (!filePath) {
            showEditStatus('找不到文件路径', true);
            return;
        }

        // 新增时防止覆盖同目录下已有文章（与编辑的“打开已有文件”保持同一套路径规则）
        if (isNew) {
            const pathExists = state.allBlogs.some(blog => blog.path === filePath)
                || (state.repoTreeState.items || []).some(item => item.type === 'file' && item.path === filePath);
            if (pathExists) {
                showEditStatus('该目录下已存在同名文章，请修改标题或文件目录', true);
                return;
            }
        }

        dom.saveEdit.disabled = true;

        // 保存过程有多轮网络等待，等成功了再 window.open 会因“用户激活”过期被浏览器拦截，
        // 所以先同步开一个空白标签页占位，提交成功后再把地址换成文章详情
        const showWindow = window.open('', '_blank');
        if (showWindow) {
            try {
                showWindow.document.write('<!doctype html><title>正在保存…</title>'
                    + '<body style="font-family:system-ui,sans-serif;padding:24px;color:#444">'
                    + '正在提交文章，保存完成后这里会显示最新内容…</body>');
                showWindow.document.close();
            } catch (err) {
                console.warn('占位标签页初始化失败:', err);
            }
        }

        try {
            showEditStatus('保存中...');
            const octokit = createOctokit(token);
            const repoInfo = { owner: config.owner, repo: config.repo, branch: config.branch };

            // 1. 读取远端配置（UTF-8 安全解码）
            const remote = await fetchBlogConfig(octokit, repoInfo);

            // 2. 计算新的配置记录
            const uuid = isNew
                ? makeUuid()
                : (tab.blog.blog_uuid ?? tab.blog.uuid ?? '');
            const existing = findBlogEntry(remote.config, { uuid, path: filePath });
            const targetGroup = isNew
                ? group
                : ((existing && existing.group) || tab.blog.group || state.currentEditFile?.group || '');

            if (!isNew && !targetGroup) {
                throw new Error('blog-config.json 中找不到该文章的分类，请检查配置');
            }

            const updated = upsertBlogEntry(remote.config, {
                group: targetGroup,
                title,
                tags,
                path: filePath,
                uuid,
                hidden: dom.editHidden.checked,
                mode: isNew ? 'create' : 'update'
            });
            const configText = serializeBlogConfig(updated.config);

            // 3. 一次原子提交：md + blog-config.json + 待提交资源
            const batch = new CommitBatch({
                octokit,
                owner: config.owner,
                repo: config.repo,
                branch: config.branch
            });
            batch.add(filePath, content);
            batch.add('blog-config.json', configText);
            const resourceCount = await appendPendingResources(batch);

            // 提交信息：表单里填了就用填写的，留空用默认
            const commitMessage = resolveCommitMessage(isNew, title);
            const commitResult = await batch.commit(commitMessage);
            if (!commitResult.success) {
                throw new Error(commitResult.error);
            }

            // 4. 提交成功后同步本地状态
            state.blogConfigData = updated.config;
            tab.isNew = false;
            tab.blog.title = title;
            tab.blog.tags = tags.slice();
            tab.blog.path = filePath;
            tab.blog.hidden = dom.editHidden.checked;
            tab.blog.folder = folder || getBlogFolder({ path: filePath });
            tab.blog.blog_uuid = uuid;
            tab.blog.uuid = uuid;
            tab.blog.group = updated.group;
            tab.title = title;
            tab.originalTitle = title;
            tab.originalTags = tags.slice();
            // 自定义提交信息已随本次提交用掉，下次保存回到默认
            tab.commitMessage = '';
            dom.editCommitMessage.value = '';
            updateCommitMessagePlaceholder();

            // 草稿标签的 id 是临时的，保存后用真实 uuid 作为标签 id，避免重开同一篇时出现重复标签
            if (tab.id !== uuid) {
                state.editedContents.delete(tab.id);
                state.originalContents.delete(tab.id);
                state.dirtyTabs.delete(tab.id);
                tab.id = uuid;
                state.activeTabId = uuid;
            }
            state.editedContents.set(uuid, content);
            state.originalContents.set(uuid, content);
            state.dirtyTabs.delete(uuid);
            state.currentEditFile = tab.blog;
            state.blogContentCache.set(filePath, content);

            const committedResourceFiles = Array.from(state.pendingResourceFiles.keys());
            const committedResourceFolders = Array.from(state.pendingResourceFolders.keys());
            const committedResourceMoves = Array.from(state.pendingResourceMoves.entries());
            state.pendingResourceFiles.clear();
            state.pendingResourceFolders.clear();
            state.pendingResourceMoves.clear();
            state.pendingResourceDeletes.clear();
            applyCommittedResourceMoves(committedResourceMoves);
            updatePendingResourceBadge();

            renderTabs();

            // 5. 只刷新编辑器本地状态，不再跳到详情页（详情在新标签页打开）；
            //    blog-config.json / md 不重新拉，避免 GitHub Pages 缓存把界面停在旧内容上。
            const blogObj = state.allBlogs.find(b => String(b.blog_uuid) === String(uuid) || b.path === filePath);
            const mergedBlog = blogObj || {};
            Object.assign(mergedBlog, {
                blog_uuid: uuid,
                uuid,
                title,
                description: updated.entry.description || title,
                path: filePath,
                filePath,
                folder: folder || getBlogFolder({ path: filePath }),
                tags: tags.slice(),
                group: updated.group,
                hidden: dom.editHidden.checked
            });
            if (!blogObj) state.allBlogs.push(mergedBlog);

            mergedBlog.lastModified = new Date();
            mergedBlog.committer = dom.usernameDisplay.textContent.trim() || '我';
            mergedBlog.commitMessage = commitMessage;
            state.currentBlog = mergedBlog;

            state.allTags.clear();
            state.allBlogs.forEach(b => { if (!b.hidden) (b.tags || []).forEach(t => state.allTags.add(t)); });

            // 同步仓库树缓存，资源栏/文件树无需再打 API
            if (state.repoTreeState.items) {
                const addItem = (path, type) => {
                    if (!state.repoTreeState.items.some(item => item.path === path)) {
                        state.repoTreeState.items.push({ path, type, size: 0 });
                    }
                };
                addItem(filePath, 'file');
                addItem('blog-config.json', 'file');
                const parts = filePath.split('/');
                for (let i = 2; i < parts.length; i++) {
                    addItem(parts.slice(0, i).join('/'), 'folder');
                }
                committedResourceFiles.forEach(path => addItem(path, 'file'));
                committedResourceFolders.forEach(path => addItem(path, 'folder'));
                state.blogFolderPaths = state.repoTreeState.items
                    .filter(item => item.type === 'folder' && item.path.startsWith('blog/'))
                    .map(item => item.path);
            } else {
                const parts = filePath.split('/');
                for (let i = 2; i < parts.length; i++) {
                    const folderPath = parts.slice(0, i).join('/');
                    if (!state.blogFolderPaths.includes(folderPath)) state.blogFolderPaths.push(folderPath);
                }
            }
            committedResourceFiles.forEach(path => {
                if (!state.resourceRemotePaths.some(item => item.path === path)) {
                    state.resourceRemotePaths.push({ path, type: 'file', size: 0 });
                }
            });
            committedResourceFolders.forEach(path => {
                if (!state.resourceRemotePaths.some(item => item.path === path)) {
                    state.resourceRemotePaths.push({ path, type: 'folder', size: 0 });
                }
            });

            renderTags();
            renderMonthList();
            renderBlogs();

            // 详情放到浏览器新标签页打开，编辑页保持原样：
            // 传 fresh=1，新标签页直接用 GitHub API 读刚提交的正文，不受 Pages 构建延迟影响
            const showUrl = buildBlogShowUrl({
                uuid,
                path: filePath,
                title,
                tags: tags.slice(),
                fresh: true
            });
            if (showWindow && !showWindow.closed) {
                showWindow.location.replace(showUrl);
                showEditStatus(resourceCount > 0
                    ? `保存成功，已在新标签页打开文章（同时提交了 ${resourceCount} 个资源文件）`
                    : '保存成功，已在新标签页打开文章');
            } else {
                showEditStatus('保存成功，但新标签页被浏览器拦截；可点开文章列表里的这篇文章查看最新内容');
            }
            renderFileTree();
            renderResourceTreeFromCache();
        } catch (error) {
            console.error('保存失败:', error);
            if (showWindow && !showWindow.closed) {
                try {
                    showWindow.close();
                } catch (err) {
                    console.warn('关闭占位标签页失败:', err);
                }
            }
            showEditStatus(`保存失败: ${error.message}`, true);
        } finally {
            dom.saveEdit.disabled = false;
        }
    });
}
