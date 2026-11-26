// 资源栏视图：树渲染、展开折叠、拖拽移动/重命名、右键菜单、搜索过滤。

import { state } from '../core/state.js';
import { dom } from '../core/dom.js';
import { getGithubToken, showToast } from '../core/utils.js';
import { renderFileTree } from './file-tree.js';
import { RESOURCE_ROOT, buildResourceTree, loadResourcePaths } from '../data/repo-tree.js';
import { deleteResourceFile, deleteResourceFolder, getFileIcon, pendingResourceCount, pickResourceFiles, queueResourceFolder, rawResourceUrl, refreshResourceUploadFolders, updatePendingResourceBadge } from '../data/resource-queue.js';
import { escapeHtml } from '../../lib/blog-utils.js';

// ==================== 资源文件拖拽移动 / 重命名 ====================
// 拖动资源树里的文件到另一个文件夹、或右键重命名，都只是“登记待提交”，
// 不产生提交；统一在点“提交资源”（或保存文章）时和其它资源一起提交一次。

function resourceParentOf(path) {
    const index = String(path || '').lastIndexOf('/');
    return index > -1 ? path.substring(0, index) : '';
}

// 文件在界面上展示的路径（可能已经被拖走/改名，但还没提交）
function resourceVirtualPath(path) {
    const move = state.pendingResourceMoves.get(path);
    return move ? move.path : path;
}

// 找某条待提交的移动：path 可能是原路径，也可能是移动后的目标路径
export function findPendingResourceMove(path) {
    if (!path) return null;
    if (state.pendingResourceMoves.has(path)) return { fromPath: path, move: state.pendingResourceMoves.get(path) };
    for (const [fromPath, move] of state.pendingResourceMoves) {
        if (move.path === path) return { fromPath, move };
    }
    return null;
}

// 目标路径是否已被别的文件占用（远端 / 待上传 / 已排队的移动）
export function isResourcePathTaken(targetPath, ignorePath) {
    if (!targetPath) return false;
    if (state.pendingResourceFiles.has(targetPath)) return true;
    // 已排队待删除的路径视为空闲，可重新上传/移入
    if (state.pendingResourceDeletes.has(targetPath)) return false;
    const remoteTaken = state.resourceRemotePaths.some(item =>
        item.type === 'file' && item.path === targetPath && item.path !== ignorePath);
    if (remoteTaken) return true;
    for (const [fromPath, move] of state.pendingResourceMoves) {
        if (move.path === targetPath && fromPath !== ignorePath) return true;
    }
    return false;
}

// 目标目录必须是资源目录本身或它的子目录；移动到原目录视为无效
export function isResourceMoveTargetAllowed(fromPath, targetFolder) {
    if (!fromPath) return false;
    const folder = targetFolder || RESOURCE_ROOT;
    if (folder !== RESOURCE_ROOT && !folder.startsWith(RESOURCE_ROOT + '/')) return false;
    const currentPath = resourceVirtualPath(fromPath);
    return `${folder}/${currentPath.split('/').pop()}` !== currentPath;
}

function clearResourceDragHover() {
    dom.resourceTree.querySelectorAll('.drop-hover, .dragging').forEach(el => {
        el.classList.remove('drop-hover', 'dragging');
    });
    dom.resourceTree.classList.remove('drop-hover');
}

function startResourceDrag(e, file, el) {
    state.resourceDragState = { path: file.fromPath || file.path, pending: !!file.pending, moved: !!file.moved };
    el.classList.add('dragging');
    if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        // 用自定义 MIME，避免拖到编辑器里时被当成文本粘贴
        e.dataTransfer.setData('application/x-blog-resource', file.path);
        e.dataTransfer.setData('text/plain', file.path);
    }
}

export function endResourceDrag() {
    state.resourceDragState = null;
    clearResourceDragHover();
}

