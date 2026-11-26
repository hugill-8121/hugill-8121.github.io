// 固定版本并使用 bundle 构建：不跟随 CDN 上的“最新版”及其依赖漂移，避免线上行为被悄悄改变
import { Octokit } from "https://esm.sh/octokit@5.0.5/es2022/octokit.bundle.mjs";
import { decodeBase64Utf8 } from "./blog-config.js";

/**
 * 把仓库内的相对路径按段编码（兼容中文与空格）
 * @param {string} path
 * @returns {string}
 */
export function encodeRepoPath(path) {
    return String(path || '')
        .split('/')
        .filter(segment => segment !== '')
        .map(segment => encodeURIComponent(segment))
        .join('/');
}

/**
 * 读取仓库文件（contents 接口）。
 * 不走 octokit.rest.repos.getContent：Octokit 会把 {path} 模板参数里的 "/" 编码成 %2F，
 * 而 GitHub 的 contents / git/refs 路由现在对 %2F 返回 404 / Reference does not exist，
 * 所以这里把路径直接拼进路由，只对每一段做编码。
 * @param {Octokit} octokit
 * @param {{owner:string, repo:string, branch:string}} repoInfo
 * @param {string} path
 */
async function getRepoContent(octokit, repoInfo, path) {
    const { data } = await octokit.request(
        `GET /repos/{owner}/{repo}/contents/${encodeRepoPath(path)}`,
        { owner: repoInfo.owner, repo: repoInfo.repo, ref: repoInfo.branch }
    );
    return data;
}

/**
 * 清理粘贴进来的 Token：去掉换行/空格/BOM、多余的 "token " 前缀，
 * 并从混杂文本中提取 GitHub Token 本体，避免出现 Bad credentials。
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeToken(raw) {
    const text = String(raw == null ? '' : raw)
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .trim();
    const match = text.match(/(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/);
    if (match) return match[1];
    return text.replace(/^(token|bearer)\s*:\s*/i, '').replace(/\s+/g, '');
}

/**
 * 判断错误是否是认证失败（Token 失效 / 带上了脏字符）
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAuthError(error) {
    const status = error && error.status;
    const message = String((error && error.message) || error || '');
    return status === 401 || /bad credentials|401 unauthorized/i.test(message);
}

function buildHeaders(token) {
    const headers = { 'Accept': 'application/json' };
    const safeToken = sanitizeToken(token);
    if (safeToken) headers['Authorization'] = `token ${safeToken}`;
    return headers;
}

// 关闭 Octokit 的自动限流重试：被限流时立即返回 403，交给界面给出可读提示，
// 否则插件会挂起几十秒，表现为“资源栏一直加载中”。
const NO_THROTTLE = {
    onRateLimit: () => false,
    onSecondaryRateLimit: () => false
};

// GitHub API 的响应带 Cache-Control: private, max-age=60：浏览器会把 60 秒内相同的 GET
// 直接用本地缓存。刚提交过资源再去保存文章时，读到的“分支最新提交”还是缓存里的旧值，
// 于是提交被拒绝（Update is not a fast forward）；读到旧的 blog-config.json 还会把上一次的修改覆盖掉。
// Octokit 只透传 request.fetch / signal / redirect，不透传 cache，所以统一用自定义 fetch 绕过 HTTP 缓存。
function noStoreFetch(url, options) {
    return globalThis.fetch(url, Object.assign({}, options, { cache: 'no-store' }));
}

/**
 * 统一的 Octokit 工厂（匿名/带 Token 都可以）
 * @param {string} [token]
 * @returns {Octokit}
 */
export function createOctokit(token) {
    const auth = sanitizeToken(token);
    return new Octokit(Object.assign(auth ? { auth } : {}, {
        throttle: NO_THROTTLE,
        request: { fetch: noStoreFetch }
    }));
}

function makeRequestError(message, status) {
    const error = new Error(message);
    error.status = status;
    return error;
}

