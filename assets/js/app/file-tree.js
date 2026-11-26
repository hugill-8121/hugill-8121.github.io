// 左侧文件栏：blog 目录树渲染、展开状态、右键菜单、新建目录。

import { config, state } from './state.js';
import { dom } from './dom.js';
import { getGithubToken, showToast } from './utils.js';
import { loadFoldersForEdit, openFileInTab } from './editor.js';
import { updateVisibilityCommitBadge } from './resource-queue.js';
import { CommitBatch, createOctokit } from '../github-api.js';
import { escapeHtml } from '../blog-utils.js';

// ==================== 左侧文件栏（blog 目录） ====================
// 记住已展开的文件夹（相对 blog/ 的路径）。重新渲染（打开/保存文章）时保持用户的展开状态，
// 否则每次渲染都会把整棵树折回去。
const expandedFileFolders = new Set();

// 渲染文件树（支持多重文件夹结构）
export function renderFileTree() {
    dom.fileTree.innerHTML = '';

    // 构建文件树结构
    const fileTree = {};

    // 先放入 blog 目录下已存在（含空目录）的文件夹
    const ensureFolderNode = (relativePath) => {
        const parts = relativePath.split('/').filter(Boolean);
        let node = fileTree;
        parts.forEach(part => {
            if (!node[part]) node[part] = {};
            node = node[part];
        });
        return node;
    };
    state.blogFolderPaths.forEach(fullPath => {
        if (fullPath === 'blog') return;
        ensureFolderNode(fullPath.replace(/^blog\//, ''));
    });

    state.allBlogs.forEach(blog => {
        // 路径格式: blog/{group}/{filename}.md 或 blog/{group}/{subfolder}/{filename}.md
        const pathParts = blog.path.split('/').filter(p => p); // 过滤空字符串
        pathParts.shift(); // 移除 'blog'

        let current = fileTree;
        pathParts.forEach((part, index) => {
            if (index === pathParts.length - 1) {
                // 最后部分是文件
                if (!current._files) current._files = [];
                current._files.push({
                    name: part,
                    blog: blog,
                    path: blog.path
                });
            } else {
                // 中间部分是文件夹
                if (!current[part]) {
                    current[part] = {};
                }
                current = current[part];
            }
        });
    });

    // 递归渲染文件夹
    function renderFolderLevel(folder, folderPath, level = 0) {
        const folders = Object.keys(folder).filter(k => k !== '_files').sort();
        const files = folder._files || [];

        folders.forEach(folderName => {
            const subPath = folderPath ? `${folderPath}/${folderName}` : folderName;
            const expanded = expandedFileFolders.has(subPath);
            const folderEl = document.createElement('div');
            folderEl.className = 'tree-item folder' + (expanded ? ' expanded' : '');
            // 记录自身路径与父目录路径：收起父目录时，子文件夹也要跟着收起
            folderEl.dataset.path = subPath;
            folderEl.dataset.parentPath = folderPath || '';
            folderEl.dataset.folderPath = subPath;
            folderEl.innerHTML = `<span class="tree-check-slot"></span><span class="tree-label" style="padding-left:${level * 16}px"><i class="fa ${expanded ? 'fa-folder-open-o' : 'fa-folder-o'}"></i> <span class="folder-name">${escapeHtml(folderName)}</span></span>`;

            // 单击展开/收起文件夹（子文件夹与文件一起处理）
            folderEl.addEventListener('click', (e) => {
                e.stopPropagation();
                const icon = folderEl.querySelector('i');

                if (expandedFileFolders.has(subPath)) {
                    expandedFileFolders.delete(subPath);
                    folderEl.classList.remove('expanded');
                    icon.className = 'fa fa-folder-o';
                } else {
                    expandedFileFolders.add(subPath);
                    folderEl.classList.add('expanded');
                    icon.className = 'fa fa-folder-open-o';
                }
                syncFileTreeVisibility();
            });

            // 右键菜单
            folderEl.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showFileFolderContextMenu(e, subPath);
            });

            dom.fileTree.appendChild(folderEl);

            // 递归渲染子文件夹
            renderFolderLevel(folder[folderName], subPath, level + 1);
        });

        // 渲染文件
        files.forEach(fileInfo => {
            const fileEl = document.createElement('div');
            fileEl.className = 'tree-item file';
            fileEl.dataset.parentPath = folderPath || '';
            fileEl.dataset.path = fileInfo.path;
            fileEl.dataset.title = fileInfo.blog.title;
            fileEl.dataset.fileName = fileInfo.name;

            // 显示状态：优先取待提交的批量变更，否则用当前配置
            const pendingHidden = state.pendingVisibility.has(fileInfo.path)
                ? state.pendingVisibility.get(fileInfo.path)
                : !!fileInfo.blog.hidden;
            if (pendingHidden) fileEl.classList.add('is-hidden');

            if (state.currentEditFile && state.currentEditFile.path === fileInfo.blog.path) {
                fileEl.classList.add('active');
                // 当前文章所在目录逐级展开，保证打开的文章在左侧栏能看到
                const parts = folderPath.split('/').filter(Boolean);
                for (let i = 1; i <= parts.length; i++) {
                    expandedFileFolders.add(parts.slice(0, i).join('/'));
                }
            }

            fileEl.innerHTML = `<input type="checkbox" class="tree-hidden-check" title="勾选=在主页隐藏" ${pendingHidden ? 'checked' : ''}><span class="tree-label" style="padding-left:${level * 16}px"><i class="fa fa-file-text-o"></i> ${escapeHtml(fileInfo.name)}</span>`;

            // 勾选只登记批量变更，不打开文章
            const checkEl = fileEl.querySelector('.tree-hidden-check');
            checkEl.addEventListener('click', (e) => {
                e.stopPropagation();
            });
            checkEl.addEventListener('change', () => {
                const current = !!fileInfo.blog.hidden;
                const desired = checkEl.checked;
                if (desired === current) state.pendingVisibility.delete(fileInfo.path);
                else state.pendingVisibility.set(fileInfo.path, desired);
                fileEl.classList.toggle('is-hidden', desired);
                updateVisibilityCommitBadge();
            });

            // 单击打开文件
            fileEl.addEventListener('click', () => {
                openFileInTab(fileInfo.blog);
            });

            // 右键菜单
            fileEl.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                showFileContextMenu(e, fileInfo.blog);
            });

            dom.fileTree.appendChild(fileEl);
        });
    }

    // 开始渲染
    renderFolderLevel(fileTree, '');
    syncFileTreeVisibility();
}

