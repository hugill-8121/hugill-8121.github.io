// 资源栏队列：上传/新建目录/删除只登记，点“提交资源”或保存文章时一次提交。

import { config, state } from './state.js';
import { dom } from './dom.js';
import { getGithubToken } from './utils.js';
import { renderBlogs, renderMonthList, renderTags } from './list.js';
import { renderFileTree } from './file-tree.js';
import { RESOURCE_ROOT } from './repo-tree.js';
import { applyCommittedResourceMoves, findPendingResourceMove, isResourcePathTaken, renderResourceTreeFromCache } from './resource-tree.js';
import { CommitBatch, createOctokit, fetchBlogConfig } from '../github-api.js';
import { findBlogEntry, serializeBlogConfig } from '../blog-config.js';

export function refreshResourceUploadFolders() {
    const select = dom.resourceUploadFolder;
    if (!select) return;

    const folders = new Set([RESOURCE_ROOT]);
    const addFolder = path => {
        if (path && (path === RESOURCE_ROOT || path.startsWith(RESOURCE_ROOT + '/'))) folders.add(path);
    };

    state.resourceRemotePaths.forEach(item => {
        if (item.type === 'folder') {
            addFolder(item.path);
        } else {
            // 兜底：从文件路径反推父目录（远端树偶尔没有显式 folder 项）
            const parts = String(item.path || '').split('/').filter(Boolean);
            for (let i = 1; i < parts.length; i++) {
                addFolder(parts.slice(0, i).join('/'));
            }
        }
    });
    state.pendingResourceFolders.forEach((meta, path) => addFolder(path));

    const sorted = Array.from(folders).sort((a, b) => {
        if (a === RESOURCE_ROOT) return -1;
        if (b === RESOURCE_ROOT) return 1;
        return a.localeCompare(b, 'zh');
    });

    const desired = state.resourceUploadTarget || select.value || RESOURCE_ROOT;
    select.innerHTML = '';
    sorted.forEach(path => {
        const label = path === RESOURCE_ROOT ? `${RESOURCE_ROOT}（根目录）` : path;
        select.appendChild(new Option(label, path));
    });

    state.resourceUploadTarget = sorted.includes(desired) ? desired : RESOURCE_ROOT;
    select.value = state.resourceUploadTarget;
    updateResourceUploadHint();
}

export function updateResourceUploadHint() {
    if (!dom.resourceUploadHint) return;
    const target = dom.resourceUploadFolder.value || RESOURCE_ROOT;
    dom.resourceUploadHint.textContent = target === RESOURCE_ROOT
        ? `目标：${RESOURCE_ROOT}（根目录）`
        : `目标：${target}`;
}

export function openResourceUploadModal() {
    if (!getGithubToken()) {
        alert('请先登录后再上传资源');
        return;
    }
    refreshResourceUploadFolders();
    dom.resourceUploadFolder.value = state.resourceUploadTarget;
    updateResourceUploadHint();
    dom.resourceUploadModal.style.display = 'flex';
}

export function closeResourceUploadModal() {
    if (dom.resourceUploadModal) dom.resourceUploadModal.style.display = 'none';
}