function handleResourceFolderDragOver(e, el, folderPath) {
    if (!state.resourceDragState) return;
    if (!isResourceMoveTargetAllowed(state.resourceDragState.path, folderPath)) {
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'not-allowed';
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-hover');
}

function handleResourceFolderDragLeave(e, el) {
    if (el.contains(e.relatedTarget)) return;
    el.classList.remove('drop-hover');
}

function handleResourceFolderDrop(e, el, folderPath) {
    if (!state.resourceDragState) return;
    e.preventDefault();
    e.stopPropagation();
    const dragged = state.state.resourceDragState;
    endResourceDrag();
    moveResourceFile(dragged.path, folderPath);
}

// 移动到目标目录（拖拽用）：只登记待提交
export function moveResourceFile(fromPath, targetFolderPath) {
    const targetFolder = String(targetFolderPath || RESOURCE_ROOT).replace(/\/+$/, '') || RESOURCE_ROOT;
    if (!fromPath) return;
    if (targetFolder !== RESOURCE_ROOT && !targetFolder.startsWith(RESOURCE_ROOT + '/')) {
        showToast('只能移动到资源目录内', true);
        return;
    }
    const currentPath = resourceVirtualPath(fromPath);
    const name = String(currentPath || '').split('/').pop();
    const targetPath = `${targetFolder}/${name}`;
    if (targetPath === currentPath) {
        showToast('文件已在该目录下');
        return;
    }
    relocateResourceFile(fromPath, targetPath);
}

// 登记一次移动/重命名（拖拽与右键重命名共用），真正提交在“提交资源”时
function relocateResourceFile(fromPath, targetPath) {
    const existing = findPendingResourceMove(fromPath);
    const originalPath = existing ? existing.fromPath : fromPath;
    const currentPath = existing ? existing.move.path : fromPath;
    const name = String(targetPath || '').split('/').pop();
    const targetFolder = resourceParentOf(targetPath);

    if (!fromPath || !name) return;
    if (targetPath === currentPath) {
        showToast('路径没有变化');
        return;
    }
    if (targetFolder !== RESOURCE_ROOT && !targetFolder.startsWith(RESOURCE_ROOT + '/')) {
        showToast('只能修改为资源目录内的路径', true);
        return;
    }
    if (isResourcePathTaken(targetPath, originalPath)) {
        showToast(`目标位置已存在同名文件：${targetPath}，请先重命名或删除`, true);
        return;
    }

    // 还没上传的本地文件：只调整上传队列，不涉及提交
    const pendingKey = state.pendingResourceFiles.has(fromPath) ? fromPath
        : (state.pendingResourceFiles.has(originalPath) ? originalPath : '');
    if (pendingKey) {
        const meta = state.pendingResourceFiles.get(pendingKey) || {};
        state.pendingResourceFiles.delete(pendingKey);
        state.pendingResourceFiles.set(targetPath, Object.assign({}, meta, { name, folderPath: targetFolder }));
        renderResourceTreeFromCache();
        showToast(`已改为 ${targetPath}（待提交）`);
        return;
    }

    const fileMeta = state.resourceRemotePaths.find(item => item.type === 'file' && item.path === originalPath);
    if (!fileMeta) {
        showToast(`找不到资源文件：${originalPath}`, true);
        return;
    }
    if (!getGithubToken()) {
        alert('请先登录后再修改资源文件路径');
        return;
    }

    // 挪回原路径 = 撤销这次待提交的修改
    if (targetPath === originalPath) {
        state.pendingResourceMoves.delete(originalPath);
        renderResourceTreeFromCache();
        showToast('已恢复到原位置（撤销这次修改）');
        return;
    }

    state.pendingResourceMoves.set(originalPath, {
        path: targetPath,
        sha: fileMeta.sha || '',
        size: fileMeta.size || 0
    });
    renderResourceTreeFromCache();
    showToast(`已登记到 ${targetPath}，点“提交资源”后一起生效`);
}

// 右键重命名（只改文件名，不改目录）
function renameResourceFile(filePath) {
    const currentPath = resourceVirtualPath(filePath);
    const folder = resourceParentOf(currentPath);
    const oldName = currentPath.split('/').pop();
    const raw = prompt(`重命名资源文件（只写新文件名，不含目录）：`, oldName);
    if (raw == null) return;
    const nextName = String(raw).trim();
    if (!nextName || nextName === oldName) return;
    if (nextName.includes('/') || nextName.includes('\\')) {
        showToast('文件名不能包含斜杠', true);
        return;
    }
    if (/[<>:"|?*]/.test(nextName)) {
        showToast('文件名不能包含 < > : " | ? *', true);
        return;
    }
    relocateResourceFile(filePath, `${folder}/${nextName}`);
}

// 提交成功后把移动/重命名结果写回本地缓存
export function applyCommittedResourceMoves(movedEntries) {
    movedEntries.forEach(([fromPath, meta]) => {
        state.resourceRemotePaths = state.resourceRemotePaths.filter(item => item.path !== fromPath);
        if (!state.resourceRemotePaths.some(item => item.path === meta.path)) {
            state.resourceRemotePaths.push({ path: meta.path, type: 'file', size: meta.size || 0, sha: meta.sha || '' });
        }
        if (state.repoTreeState.items) {
            const moved = { path: meta.path, type: 'file', size: meta.size || 0, sha: meta.sha || '' };
            const index = state.repoTreeState.items.findIndex(item => item.path === fromPath);
            if (index > -1) state.repoTreeState.items.splice(index, 1, moved);
            else if (!state.repoTreeState.items.some(item => item.path === meta.path)) state.repoTreeState.items.push(moved);
        }
    });
}

function renderResourceNode(node, level = 0) {
    const folders = Array.from(node.folders.values())
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const files = node.files.slice()
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));

    folders.forEach(folder => {
        const el = document.createElement('div');
        el.className = 'tree-item folder expanded';
        el.dataset.path = folder.path;
        el.dataset.parentPath = folder.path.substring(0, folder.path.lastIndexOf('/'));
        el.dataset.type = 'folder';
        el.style.paddingLeft = `${level * 16 + 8}px`;
        el.innerHTML = `<i class="fa fa-folder-open-o"></i> <span class="folder-name">${escapeHtml(folder.name)}</span>`;

        el.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleResourceFolder(el);
        });
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showResourceFolderContextMenu(e, folder.path);
        });

        // 作为拖拽落点：把资源文件拖到这个文件夹即移动到其下
        el.addEventListener('dragover', (e) => handleResourceFolderDragOver(e, el, folder.path));
        el.addEventListener('dragleave', (e) => handleResourceFolderDragLeave(e, el));
        el.addEventListener('drop', (e) => handleResourceFolderDrop(e, el, folder.path));

        dom.resourceTree.appendChild(el);
        renderResourceNode(folder, level + 1);
    });

    files.forEach(file => {
        const el = document.createElement('div');
        el.className = 'tree-item file' + (file.pending ? ' pending' : '') + (file.moved ? ' moved' : '');
        el.dataset.path = file.path;
        el.dataset.parentPath = file.parentPath;
        el.dataset.fileName = file.name;
        el.style.paddingLeft = `${level * 16 + 8}px`;
        el.title = file.pending
            ? `${file.path}（待提交，可拖到其他文件夹）`
            : (file.moved
                ? `${file.fromPath} → ${file.path}（待提交的移动/重命名，点“提交资源”后生效）`
                : `${file.path}（可拖到其他文件夹）`);
        el.innerHTML = `<i class="fa ${getFileIcon(file.name)}"></i> ${escapeHtml(file.name)}`
            + (file.pending ? '<span class="pending-badge">待提交</span>' : '')
            + (file.moved ? '<span class="pending-badge">待提交</span>' : '');

        // 匿名只读时远端文件不可写，隐藏拖拽能力；待提交文件只是改本队列，随时可拖
        el.draggable = !!file.pending || !!file.moved || !!getGithubToken();
        if (el.draggable) {
            el.addEventListener('dragstart', (e) => startResourceDrag(e, file, el));
            el.addEventListener('dragend', () => endResourceDrag());
        }

        el.addEventListener('dblclick', () => {
            if (file.pending || file.moved) {
                alert('该文件的修改还没有提交，提交后才能在线查看');
                return;
            }
            window.open(rawResourceUrl(file.path), '_blank');
        });
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showResourceFileContextMenu(e, file.path, !!file.pending || !!file.moved);
        });

        dom.resourceTree.appendChild(el);
    });
}