// 依据已展开的文件夹统一计算可见性：父目录收起时，其下所有子文件夹与文件一起隐藏
function syncFileTreeVisibility() {
    Array.from(dom.fileTree.querySelectorAll('.tree-item')).forEach(el => {
        let parent = el.dataset.parentPath || '';
        let hidden = false;
        while (parent) {
            if (!expandedFileFolders.has(parent)) {
                hidden = true;
                break;
            }
            const index = parent.lastIndexOf('/');
            parent = index > -1 ? parent.substring(0, index) : '';
        }
        el.style.display = hidden ? 'none' : 'flex';
    });
}

// 显示文件文件夹右键菜单
function showFileFolderContextMenu(e, folderPath) {
    dom.fileContextMenu.style.display = 'block';
    dom.fileContextMenu.style.left = e.pageX + 'px';
    dom.fileContextMenu.style.top = e.pageY + 'px';

    // 复制路径（路径前加/）
    dom.ctxCopyPath.style.display = 'flex';
    dom.ctxCopyPath.onclick = () => {
        const fullPath = folderPath ? `/blog/${folderPath}/` : '/blog/';
        navigator.clipboard.writeText(fullPath);
        dom.fileContextMenu.style.display = 'none';
    };

    // 打开文件（文件夹不显示此选项）
    dom.ctxOpenFile.style.display = 'none';

    // 新增文件夹选项（文件夹不支持）
    dom.ctxNewFolder.style.display = 'none';
}

