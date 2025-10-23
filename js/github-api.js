import { Octokit } from "https://esm.sh/octokit";

/**
 * 使用GraphQL批量查询多个文件的最新提交信息（分页处理）
 * @param {string} owner - 仓库所有者
 * @param {string} repo - 仓库名
 * @param {string} branch - 分支名
 * @param {string[]} filePaths - 文件路径数组
 * @param {string} [token] - GitHub Token（可选）
 * @param {number} [batchSize=100] - 每批查询的文件数量
 * @returns {Promise<object>} 以文件路径为键的提交信息映射
 */
async function fetchFileCommitsViaGraphQL(owner, repo, branch, filePaths, token, batchSize = 100) {
    const octokit = token ? new Octokit({ auth: token }) : new Octokit();
    const commitMap = {};
    const totalFiles = filePaths.length;
    
    // 计算需要多少批次
    const totalBatches = Math.ceil(totalFiles / batchSize);
    console.log(`需要查询${totalBatches}批文件，每批${batchSize}个`);
    
    for (let batch = 0; batch < totalBatches; batch++) {
        // 计算当前批次的文件范围
        const startIndex = batch * batchSize;
        const endIndex = Math.min((batch + 1) * batchSize, totalFiles);
        const currentBatchPaths = filePaths.slice(startIndex, endIndex);
        console.log(`处理第${batch + 1}/${totalBatches}批，文件范围: ${startIndex}-${endIndex}`);
        
        // 构建GraphQL查询（动态生成多个文件的查询字段）
        const fileQueries = currentBatchPaths.map((path, index) => {
            // 为每个文件生成唯一的查询字段名
            const fieldName = `file_${batch}_${index}`;
            return `
                ${fieldName}: object(expression: "${branch}:${path}") {
                    ... on Blob {
                        id
                        commitUrl
                        latestCommit: history(first: 1) {
                            nodes {
                                author {
                                    name
                                }
                                committedDate
                                message
                            }
                        }
                    }
                }
            `;
        }).join('\n');
        
        // 完整的GraphQL查询
        const query = `
            query {
                repository(owner: "${owner}", name: "${repo}") {
                    ${fileQueries}
                }
            }
        `;
        
        try {
            // 执行GraphQL查询
            const { data } = await octokit.graphql(query);
            
            // 处理当前批次的查询结果
            currentBatchPaths.forEach((path, index) => {
                const fieldName = `file_${batch}_${index}`;
                const fileData = data.repository[fieldName];
                
                if (fileData && fileData.latestCommit && fileData.latestCommit.nodes.length > 0) {
                    const commit = fileData.latestCommit.nodes[0];
                    const date = new Date(commit.committedDate);
                    
                    commitMap[path] = {
                        lastModified: date.toLocaleString('zh-CN', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                        }),
                        commitAuthor: commit.author?.name || '未知作者',
                        commitMessage: commit.message || '无提交信息'
                    };
                } else {
                    console.warn(`未找到文件${path}的提交信息`);
                    commitMap[path] = {
                        lastModified: '未知时间',
                        commitAuthor: '未知作者',
                        commitMessage: '无提交信息'
                    };
                }
            });
            
        } catch (err) {
            console.error(`第${batch + 1}批查询失败:`, err);
            // 为当前批次的文件设置默认值
            currentBatchPaths.forEach(path => {
                commitMap[path] = {
                    lastModified: '查询失败',
                    commitAuthor: '未知作者',
                    commitMessage: '获取提交信息失败'
                };
            });
        }
    }
    
    return commitMap;
}

/**
 * 获取当前认证用户的信息
 * @param {string} token - GitHub Token
 * @returns {Promise<Object>} 用户信息对象
 */
async function getUserInfo(token) {
    try {
        const octokit = new Octokit({ auth: token });
        const { data } = await octokit.rest.users.getAuthenticated();
        return data;
    } catch (err) {
        let errorMsg = `获取用户信息失败: ${err.message}`;
        if (err.response?.data?.message) {
            errorMsg += `, 原因: ${err.response.data.message}`;
        }
        throw new Error(errorMsg);
    }
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

export {
    fetchFileCommitsViaGraphQL,
    getUserInfo,
    getRateLimit
};