// 折叠/展开文件夹（整棵子树一起处理）
function toggleResourceFolder(folderEl) {
    const path = folderEl.dataset.path;
    const expanded = folderEl.classList.contains('expanded');
    const icon = folderEl.querySelector('i');
    if (expanded) {
        folderEl.classList.remove('expanded');
        icon.className = 'fa fa-folder-o';
    } else {
        folderEl.classList.add('expanded');
        icon.className = 'fa fa-folder-open-o';
    }
    syncResourceVisibility();
}

// 依据各级文件夹的展开状态，统一计算可见性（也用于清空搜索后恢复）
function syncResourceVisibility() {
    const items = Array.from(dom.resourceTree.querySelectorAll('.tree-item'));
    let collapsedPaths = [];

    items.forEach(el => {
        const path = el.dataset.path || '';
        collapsedPaths = collapsedPaths.filter(p => path === p || path.startsWith(p + '/'));
        const hiddenByAncestor = collapsedPaths.length > 0;
        el.style.display = hiddenByAncestor ? 'none' : 'flex';
        if (el.classList.contains('folder') && !el.classList.contains('expanded')) {
            collapsedPaths.push(path);
        }
    });

    dom.resourceSearchClear.style.display =
        (dom.resourceSearchInput.value || '').trim() ? 'block' : 'none';
}