async function fetchCommitsPage(owner, repo, branch, encodedPath, token, perPage, page) {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodedPath}&ref=${encodeURIComponent(branch)}&per_page=${perPage}&page=${page}`;
    const response = await fetch(url, { headers: buildHeaders(token), cache: 'no-store' });

    if (!response.ok) {
        if (response.status === 404) throw makeRequestError(`文件不存在: ${encodedPath}`, 404);
        if (response.status === 401) throw makeRequestError('Token 无效或已失效（Bad credentials）', 401);
        if (response.status === 403) throw makeRequestError('无权限访问，可能需要登录或 Token 权限不足', 403);
        throw makeRequestError(`获取提交记录失败: ${response.status} ${response.statusText}`, response.status);
    }
    return response.json();
}

async function fetchCommitsForPath(owner, repo, path, branch, token, perPage) {
    const encodedPath = encodeRepoPath(path);
    const commits = [];
    let page = 1;

    async function collect(activeToken) {
        commits.length = 0;
        page = 1;
        while (true) {
            const list = await fetchCommitsPage(owner, repo, branch, encodedPath, activeToken, perPage, page);
            if (!Array.isArray(list) || list.length === 0) break;
            commits.push(...list);
            if (list.length < perPage) break;
            page += 1;
            if (page > 50) break; // 安全上限，避免异常分页死循环
        }
        return commits;
    }

    try {
        return await collect(token);
    } catch (error) {
        // 带了脏/过期 Token 时，退回匿名读取，保证公开仓库的读取功能不受影响
        if (token && isAuthError(error)) {
            console.warn('Token 认证失败，改用匿名读取提交记录');
            return await collect('');
        }
        throw error;
    }
}

/**
 * 获取单个文件的最新提交记录
 * @param {string} owner
 * @param {string} repo
 * @param {string} path
 * @param {string} branch
 * @param {string} [token]
 * @returns {Promise<Array>}
 */
async function getFileCommits(owner, repo, path, branch, token) {
    const commits = await fetchCommitsForPath(owner, repo, path, branch, token, 1);
    return commits;
}

/**
 * 批量获取文件提交记录（并发受限、逐条上报进度）
 * @param {string} owner
 * @param {string} repo
 * @param {string[]} paths
 * @param {string} branch
 * @param {string} [token]
 * @param {number} [perPage=100] GitHub commits API 单页上限为 100
 * @param {(done:number, total:number)=>void} [onProgress]
 * @returns {Promise<Array<{path:string, commits:Array, total:number, error:string|null}>>}
 */
async function batchGetFileCommits(owner, repo, paths, branch, token, perPage = 100, onProgress) {
    // GitHub commits API 的 per_page 上限是 100，超出会返回 422
    const safePerPage = Math.max(1, Math.min(perPage, 100));
    const results = new Array(paths.length);
    const concurrency = Math.min(4, paths.length || 1);
    let cursor = 0;
    let done = 0;

    async function worker() {
        while (cursor < paths.length) {
            const index = cursor++;
            const path = paths[index];
            try {
                const commits = await fetchCommitsForPath(owner, repo, path, branch, token, safePerPage);
                results[index] = { path, commits, total: commits.length, error: null };
            } catch (error) {
                results[index] = { path, commits: [], total: 0, error: error.message };
            }
            done += 1;
            if (typeof onProgress === 'function') {
                try { onProgress(done, paths.length); } catch (_) { /* 进度回调异常不影响主流程 */ }
            }
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
}

/**
 * 获取当前认证用户信息
 * @param {string} token
 * @returns {Promise<Object>}
 */
async function getUserInfo(token) {
    const octokit = createOctokit(token);
    const { data } = await octokit.rest.users.getAuthenticated();
    return data;
}

/**
 * 获取用户信息，同时返回响应头（用于读取 X-OAuth-Scopes 等 Token 元信息）
 * @param {string} token
 * @returns {Promise<{user: Object, headers: Object}>}
 */
async function getUserInfoWithMeta(token) {
    const octokit = createOctokit(token);
    const response = await octokit.rest.users.getAuthenticated();
    return { user: response.data, headers: response.headers || {} };
}

/**
 * 获取 API 限流状态（不传 Token 时返回匿名限额）
 * @param {string} [token]
 * @returns {Promise<Object>}
 */
async function getRateLimit(token) {
    const octokit = createOctokit(token);
    const { data } = await octokit.rest.rateLimit.get();
    return data;
}

/**
 * 读取 blog-config.json（同时拿到 sha 与 UTF-8 文本）
 * @param {Octokit} octokit
 * @param {{owner:string, repo:string, branch:string, path?:string}} repoInfo
 * @returns {Promise<{config: Object, sha: string, text: string}>}
 */
async function fetchBlogConfig(octokit, repoInfo) {
    const path = repoInfo.path || 'blog-config.json';
    const data = await getRepoContent(octokit, repoInfo, path);

    if (Array.isArray(data) || !data || typeof data.content !== 'string') {
        throw new Error(`${path} 不是一个可读取的文件`);
    }

    const text = decodeBase64Utf8(data.content);
    let config;
    try {
        config = JSON.parse(text);
    } catch (error) {
        throw new Error(`解析 ${path} 失败: ${error.message}`);
    }
    return { config, sha: data.sha, text };
}

/**
 * 列出仓库某个目录下的全部路径（一次递归取树，避免逐层请求打满限流）
 * @param {Octokit} octokit
 * @param {{owner:string, repo:string, branch:string}} repoInfo
 * @param {string} [subPath] 限定目录，如 'asserts'
 * @returns {Promise<Array<{path:string, type:'file'|'folder', size:number}>>}
 */
async function listRepoPaths(octokit, repoInfo, subPath = '') {
    const { data } = await octokit.rest.git.getTree({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        tree_sha: repoInfo.branch,
        recursive: '1'
    });

    if (data.truncated) {
        console.warn('仓库文件树过大，GitHub 返回了截断结果');
    }

    const prefix = subPath.replace(/\/+$/, '');
    return (data.tree || [])
        .filter(item => {
            if (!prefix) return true;
            return item.path === prefix || item.path.startsWith(prefix + '/');
        })
        .map(item => ({
            path: item.path,
            type: item.type === 'tree' ? 'folder' : 'file',
            size: item.size || 0,
            // 带上 blob sha：移动文件时可直接引用已有 blob，不必下载再上传内容
            sha: item.sha || ''
        }));
}

/**
 * 批量提交器：一次 commit 提交多个文件的新增/修改/删除
 * 使用 Git Data API（blob → tree → commit → ref），保证多个文件原子写入
 */
class CommitBatch {
    /**
     * @param {{octokit: Octokit, owner: string, repo: string, branch: string}} options
     */
    constructor({ octokit, owner, repo, branch }) {
        this.octokit = octokit;
        this.owner = owner;
        this.repo = repo;
        this.branch = branch;
        /** @type {Map<string, {path:string, action:'write'|'delete', content?:string, encoding?:'utf-8'|'base64'}>} */
        this.operations = new Map();
    }

    /**
     * 新增或覆盖一个文本文件
     * @param {string} path
     * @param {string} content
     * @returns {CommitBatch}
     */
    add(path, content) {
        this.operations.set(path, { path, action: 'write', content: String(content ?? ''), encoding: 'utf-8' });
        return this;
    }

    /**
     * 新增或覆盖一个二进制文件
     * @param {string} path
     * @param {string} base64Content 不含 data: 前缀的 base64
     * @returns {CommitBatch}
     */
    addBinary(path, base64Content) {
        this.operations.set(path, { path, action: 'write', content: base64Content, encoding: 'base64' });
        return this;
    }

    /**
     * 删除一个文件
     * @param {string} path
     * @returns {CommitBatch}
     */
    delete(path) {
        this.operations.set(path, { path, action: 'delete' });
        return this;
    }

    /**
     * 重命名/移动文件（读取旧内容后写入新路径，并删除旧路径）
     * @param {string} fromPath
     * @param {string} toPath
     * @returns {Promise<CommitBatch>}
     */
    async rename(fromPath, toPath) {
        const data = await getRepoContent(this.octokit, this, fromPath);
        if (Array.isArray(data) || !data || typeof data.content !== 'string') {
            throw new Error(`无法重命名：${fromPath} 不是文件`);
        }
        this.operations.delete(fromPath);
        this.operations.set(toPath, { path: toPath, action: 'write', content: data.content, encoding: 'base64' });
        this.operations.set(fromPath, { path: fromPath, action: 'delete' });
        return this;
    }

    /**
     * 移动文件：新路径直接引用已有的 blob sha（不下载内容），旧路径标记删除。
     * 资源移动用这个，任意大小的二进制文件都不会因为 contents 接口的 1MB 限制而失败。
     * @param {string} fromPath
     * @param {string} toPath
     * @param {string} blobSha 源文件在仓库树里的 blob sha
     * @returns {CommitBatch}
     */
    moveRef(fromPath, toPath, blobSha) {
        if (!blobSha) throw new Error(`缺少 blob sha，无法移动：${fromPath}`);
        if (fromPath === toPath) return this;
        this.operations.delete(fromPath);
        this.operations.set(toPath, { path: toPath, action: 'ref', sha: blobSha });
        this.operations.set(fromPath, { path: fromPath, action: 'delete' });
        return this;
    }

    get size() {
        return this.operations.size;
    }

    /**
     * 执行提交，返回 {success, commitSha} 或 {success:false, error}
     * @param {string} message
     * @returns {Promise<{success:boolean, commitSha?:string, error?:string}>}
     */
    async commit(message) {
        if (this.operations.size === 0) {
            return { success: false, error: '没有需要提交的变更' };
        }

        // 并发写入时可能发生引用竞争，失败后基于最新分支重试一次
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const branchInfo = await this.octokit.rest.repos.getBranch({
                    owner: this.owner,
                    repo: this.repo,
                    branch: this.branch
                });
                const parentSha = branchInfo.data.commit.sha;
                const baseTreeSha = branchInfo.data.commit.commit.tree.sha;

                // 1. 先把内容写成 blob，拿到 sha（text 与 binary 都走同一条路径）
                const treeItems = [];
                for (const op of this.operations.values()) {
                    if (op.action === 'delete') {
                        treeItems.push({ path: op.path, mode: '100644', type: 'blob', sha: null });
                        continue;
                    }
                    // 移动：直接引用已有 blob，不重复上传内容
                    if (op.action === 'ref') {
                        treeItems.push({ path: op.path, mode: '100644', type: 'blob', sha: op.sha });
                        continue;
                    }
                    const { data: blob } = await this.octokit.rest.git.createBlob({
                        owner: this.owner,
                        repo: this.repo,
                        content: op.content,
                        encoding: op.encoding || 'utf-8'
                    });
                    treeItems.push({ path: op.path, mode: '100644', type: 'blob', sha: blob.sha });
                }

                // 2. 基于最新树创建新树
                const { data: newTree } = await this.octokit.rest.git.createTree({
                    owner: this.owner,
                    repo: this.repo,
                    base_tree: baseTreeSha,
                    tree: treeItems
                });

                // 3. 创建提交
                const { data: newCommit } = await this.octokit.rest.git.createCommit({
                    owner: this.owner,
                    repo: this.repo,
                    message,
                    tree: newTree.sha,
                    parents: [parentSha]
                });

                // 4. 更新分支引用
                //    分支名直接拼进路由：octokit.rest.git.updateRef 会把 ref 里的 "/" 编码成 %2F，
                //    GitHub 会返回 422 “Reference does not exist”（提交资源/保存文章因此失败）
                await this.octokit.request(
                    `PATCH /repos/{owner}/{repo}/git/refs/heads/${encodeRepoPath(this.branch)}`,
                    { owner: this.owner, repo: this.repo, sha: newCommit.sha }
                );

                this.operations.clear();
                return { success: true, commitSha: newCommit.sha };
            } catch (error) {
                const status = error && error.status;
                const retryable = status === 422 || status === 409;
                if (attempt === 0 && retryable) {
                    console.warn('提交发生引用竞争，重试一次:', error.message);
                    continue;
                }
                console.error('提交失败:', error);
                return { success: false, error: error.message };
            }
        }
        return { success: false, error: '提交失败（重试后仍未成功）' };
    }
}

/**
 * 简化调用：一次性提交一组文本文件并返回结果
 * @param {{octokit: Octokit, owner: string, repo: string, branch: string}} repoInfo
 * @param {Record<string, string>} files path → 文本内容
 * @param {string} message
 */
async function commitFiles(repoInfo, files, message) {
    const batch = new CommitBatch(repoInfo);
    Object.entries(files).forEach(([path, content]) => batch.add(path, content));
    return batch.commit(message);
}

/**
 * 删除远端文件（一次 commit）
 * @param {{octokit: Octokit, owner: string, repo: string, branch: string}} repoInfo
 * @param {string[]} paths
 * @param {string} message
 */
async function deleteRepoFiles(repoInfo, paths, message) {
    const batch = new CommitBatch(repoInfo);
    paths.forEach(path => batch.delete(path));
    return batch.commit(message);
}

export {
    Octokit,
    getFileCommits,
    getUserInfo,
    getUserInfoWithMeta,
    getRateLimit,
    batchGetFileCommits,
    fetchBlogConfig,
    listRepoPaths,
    CommitBatch,
    commitFiles,
    deleteRepoFiles
};
