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
    // 初始化Octokit（带调试日志）
    const octokit = token ? new Octokit({ 
        auth: token,
        log: {
            debug: (message) => console.debug(`[GraphQL Debug] ${message}`),
            info: (message) => console.info(`[GraphQL Info] ${message}`),
            warn: (message) => console.warn(`[GraphQL Warn] ${message}`),
            error: (message) => console.error(`[GraphQL Error] ${message}`)
        }
    }) : new Octokit();
    
    const commitMap = {};
    const totalFiles = filePaths.length;
    
    console.log(`[GraphQL] 开始查询 ${totalFiles} 个文件，分 ${Math.ceil(totalFiles / batchSize)} 批`);
    
    for (let batch = 0; batch < Math.ceil(totalFiles / batchSize); batch++) {
        const startIndex = batch * batchSize;
        const endIndex = Math.min((batch + 1) * batchSize, totalFiles);
        const currentBatchPaths = filePaths.slice(startIndex, endIndex);
        
        console.log(`[GraphQL] 处理第 ${batch + 1} 批: 文件 ${startIndex}-${endIndex}`);
        console.log(`[GraphQL] 当前批文件路径:`, currentBatchPaths);
        
        // 构建GraphQL查询（动态生成字段）
        const fileQueries = currentBatchPaths.map((path, index) => {
            const fieldName = `file_${batch}_${index}`;
            // 处理路径中的特殊字符（如空格、中文）
            const safePath = path.replace(/"/g, '\\"'); // 转义双引号
            return `
                ${fieldName}: object(expression: "${branch}:${safePath}") {
                    ... on Blob {
                        id
                        latestCommit: history(first: 1) {
                            nodes {
                                author {
                                    name
                                }
                                committedDate
                                message
                                oid # 提交ID，用于调试
                            }
                        }
                    }
                }
            `;
        }).join('\n');
        
        const query = `
            query {
                repository(owner: "${owner}", name: "${repo}") {
                    ${fileQueries}
                }
            }
        `;
        
        console.log(`[GraphQL] 第 ${batch + 1} 批查询语句:`, query);
        
        try {
            const { data } = await octokit.graphql(query);
            console.log(`[GraphQL] 第 ${batch + 1} 批查询结果:`, data);
            
            // 处理当前批次结果
            currentBatchPaths.forEach((path, index) => {
                const fieldName = `file_${batch}_${index}`;
                const fileData = data.repository?.[fieldName];
                
                if (!fileData) {
                    console.warn(`[GraphQL] 未找到文件 ${path} 的数据`);
                    commitMap[path] = {
                        lastModified: '未知时间',
                        commitAuthor: '未知作者',
                        commitMessage: '未找到文件数据'
                    };
                    return;
                }
                
                if (!fileData.latestCommit || fileData.latestCommit.nodes.length === 0) {
                    console.warn(`[GraphQL] 文件 ${path} 无提交记录`);
                    commitMap[path] = {
                        lastModified: '未知时间',
                        commitAuthor: '未知作者',
                        commitMessage: '无提交记录'
                    };
                    return;
                }
                
                // 提取有效数据
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
                    commitMessage: commit.message || '无提交信息',
                    commitId: commit.oid // 提交ID，用于调试
                };
                console.log(`[GraphQL] 文件 ${path} 解析成功:`, commitMap[path]);
            });
            
        } catch (err) {
            console.error(`[GraphQL] 第 ${batch + 1} 批查询失败:`, err);
            // 记录错误详情
            currentBatchPaths.forEach(path => {
                commitMap[path] = {
                    lastModified: '查询失败',
                    commitAuthor: '未知作者',
                    commitMessage: `API错误: ${err.message.substring(0, 30)}...`
                };
            });
        }
    }
    
    console.log(`[GraphQL] 所有批次查询完成，结果总数: ${Object.keys(commitMap).length}`);
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