export function renderResourceTreeFromCache() {
    const tree = buildResourceTree(state.resourceRemotePaths);
    dom.resourceTree.innerHTML = '';
    renderResourceNode(tree);
    syncResourceVisibility();
    updatePendingResourceBadge();
    refreshResourceUploadFolders();
}

// 渲染资源树（默认走仓库树缓存，force 才重新请求 API）
export async function renderResourceTree(force = false) {
    updatePendingResourceBadge();
    refreshResourceUploadFolders();

    const token = getGithubToken();
    dom.resourceTree.innerHTML = '<div class="resource-loading"><i class="fa fa-spinner fa-spin"></i> 加载资源...</div>';

    try {
        state.resourceRemotePaths = (await loadResourcePaths(force)) || [];
        if (!token) {
            // 匿名只读提示，放在树下方由 CSS 处理（不占树结构）
            dom.resourceTree.dataset.anonymous = '1';
        } else {
            delete dom.resourceTree.dataset.anonymous;
        }
        if (state.resourceRemotePaths.length === 0 && pendingResourceCount() === 0) {
            state.resourceTreeLoaded = true;
            dom.resourceTree.innerHTML = '<div class="resource-empty">资源目录为空</div>';
            renderFileTree();
            return;
        }
        state.resourceTreeLoaded = true;
        renderResourceTreeFromCache();
        // 仓库树同时包含 blog 目录结构，顺手刷新左侧文件树的空目录
        renderFileTree();
    } catch (error) {
        console.error('加载资源目录失败:', error);
        state.resourceTreeLoaded = false;
        const message = (error && (error.status === 403 || /403/.test(error.message)))
            ? 'GitHub API 匿名限额已用尽（60 次/小时），登录后可继续加载资源，或稍后重试'
            : error.message;
        dom.resourceTree.innerHTML = `<div class="resource-empty error">加载失败: ${escapeHtml(message)}</div>`;
    }
}

async function refreshResourceTree(force = true) {
    state.resourceTreeLoaded = false;
    await renderResourceTree(force);
}