// 显示文件右键菜单
function showFileContextMenu(e, blog) {
    dom.fileContextMenu.style.display = 'block';
    dom.fileContextMenu.style.left = e.pageX + 'px';
    dom.fileContextMenu.style.top = e.pageY + 'px';

    // 复制路径（路径前加/）
    dom.ctxCopyPath.style.display = 'flex';
    dom.ctxCopyPath.onclick = () => {
        navigator.clipboard.writeText(`/${blog.path}`);
        dom.fileContextMenu.style.display = 'none';
    };

    // 打开文件（文件不支持）
    dom.ctxOpenFile.style.display = 'none';

    // 新增文件夹选项（文件不支持）
    dom.ctxNewFolder.style.display = 'none';
}

// 在 blog 根目录下新建文件夹（Git 不能存空目录，用 .gitkeep 占位后提交）
export async function createBlogFolder() {
    const token = getGithubToken();
    if (!token) {
        alert('请先登录后再新建文件夹');
        return;
    }

    const rawName = prompt('请输入文件夹名称（可多级，例如：底层/C++）：');
    if (rawName === null) return;

    let name = rawName.trim().replace(/^\/+|\/+$/g, '');
    if (name.startsWith('blog/')) name = name.slice(5);
    if (!name) return;
    if (/[\\<>:"|?*]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) {
        alert('文件夹名不合法：不能包含 \\ < > : " | ? *，也不能有空段');
        return;
    }

    const folderPath = `blog/${name}`;
    const exists = state.blogFolderPaths.includes(folderPath)
        || state.repoTreeState.items?.some(item => item.type === 'folder' && item.path === folderPath)
        || state.allBlogs.some(blog => blog.path === folderPath || blog.path.startsWith(folderPath + '/'));
    if (exists) {
        alert('该文件夹已存在');
        return;
    }

    const placeholder = `${folderPath}/.gitkeep`;
    try {
        const octokit = createOctokit(token);
        const batch = new CommitBatch({
            octokit,
            owner: config.owner,
            repo: config.repo,
            branch: config.branch
        });
        batch.add(placeholder, '');
        const result = await batch.commit(`新增博客目录: ${name}`);
        if (!result.success) throw new Error(result.error);

        // 立即写入本地缓存，不再为“看到新目录”多打一次 API
        const folderParts = folderPath.split('/');
        for (let i = 2; i <= folderParts.length; i++) {
            const partPath = folderParts.slice(0, i).join('/');
            if (!state.blogFolderPaths.includes(partPath)) state.blogFolderPaths.push(partPath);
        }
        if (state.repoTreeState.items) {
            const addItem = (path, type) => {
                if (!state.repoTreeState.items.some(item => item.path === path && item.type === type)) {
                    state.repoTreeState.items.push({ path, type, size: 0 });
                }
            };
            addItem(placeholder, 'file');
            for (let i = 2; i <= folderParts.length; i++) {
                addItem(folderParts.slice(0, i).join('/'), 'folder');
            }
        }
        // 新建后逐级展开父目录，让新文件夹直接可见
        const nameParts = name.split('/').filter(Boolean);
        for (let i = 1; i <= nameParts.length; i++) {
            expandedFileFolders.add(nameParts.slice(0, i).join('/'));
        }
        renderFileTree();

        // 新目录只刷新“文件目录”候选，不进入分类下拉（分类与文件夹是两个概念）
        loadFoldersForEdit();
        const activeTab = state.openTabs.find(tab => tab.id === state.activeTabId);
        if (activeTab && activeTab.isNew && dom.editFolder) {
            const previousFolder = dom.editFolder.value.trim();
            if (!previousFolder || previousFolder === name) {
                dom.editFolder.value = name;
                dom.editFolder.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        showToast(`已创建目录：/${folderPath}`);
    } catch (error) {
        console.error('新建博客目录失败:', error);
        alert(`新建文件夹失败: ${error.message}`);
    }
}
