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
        // 特殊处理404（文件不存在）和403（无权限）
        if (response.status === 404) throw new Error(`文件不存在: ${path}`);
        if (response.status === 403) throw new Error(`无权限访问，可能需要登录或Token权限不足`);
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

/**
 * 批量获取文件的所有提交记录（自动分页查询）
 * @param {string} owner - 仓库所有者
 * @param {string} repo - 仓库名
 * @param {string[]} paths - 文件路径数组
 * @param {string} branch - 分支名
 * @param {string} [token] - GitHub Token（可选）
 * @param {number} [perPage=100] - 每页条数，默认100，最大500
 * @returns {Promise<Array>} 包含每个文件所有提交记录的数组
 */
async function batchGetFileCommits(owner, repo, paths, branch, token, perPage = 100) {
    // 限制分页大小在1-500之间
    const safePerPage = Math.max(1, Math.min(perPage, 500));
    
    // 处理每个文件的提交查询
    return Promise.all(paths.map(async (path) => {
        try {
            // 处理中文路径编码（按GitHub API要求）
            const encodedPath = path.split('/')
                .map(segment => encodeURIComponent(segment))
                .join('/');
            
            const allCommits = [];
            let page = 1;
            let hasMore = true;
            
            // 构建请求头
            const headers = {
                'Accept': 'application/json',
                'User-Agent': 'Blog-App' // GitHub API要求必须有User-Agent
            };
            
            // 如果有token，添加认证头
            if (token) {
                headers['Authorization'] = `token ${token}`;
            }
            
            // 分页查询所有提交记录
            while (hasMore) {
                const url = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodedPath}&ref=${branch}&per_page=${safePerPage}&page=${page}`;
                
                const response = await fetch(url, { headers });
                
                if (!response.ok) {
                    // 特殊处理404（文件不存在）和403（无权限）
                    if (response.status === 404) throw new Error(`文件不存在: ${path}`);
                    if (response.status === 403) throw new Error(`无权限访问，可能需要登录或Token权限不足`);
                    throw new Error(`获取提交记录失败: ${response.statusText}`);
                }
                
                const commits = await response.json();
                
                // 如果当前页没有数据，说明已到最后一页
                if (commits.length === 0) {
                    hasMore = false;
                    break;
                }
                
                // 添加到结果数组
                allCommits.push(...commits);
                
                // 检查是否还有更多页（通过响应头的Link判断）
                const linkHeader = response.headers.get('Link');
                hasMore = linkHeader?.includes('rel="next"') || false;
                
                page++;
            }
            
            return {
                path,
                commits: allCommits,
                total: allCommits.length,
                error: null
            };
        } catch (error) {
            return {
                path,
                commits: [],
                total: 0,
                error: error.message
            };
        }
    }));
}

// ==========================================================
// 你要的核心：FileChange 类（累积操作 → 一次提交）
// ==========================================================
class FileChange {
  /**
   * @param {Object} config
   * @param {string} config.owner
   * @param {string} config.repo
   * @param {string} config.branch
   * @param {string} config.token
   */
  constructor(config) {
    this.owner = config.owner;
    this.repo = config.repo;
    this.branch = config.branch;
    this.token = config.token;
    this.octokit = new Octokit({ auth: this.token });

    // 所有操作都存在这里
    this.upsert = [];   // 新增/修改
    this.remove = [];   // 删除
    this.rename = [];   // 重命名/移动
  }

  /**
   * 新增或修改文件
   * @param {string} path
   * @param {string} content
   */
  add(path, content) {
    this.upsert.push({ path, content });
  }

  /**
   * 删除文件
   * @param {string} path
   */
  delete(path) {
    this.remove.push({ path });
  }

  /**
   * 重命名 / 移动文件
   * @param {string} fromPath
   * @param {string} toPath
   */
  rename(fromPath, toPath) {
    this.rename.push({ from: fromPath, to: toPath });
  }

  // 别名：移动 = 重命名
  move(fromPath, toPath) {
    this.rename(fromPath, toPath);
  }

  /**
   * 一次性提交所有变更（只产生一次 commit + push）
   * @param {string} message - commit 信息
   */
  async commit(message) {
    try {
      // 1. 获取最新分支信息
      const { data: branchData } = await this.octokit.rest.repos.getBranch({
        owner: this.owner,
        repo: this.repo,
        branch: this.branch,
      });
      const latestCommitSha = branchData.commit.sha;
      const baseTreeSha = branchData.commit.commit.tree.sha;

      const tree = [];

      // 2. 加入新增/修改
      for (const f of this.upsert) {
        tree.push({
          path: f.path,
          mode: "100644",
          type: "blob",
          content: f.content,
        });
      }

      // 3. 加入删除
      for (const f of this.remove) {
        tree.push({
          path: f.path,
          mode: "100644",
          type: "blob",
          sha: null,
        });
      }

      // 4. 加入重命名/移动
      for (const op of this.rename) {
        const file = await this.#getFileContent(op.from);
        tree.push({ path: op.to, mode: "100644", type: "blob", content: file.content });
        tree.push({ path: op.from, mode: "100644", type: "blob", sha: null });
      }

      // 5. 创建新树
      const { data: newTree } = await this.octokit.rest.git.createTree({
        owner: this.owner,
        repo: this.repo,
        base_tree: baseTreeSha,
        tree,
      });

      // 6. 创建提交
      const { data: newCommit } = await this.octokit.rest.git.createCommit({
        owner: this.owner,
        repo: this.repo,
        message,
        tree: newTree.sha,
        parents: [latestCommitSha],
      });

      // 7. 推送（更新分支）
      await this.octokit.rest.git.updateRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${this.branch}`,
        sha: newCommit.sha,
      });

      console.log("✅ 提交成功！commit:", newCommit.sha);
      return { success: true, commitSha: newCommit.sha };
    } catch (err) {
      console.error("❌ 提交失败:", err);
      return { success: false, error: err.message };
    }
  }

  // 内部工具：获取文件内容（用于重命名/移动）
  async #getFileContent(path) {
    const { data: blob } = await this.octokit.rest.git.getBlob({
      owner: this.owner,
      repo: this.repo,
      path,
    });
    const content = atob(blob.content.replace(/\n/g, ""));
    return { content };
  }
}

export {
  Octokit,
  getFileCommits,
  getUserInfo,
  getRateLimit,
  batchGetFileCommits,
  FileChange       // 导出你要的类
};