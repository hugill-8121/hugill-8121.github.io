// 导入Octokit库
import { Octokit } from "https://esm.sh/octokit";

/**
 * 获取文件的提交记录（最新一条）
 * @param {string} owner - 仓库所有者
 * @param {string} repo - 仓库名
 * @param {string} path - 文件路径
 * @param {string} branch - 分支名
 * @param {string} [token] - GitHub Token（可选）
 * @returns {Promise<Array>} 提交记录数组
 */
async function getFileCommits(owner, repo, path, branch, token) {
    // 处理中文路径编码（按GitHub API要求）
    const encodedPath = path.split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/');

    const url = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodedPath}&ref=${branch}&per_page=1`;
    
    const headers = {
        'Accept': 'application/json',
        'User-Agent': 'Blog-App' // GitHub API要求必须有User-Agent
    };

    // 如果有token，添加认证头
    if (token) {
        headers['Authorization'] = `token ${token}`;
    }

    const response = await fetch(url, { headers });
    
    if (!response.ok) {
        throw new Error(`获取提交记录失败: ${response.statusText}`);
    }

    return await response.json();
}

/**
 * 获取当前认证用户的信息
 * @param {string} token - GitHub Token
 * @returns {Promise<Object>} 用户信息对象
 */
async function getUserInfo(token) {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.rest.users.getAuthenticated();
    return data;
}

/**
 * 获取API限流状态
 * @param {string} token - GitHub Token
 * @returns {Promise<Object>} 限流信息对象
 */
async function getRateLimit(token) {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.rest.rateLimit.get();
    return data;
}

// 导出模块
export {
    Octokit,
    getFileCommits,
    getUserInfo,
    getRateLimit
};