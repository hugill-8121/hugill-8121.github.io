// 文章详情：按 uuid/标题定位文章、加载正文与最新 commit 信息。

import { config, state } from '../core/state.js';
import { dom } from '../core/dom.js';
import { encodePath, getGithubToken } from '../core/utils.js';
import { handleAuthFailure } from '../core/auth.js';
import { createOctokit, fetchRepoFileText, isAuthError } from '../../lib/github-api.js';
import { loadBlogContent, renderMarkdown, switchToShow } from '../../lib/blog-utils.js';


// 根据标题/uuid 显示博客
export async function showBlogByIdentity(identity = {}) {
    const blogInfo = identity.uuid
        ? state.allBlogs.find(b => String(b.uuid) === String(identity.uuid))
        : state.allBlogs.find(b => b.title === identity.title);

    if (!blogInfo) {
        console.error('找不到博客:', identity);
        return;
    }

    state.currentBlog = blogInfo;
    switchToShow(blogInfo, dom);
    loadBlogContent(blogInfo, dom, renderMarkdown, { content: state.blogContentCache.get(blogInfo.path) });
    loadCommitInfo(blogInfo);
}

// 构造文章详情链接：fresh=1 表示详情页用 GitHub API 读最新正文（绕过 Pages 构建延迟）
export function buildBlogShowUrl({ uuid, path, title, tags, fresh = false }) {
    const query = new URLSearchParams();
    query.set('opera', 'blog-show');
    query.set('uuid', uuid == null ? '' : String(uuid));
    if (path) query.set('path', path);
    if (title) query.set('title', title);
    if (Array.isArray(tags) && tags.length) query.set('tags', JSON.stringify(tags));
    if (fresh) query.set('fresh', '1');
    return `${window.location.pathname}?${query.toString()}`;
}

// 刚保存的文章：信息全部来自 URL，正文走 API，避免新标签页读到 Pages 上的旧版本
export async function showFreshBlogFromUrl() {
    const search = new URLSearchParams(window.location.search);
    const path = search.get('path') || '';
    const uuid = search.get('uuid') || '';
    const title = search.get('title') || '';
    let tags = [];
    try {
        tags = JSON.parse(search.get('tags') || '[]');
    } catch (err) {
        tags = (search.get('tags') || '').split(',').filter(Boolean);
    }
    if (!Array.isArray(tags)) tags = [];

    let blogInfo = state.allBlogs.find(b => (uuid && String(b.uuid) === String(uuid)) || b.path === path);
    if (!blogInfo) {
        blogInfo = { blog_uuid: uuid, uuid, path, filePath: path, tags, description: title };
        state.allBlogs.push(blogInfo);
    }
    Object.assign(blogInfo, { blog_uuid: uuid || blogInfo.blog_uuid, uuid: uuid || blogInfo.uuid, path, filePath: path, title, tags });

    state.currentBlog = blogInfo;
    switchToShow(blogInfo, dom);

    try {
        const repoInfo = { owner: config.owner, repo: config.repo, branch: config.branch };
        const text = await fetchRepoFileText(createOctokit(getGithubToken()), repoInfo, path);
        loadBlogContent(blogInfo, dom, renderMarkdown, { content: text });
    } catch (err) {
        console.warn('读取最新正文失败，回退静态文件:', err);
        loadBlogContent(blogInfo, dom, renderMarkdown);
    }
    loadCommitInfo(blogInfo);
}

// 获取并展示某个文章的最新提交信息
async function loadCommitInfo(blogInfo) {
    if (!blogInfo || !blogInfo.path) return;

    const token = getGithubToken();
    const url = `https://api.github.com/repos/${config.owner}/${config.repo}/commits?path=${encodePath(blogInfo.path)}&ref=${encodeURIComponent(config.branch)}&per_page=1`;
    const read = async (auth) => {
        const response = await fetch(url, { headers: auth ? { Authorization: `token ${auth}` } : {}, cache: 'no-store' });
        if (response.status === 401) {
            const error = new Error('Bad credentials');
            error.status = 401;
            throw error;
        }
        if (!response.ok) throw new Error(`获取提交信息失败: ${response.status}`);
        return response.json();
    };

    try {
        let commits;
        try {
            commits = await read(token);
        } catch (error) {
            if (!token || !isAuthError(error)) return;
            handleAuthFailure('GitHub Token 已失效（Bad credentials），已切换为匿名读取。');
            commits = await read('');
        }
        if (commits && commits.length > 0) {
            const commit = commits[0];
            displayCommitInfo({
                author: commit.commit.committer.name || commit.author?.login || '未知',
                date: new Date(commit.commit.committer.date),
                message: commit.commit.message,
                sha: commit.sha.substring(0, 7)
            }, config.owner, config.repo, commit.sha);
        }
    } catch (error) {
        console.warn('获取提交信息失败:', error);
    }
}

// 显示提交信息
function displayCommitInfo(commitInfo, owner, repo, fullSha) {
    if (!commitInfo) return;

    document.getElementById('commit-author').textContent = commitInfo.author;
    document.getElementById('commit-date').textContent = commitInfo.date.toLocaleString();
    document.getElementById('commit-message').textContent = commitInfo.message;
    document.getElementById('commit-sha').textContent = commitInfo.sha;
    document.getElementById('commit-sha').href = `https://github.com/${owner}/${repo}/commit/${fullSha}`;

    document.getElementById('commit-info-panel').style.display = 'block';
}