// 复制路径（带兜底，避免非安全上下文下 clipboard 不可用）
function copyText(text) {
    const fallback = () => {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
        } catch (e) {
            alert(`复制失败，请手动复制：${text}`);
        }
    };
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).catch(fallback);
    } else {
        fallback();
    }
}

function showResourceFolderContextMenu(e, folderPath) {
    dom.resourceContextMenu.style.display = 'block';
    dom.resourceContextMenu.style.left = e.pageX + 'px';
    dom.resourceContextMenu.style.top = e.pageY + 'px';
    dom.resourceContextMenu.dataset.folderPath = folderPath;

    dom.resCopyPath.style.display = 'flex';
    dom.resUploadFile.style.display = 'flex';
    dom.resNewFolder.style.display = 'flex';
    dom.resDeleteFolder.style.display = 'flex';
    dom.resRenameFile.style.display = 'none';
    dom.resDeleteFile.style.display = 'none';

    dom.resCopyPath.onclick = () => {
        copyText('/' + folderPath);
        dom.resourceContextMenu.style.display = 'none';
    };

    dom.resUploadFile.onclick = () => {
        pickResourceFiles(folderPath);
        dom.resourceContextMenu.style.display = 'none';
    };

    dom.resNewFolder.onclick = () => {
        const rawName = prompt('请输入资源文件夹名称（支持多级，如 images/2026）：');
        dom.resourceContextMenu.style.display = 'none';
        if (rawName && rawName.trim()) queueResourceFolder(folderPath, rawName.trim());
    };

    dom.resDeleteFolder.onclick = () => {
        dom.resourceContextMenu.style.display = 'none';
        deleteResourceFolder(folderPath);
    };
}

function showResourceFileContextMenu(e, filePath, isPending) {
    dom.resourceContextMenu.style.display = 'block';
    dom.resourceContextMenu.style.left = e.pageX + 'px';
    dom.resourceContextMenu.style.top = e.pageY + 'px';
    dom.resourceContextMenu.dataset.filePath = filePath;

    dom.resCopyPath.style.display = 'flex';
    dom.resUploadFile.style.display = 'none';
    dom.resNewFolder.style.display = 'none';
    dom.resDeleteFolder.style.display = 'none';
    dom.resDeleteFile.style.display = 'flex';
    // 重命名：待上传的文件随时可改；远端文件需要登录（会记为待提交的移动）
    dom.resRenameFile.style.display = (isPending || getGithubToken()) ? 'flex' : 'none';

    dom.resCopyPath.onclick = () => {
        copyText('/' + filePath);
        dom.resourceContextMenu.style.display = 'none';
    };

    dom.resRenameFile.onclick = () => {
        dom.resourceContextMenu.style.display = 'none';
        renameResourceFile(filePath);
    };

    dom.resDeleteFile.onclick = () => {
        dom.resourceContextMenu.style.display = 'none';
        deleteResourceFile(filePath, isPending);
    };
}

// 资源搜索
export function filterResourceItems(searchTerm) {
    const term = (searchTerm || '').toLowerCase().trim();
    if (!term) {
        syncResourceVisibility();
        return;
    }

    const items = Array.from(dom.resourceTree.querySelectorAll('.tree-item'));
    const matched = new Set();
    const neededFolders = new Set();

    items.forEach(el => {
        const isFolder = el.classList.contains('folder');
        const name = (isFolder
            ? (el.querySelector('.folder-name')?.textContent || '')
            : (el.dataset.fileName || '')).toLowerCase();
        if (name.includes(term)) {
            if (isFolder) {
                neededFolders.add(el.dataset.path);
            } else {
                matched.add(el);
                let parent = el.dataset.parentPath;
                while (parent) {
                    neededFolders.add(parent);
                    parent = parent.substring(0, parent.lastIndexOf('/'));
                }
            }
        }
    });

    items.forEach(el => {
        const show = matched.has(el)
            || (el.classList.contains('folder') && neededFolders.has(el.dataset.path));
        el.style.display = show ? 'flex' : 'none';
    });

    dom.resourceSearchClear.style.display = 'block';
}
