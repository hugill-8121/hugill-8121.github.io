// 仓库树：一次递归抓取并缓存（5 分钟 TTL），资源栏与文件栏共用同一份。

import { config, state } from './state.js';
import { getGithubToken } from './utils.js';
import { handleAuthFailure } from './auth.js';
import { loadFoldersForEdit } from './editor.js';
import { createOctokit, isAuthError, listRepoPaths } from '../github-api.js';

// ==================== 资源栏（media 目录） ====================

export const RESOURCE_ROOT = 'media';

const REPO_TREE_TTL = 5 * 60 * 1000;
/**
 * 一次性拉取整棵仓库树并缓存：资源栏、文件树、博客目录共用这一次结果，
 * 避免每打开一次编辑页就再打一次 GitHub API。
 * @param {boolean} force 是否强制刷新（刷新按钮 / 提交后手动同步时用）
 */

export async function loadRepoTreeOnce(force = false) {
    if (!force && state.repoTreeState.items && (Date.now() - state.repoTreeState.loadedAt) < REPO_TREE_TTL) {
        return state.repoTreeState.items;
    }

    const token = getGithubToken();
    const repoInfo = { owner: config.owner, repo: config.repo, branch: config.branch };
    const fetchTree = async (auth) => {
        const octokit = createOctokit(auth);
        return listRepoPaths(octokit, repoInfo, '');
    };

    let items;
    try {
        items = await fetchTree(token);
    } catch (error) {
        if (token && isAuthError(error)) {
            handleAuthFailure('GitHub Token 已失效（Bad credentials），已切换为匿名只读。');
            items = await fetchTree('');
        } else {
            throw error;
        }
    }

    state.repoTreeState = { items, loadedAt: Date.now() };
    state.blogFolderPaths = items
        .filter(item => item.type === 'folder' && item.path.startsWith('blog/'))
        .map(item => item.path);
    loadFoldersForEdit();
    return items;
}

// 从仓库树缓存里取出资源目录下的路径（公开仓库匿名也能读）
export async function loadResourcePaths(force = false) {
    const items = await loadRepoTreeOnce(force);
    return items
        .filter(item => item.path === RESOURCE_ROOT || item.path.startsWith(RESOURCE_ROOT + '/'))
        .filter(item => item.path !== RESOURCE_ROOT);
}

// 把远端路径 + 待提交项合成一棵树
export function buildResourceTree(paths) {
    const root = { name: '', path: '', folders: new Map(), files: [] };

    const ensureFolder = (parent, name, path) => {
        if (!parent.folders.has(name)) {
            parent.folders.set(name, { name, path, folders: new Map(), files: [] });
        }
        return parent.folders.get(name);
    };

    const addFile = (path, meta = {}) => {
        const parts = path.split('/').filter(Boolean);
        if (parts[0] !== RESOURCE_ROOT || parts.length < 2) return;
        if (parts[parts.length - 1] === '.gitkeep') return;
        let node = root;
        for (let i = 1; i < parts.length - 1; i++) {
            node = ensureFolder(node, parts[i], parts.slice(0, i + 1).join('/'));
        }
        node.files.push(Object.assign({
            name: parts[parts.length - 1],
            path,
            parentPath: parts.slice(0, -1).join('/')
        }, meta));
    };

    (paths || []).forEach(item => {
        if (item.type === 'folder') {
            const parts = item.path.split('/').filter(Boolean);
            if (parts[0] !== RESOURCE_ROOT) return;
            let node = root;
            for (let i = 1; i < parts.length; i++) {
                node = ensureFolder(node, parts[i], parts.slice(0, i + 1).join('/'));
            }
        } else {
            // 已登记待提交删除的文件不再展示
            if (state.pendingResourceDeletes.has(item.path)) return;
            // 已经在“待提交移动/重命名”队列里的文件，按目标路径展示
            const move = state.pendingResourceMoves.get(item.path);
            addFile(move ? move.path : item.path, Object.assign(
                { pending: false, sha: item.sha || '' },
                move ? { moved: true, fromPath: item.path } : {}
            ));
        }
    });

    // 待创建的文件夹
    state.pendingResourceFolders.forEach((meta, path) => {
        const parts = path.split('/').filter(Boolean);
        if (parts[0] !== RESOURCE_ROOT) return;
        let node = root;
        for (let i = 1; i < parts.length; i++) {
            node = ensureFolder(node, parts[i], parts.slice(0, i + 1).join('/'));
        }
    });

    // 待提交的文件
    state.pendingResourceFiles.forEach((meta, path) => {
        addFile(path, { pending: true });
    });

    return root;
}