function encodeRepoPathLocal(path) {
    return String(path || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

export function rawResourceUrl(path) {
    return `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.branch}/${encodeRepoPathLocal(path)}`;
}

// 获取文件图标
export function getFileIcon(filename) {
    const ext = String(filename || '').split('.').pop().toLowerCase();
    const iconMap = {
        png: 'fa-file-image-o', jpg: 'fa-file-image-o', jpeg: 'fa-file-image-o',
        gif: 'fa-file-image-o', svg: 'fa-file-image-o', webp: 'fa-file-image-o',
        pdf: 'fa-file-pdf-o', mp4: 'fa-file-video-o', mov: 'fa-file-video-o',
        mp3: 'fa-file-audio-o', wav: 'fa-file-audio-o',
        zip: 'fa-file-zip-o', rar: 'fa-file-zip-o', gz: 'fa-file-archive-o',
        txt: 'fa-file-text-o', md: 'fa-file-text-o',
        js: 'fa-file-code-o', ts: 'fa-file-code-o', json: 'fa-file-code-o',
        html: 'fa-file-code-o', css: 'fa-file-code-o', py: 'fa-file-code-o'
    };
    return iconMap[ext] || 'fa-file-o';
}

export function pendingResourceCount() {
    return state.pendingResourceFiles.size + state.pendingResourceFolders.size + state.pendingResourceMoves.size + state.pendingResourceDeletes.size;
}

export function updatePendingResourceBadge() {
    if (!dom.resourceCommitBtn) return;
    const count = pendingResourceCount();
    dom.pendingResourceCount.textContent = count;
    dom.resourceCommitBtn.disabled = count === 0;
}

export function updateVisibilityCommitBadge() {
    if (!dom.visibilityCommitBtn) return;
    const count = state.pendingVisibility.size;
    dom.pendingVisibilityCount.textContent = count;
    dom.visibilityCommitBtn.disabled = count === 0;
}

// 批量提交文件栏勾选的显示状态变更，一次性写回 blog-config.json
export async function commitPendingVisibility() {
    if (state.pendingVisibility.size === 0) return { success: true };

    const token = getGithubToken();
    if (!token) {
        alert('请先登录');
        return { success: false, error: '未登录' };
    }

    const octokit = createOctokit(token);
    const repoInfo = { owner: config.owner, repo: config.repo, branch: config.branch };
    const pending = Array.from(state.pendingVisibility.entries());

    dom.visibilityCommitBtn.disabled = true;
    dom.visibilityCommitBtn.textContent = '提交中...';

    try {
        const remote = await fetchBlogConfig(octokit, repoInfo);

        // 逐条按路径/uuid 定位配置条目，只改 hidden，保留其余字段
        pending.forEach(([path, hidden]) => {
            const local = state.allBlogs.find(b => b.path === path);
            const uuid = local ? (local.blog_uuid ?? local.uuid) : undefined;
            // 先按路径定位（最稳），路径缺失时再按 uuid 兜底
            let found = findBlogEntry(remote.config, { path });
            if (!found && uuid) found = findBlogEntry(remote.config, { uuid });
            if (!found) throw new Error(`配置中找不到文章：${path}`);
            found.entry.hidden = !!hidden;
        });

        const configText = serializeBlogConfig(remote.config);
        const batch = new CommitBatch({
            octokit,
            owner: config.owner,
            repo: config.repo,
            branch: config.branch
        });
        batch.add('blog-config.json', configText);

        const result = await batch.commit(`更新文章显示状态: ${pending.length} 篇`);
        if (!result.success) throw new Error(result.error);

        // 同步本地状态
        state.blogConfigData = remote.config;
        pending.forEach(([path, hidden]) => {
            const blog = state.allBlogs.find(b => b.path === path);
            if (blog) blog.hidden = !!hidden;
            if (state.currentEditFile && state.currentEditFile.path === path) {
                state.currentEditFile.hidden = !!hidden;
                if (dom.editHidden) dom.editHidden.checked = !!hidden;
            }
        });
        state.pendingVisibility.clear();

        state.allTags.clear();
        state.allBlogs.forEach(b => { if (!b.hidden) (b.tags || []).forEach(t => state.allTags.add(t)); });

        renderFileTree();
        renderTags();
        renderMonthList();
        renderBlogs();
        alert(`显示状态已提交（${pending.length} 篇）`);
        return { success: true };
    } catch (error) {
        console.error('提交显示状态失败:', error);
        alert(`提交显示状态失败: ${error.message || error}`);
        return { success: false, error: error.message };
    } finally {
        dom.visibilityCommitBtn.innerHTML =
            `<i class="fa fa-eye-slash"></i> 提交显示状态 (<span id="pending-visibility-count">0</span>)`;
        dom.pendingVisibilityCount = document.getElementById('pending-visibility-count');
        updateVisibilityCommitBadge();
    }
}

// 选择并上传资源文件（可多选）
export function pickResourceFiles(folderPath = RESOURCE_ROOT) {
    if (!getGithubToken()) {
        alert('请先登录后再上传资源');
        return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,.md,.txt,.json,.pdf,.zip';
    input.onchange = async (event) => {
        const files = Array.from(event.target.files || []);
        for (const file of files) {
            await queueResourceFile(file, folderPath);
        }
    };
    input.click();
}

// 读取文件为 Base64（去掉 data URL 前缀）
function readFileAsBase64(file) {
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

// 加入待提交队列（真正提交由“提交资源”按钮或保存文章时触发）
async function queueResourceFile(file, folderPath) {
    if (!getGithubToken()) {
        alert('请先登录');
        return;
    }

    const filePath = `${folderPath}/${file.name}`;
    try {
        if (file.size > 5 * 1024 * 1024) {
            const ok = confirm(`文件较大（${(file.size / 1024 / 1024).toFixed(1)}MB），提交可能较慢，继续吗？`);
            if (!ok) return;
        }
        const exists = state.resourceRemotePaths.some(item => item.path === filePath)
            || state.pendingResourceFiles.has(filePath)
            || isResourcePathTaken(filePath, '');
        if (exists && !confirm(`资源已存在：${filePath}，要覆盖吗？`)) return;

        const content = await readFileAsBase64(file);
        state.pendingResourceFiles.set(filePath, { name: file.name, content, folderPath });
        renderResourceTreeFromCache();
    } catch (error) {
        console.error('读取资源文件失败:', error);
        alert(`读取文件失败: ${error.message}`);
    }
}

// 在资源目录下新建文件夹（支持多级，如 images/2026）
export function queueResourceFolder(parentPath, rawName) {
    const name = String(rawName || '').trim().replace(/^\/+|\/+$/g, '');
    if (!name) return;
    if (/[\\<>:"|?*]/.test(name)) {
        alert('文件夹名不能包含 \\ < > : " | ? *');
        return;
    }

    const segments = name.split('/').map(s => s.trim()).filter(Boolean);
    if (segments.length === 0 || segments.some(s => s === '.' || s === '..')) {
        alert('文件夹名不合法');
        return;
    }

    let cursor = parentPath;
    for (let i = 0; i < segments.length; i++) {
        cursor = `${cursor}/${segments[i]}`;
        const isLast = i === segments.length - 1;
        const remoteExists = state.resourceRemotePaths.some(item => item.path === cursor);
        const pendingExists = state.pendingResourceFolders.has(cursor);

        if ((remoteExists || pendingExists) && isLast) {
            alert(remoteExists ? '该文件夹已存在' : '该文件夹已在待提交队列中');
            return;
        }
        if (remoteExists || pendingExists) continue;
        state.pendingResourceFolders.set(cursor, { name: segments[i] });
    }
    // 新建完成后把上传目标切到该文件夹，方便直接往里传
    state.resourceUploadTarget = cursor;
    renderResourceTreeFromCache();
}

// 删除资源文件：远端文件登记到待提交删除队列，待提交的只移除队列
export function deleteResourceFile(filePath, isPending) {
    const name = filePath.split('/').pop();

    // 已在待提交删除队列：不重复登记
    if (state.pendingResourceDeletes.has(filePath)) return;

    // 已经登记了移动/重命名但还没提交：先撤销这次修改，再按远端文件登记删除
    const pendingMove = findPendingResourceMove(filePath);
    if (pendingMove && !state.pendingResourceFiles.has(filePath)) {
        if (!confirm(`文件 ${pendingMove.move.path} 还在待提交的修改队列里，确定撤销这次修改并删除它吗？`)) return;
        state.pendingResourceMoves.delete(pendingMove.fromPath);
    }

    // 还没上传的本地文件：直接从上传队列移除，不进删除队列
    if (isPending || state.pendingResourceFiles.has(filePath)) {
        if (!confirm(`确定从待提交队列移除资源文件 ${filePath} 吗？`)) return;
        state.pendingResourceFiles.delete(filePath);
        renderResourceTreeFromCache();
        return;
    }

    if (!getGithubToken()) {
        alert('请先登录');
        return;
    }
    if (!confirm(`确定删除资源文件 ${filePath} 吗？将在点“提交资源”后统一提交删除。`)) return;

    const meta = state.resourceRemotePaths.find(item => item.type === 'file' && item.path === filePath) || {};
    state.pendingResourceDeletes.set(filePath, { name, size: meta.size || 0, sha: meta.sha || '' });
    // 本地视图先移除，条目保留到提交成功后再清缓存
    state.resourceRemotePaths = state.resourceRemotePaths.filter(item => item.path !== filePath);
    if (state.repoTreeState.items) {
        state.repoTreeState.items = state.repoTreeState.items.filter(item => item.path !== filePath);
    }
    renderResourceTreeFromCache();
}

// 删除资源文件夹：其内远端文件登记到待提交删除队列，随“提交资源”一次提交
export function deleteResourceFolder(folderPath) {
    if (!getGithubToken()) {
        alert('请先登录');
        return;
    }

    const remoteFiles = state.resourceRemotePaths
        .filter(item => item.type === 'file' && item.path.startsWith(folderPath + '/'))
        .map(item => item.path);
    const pendingFiles = Array.from(state.pendingResourceFiles.keys())
        .filter(path => path.startsWith(folderPath + '/'));
    const pendingFolders = Array.from(state.pendingResourceFolders.keys())
        .filter(path => path === folderPath || path.startsWith(folderPath + '/'));
    // 文件夹内还有待提交的移动/改名：一并撤销（原文件要么被删除，要么留在原地）
    const pendingMoves = Array.from(state.pendingResourceMoves.entries())
        .filter(([fromPath, move]) => fromPath.startsWith(folderPath + '/') || move.path.startsWith(folderPath + '/'));

    if (remoteFiles.length === 0 && pendingFiles.length === 0 && pendingFolders.length === 0
        && pendingMoves.length === 0) {
        // 只是空文件夹，移除前同样确认
        if (!confirm(`确定移除空文件夹 ${folderPath} 吗？`)) return;
        state.pendingResourceFolders.delete(folderPath);
        renderResourceTreeFromCache();
        return;
    }

    const ok = confirm(`确定删除文件夹 ${folderPath} 吗？\n其中 ${remoteFiles.length} 个文件将在提交资源后统一删除，${pendingFiles.length} 个待提交文件会被丢弃。`);
    if (!ok) return;

    // 远端文件登记到待提交删除队列，随“提交资源”一次提交
    remoteFiles.forEach(path => {
        const meta = state.resourceRemotePaths.find(item => item.path === path) || {};
        state.pendingResourceDeletes.set(path, {
            name: path.split('/').pop(),
            size: meta.size || 0,
            sha: meta.sha || ''
        });
    });

    pendingFiles.forEach(path => state.pendingResourceFiles.delete(path));
    pendingFolders.forEach(path => state.pendingResourceFolders.delete(path));
    pendingMoves.forEach(([fromPath]) => state.pendingResourceMoves.delete(fromPath));
    state.resourceRemotePaths = state.resourceRemotePaths.filter(item => !item.path.startsWith(folderPath + '/'));
    if (state.repoTreeState.items) {
        state.repoTreeState.items = state.repoTreeState.items.filter(item => !item.path.startsWith(folderPath + '/'));
    }
    renderResourceTreeFromCache();
}

// 把待提交资源追加进一个批次（“提交资源”或保存文章时一起提交）
export async function appendPendingResources(batch) {
    let count = 0;
    state.pendingResourceFiles.forEach((meta, path) => {
        batch.addBinary(path, meta.content);
        count += 1;
    });
    // 移动/重命名：新路径直接引用原 blob sha，不重传内容
    for (const [fromPath, move] of state.pendingResourceMoves) {
        if (!move.path || move.path === fromPath) continue;
        if (move.sha) {
            batch.moveRef(fromPath, move.path, move.sha);
        } else {
            // 老缓存里可能没有 blob sha，退回“读内容再写入”
            await batch.rename(fromPath, move.path);
        }
        count += 1;
    }
    // 待提交删除：批次里标记删除
    for (const [path] of state.pendingResourceDeletes) {
        batch.delete(path);
        count += 1;
    }
    state.pendingResourceFolders.forEach((meta, path) => {
        const hasContent = Array.from(state.pendingResourceFiles.keys()).some(p => p.startsWith(path + '/'))
            || Array.from(state.pendingResourceMoves.values()).some(move => move.path.startsWith(path + '/'))
            || state.resourceRemotePaths.some(item => item.path.startsWith(path + '/'));
        if (!hasContent) {
            // Git 不能存空目录，用 .gitkeep 占位
            batch.add(`${path}/.gitkeep`, '');
        }
    });
    return count;
}

export async function commitPendingResources() {
    if (pendingResourceCount() === 0) return { success: true };

    const token = getGithubToken();
    if (!token) {
        alert('请先登录');
        return { success: false, error: '未登录' };
    }

    const octokit = createOctokit(token);
    const batch = new CommitBatch({
        octokit,
        owner: config.owner,
        repo: config.repo,
        branch: config.branch
    });

    const fileCount = await appendPendingResources(batch);
    const committedFiles = Array.from(state.pendingResourceFiles.keys());
    const committedFolders = Array.from(state.pendingResourceFolders.keys());
    const committedMoves = Array.from(state.pendingResourceMoves.entries());
    dom.resourceCommitBtn.disabled = true;
    dom.resourceCommitBtn.textContent = '提交中...';

    try {
        const result = await batch.commit(`提交资源: ${fileCount} 个文件`);
        if (!result.success) throw new Error(result.error);
        state.pendingResourceFiles.clear();
        state.pendingResourceFolders.clear();
        state.pendingResourceMoves.clear();
        state.pendingResourceDeletes.clear();

        // 只更新本地缓存，不再为刚提交的文件重新拉一次树
        committedFiles.forEach(path => {
            if (!state.resourceRemotePaths.some(item => item.path === path)) {
                state.resourceRemotePaths.push({ path, type: 'file', size: 0 });
            }
            if (state.repoTreeState.items && !state.repoTreeState.items.some(item => item.path === path)) {
                state.repoTreeState.items.push({ path, type: 'file', size: 0 });
            }
        });
        committedFolders.forEach(path => {
            if (!state.resourceRemotePaths.some(item => item.path === path)) {
                state.resourceRemotePaths.push({ path, type: 'folder', size: 0 });
            }
        });
        applyCommittedResourceMoves(committedMoves);
        renderResourceTreeFromCache();
        alert(`资源已提交（${fileCount} 个文件）`);
        return result;
    } catch (error) {
        console.error('提交资源失败:', error);
        alert(`提交资源失败: ${error.message}`);
        return { success: false, error: error.message };
    } finally {
        dom.resourceCommitBtn.innerHTML =
            `<i class="fa fa-cloud-upload"></i> 提交资源 (<span id="pending-resource-count">0</span>)`;
        dom.pendingResourceCount = document.getElementById('pending-resource-count');
        updatePendingResourceBadge();
    }
}
