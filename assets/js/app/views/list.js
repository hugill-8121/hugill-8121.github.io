// 首页列表：配置加载、commit 信息缓存、标签云、月份筛选、文章卡片。

import { config, state } from '../core/state.js';
import { dom } from '../core/dom.js';
import { getGithubToken, setPageFavicon } from '../core/utils.js';
import { loadRepoTreeOnce } from '../data/repo-tree.js';
import { batchGetFileCommits } from '../../lib/github-api.js';
import { renderSiteFooter } from './footer.js';

// 加载博客配置
export async function loadBlogSettings() {
    try {
        const response = await fetch(`blog-config.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('配置文件加载失败');
        const cfg = await response.json();

        // 设置浏览器标签名
        if (cfg.browser_tag) {
            document.title = cfg.browser_tag;
        }

        // 设置页首大标题
        if (cfg.web_title) {
            document.getElementById('blog-title').textContent = cfg.web_title;
        }

        // 设置介绍
        if (cfg.web_introduction) {
            document.getElementById('blog-intro').textContent = cfg.web_introduction;
        }

        // 设置站点标签页图标（web_icon 为相对仓库根的图标路径）
        if (cfg.web_icon && String(cfg.web_icon).trim()) {
            state.siteFavicon = String(cfg.web_icon).trim();
            setPageFavicon(state.siteFavicon);
        }

        // 底部个人介绍栏：内容取自 profile 字段，没配就保持隐藏
        state.siteProfile = (cfg.profile && typeof cfg.profile === 'object') ? cfg.profile : null;
        renderSiteFooter();
    } catch (err) {
        console.warn('加载博客配置失败，使用默认值:', err);
        // 使用默认值
        document.title = '技术博客';
        document.getElementById('blog-title').textContent = '技术博客';
        document.getElementById('blog-intro').textContent = '技术分享博客';
    }
}

// 博客正文缓存：首次进入时并发预取一次，之后打开/切换标签都直接命中

async function prefetchBlogContents() {
    const queue = state.allBlogs.filter(blog => blog.path && !state.blogContentCache.has(blog.path));
    if (queue.length === 0) return;
    const worker = async () => {
        while (queue.length > 0) {
            const blog = queue.shift();
            if (state.blogContentCache.has(blog.path)) continue;
            try {
                const res = await fetch(`${blog.path}?t=${Date.now()}`, { cache: 'no-store' });
                if (res.ok) {
                    state.blogContentCache.set(blog.path, (await res.text()).replace(/\r\n?/g, '\n'));
                }
            } catch (error) {
                console.warn('预取博客正文失败:', blog.path, error);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
}

// 初始化博客内容
export async function initBlog() {
    try {
        const response = await fetch(`blog-config.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('配置文件加载失败');
        
        const blogConfig = await response.json();
        state.blogConfigData = blogConfig;
        await processBlogData(blogConfig);
        dom.loadingEl.style.display = 'none';
    } catch (error) {
        console.error('初始化失败:', error);
        dom.loadingEl.innerHTML = `<p style="color: red;">加载失败: ${error.message}</p>`;
    }
}

// 处理博客数据
async function processBlogData(cfg) {
    state.allBlogs = [];
    state.allTags.clear();
    state.globalCommitMap.clear();

    // 适配配置文件格式，博客数据在 blogs 字段下
    const blogs = cfg.blogs || cfg;

    Object.keys(blogs).forEach(group => {
        const groupBlogs = blogs[group];
        // 确保分组数据是数组
        if (Array.isArray(groupBlogs)) {
            groupBlogs.forEach(blog => {
                blog.group = group;
                blog.uuid = blog.blog_uuid || blog.uuid; // 兼容不同字段名
                blog.filePath = blog.path; // 兼容现有配置
                state.allBlogs.push(blog);
                if (!blog.hidden && Array.isArray(blog.tags)) {
                    blog.tags.forEach(tag => state.allTags.add(tag));
                }
            });
        } else {
            console.warn(`分组 "${group}" 的数据不是数组:`, groupBlogs);
        }
    });

    // 先显示博客列表（不包含commit信息）
    renderTags();
    renderMonthList();
    renderBlogs();

    // 首次进入时一次性预取：博客正文（纯静态文件，不消耗 API）；
    // 仓库树只在已登录时预取，避免匿名用户宝贵的 60 次/小时额度被首页消耗
    prefetchBlogContents();
    if (getGithubToken()) {
        loadRepoTreeOnce().catch(err => console.warn('预取仓库树失败:', err));
    }

    // 异步加载commit信息
    loadCommitsAsync();
}

// 提交信息本地缓存（GitHub API 限流/断网时仍能显示时间筛选）
const COMMIT_CACHE_KEY = 'blog-commit-cache-v1';

const COMMIT_CACHE_TTL = 30 * 60 * 1000;

let commitLoadFailed = false;

function readCommitCache() {
    try {
        const data = JSON.parse(localStorage.getItem(COMMIT_CACHE_KEY) || 'null');
        if (!data || !data.entries || !data.ts) return null;
        return data;
    } catch (e) {
        return null;
    }
}

function writeCommitCache() {
    try {
        const entries = {};
        state.globalCommitMap.forEach((info, path) => {
            entries[path] = {
                sha: info.sha,
                date: info.date.toISOString(),
                author: info.author,
                message: info.message
            };
        });
        localStorage.setItem(COMMIT_CACHE_KEY, JSON.stringify({ ts: Date.now(), entries }));
    } catch (e) {
        console.warn('写入提交缓存失败:', e);
    }
}

function applyCommitInfo(path, info) {
    state.globalCommitMap.set(path, info);
    const blog = state.allBlogs.find(b => b.path === path);
    if (blog) {
        blog.lastModified = info.date;
        blog.committer = info.author;
        blog.commitMessage = info.message;
    }
}

function applyCommitCache() {
    const cache = readCommitCache();
    if (!cache) return false;
    let applied = 0;
    Object.entries(cache.entries).forEach(([path, info]) => {
        if (!state.globalCommitMap.has(path)) {
            applyCommitInfo(path, {
                sha: info.sha,
                date: new Date(info.date),
                author: info.author,
                message: info.message
            });
            applied += 1;
        }
    });
    return applied > 0;
}

// 异步加载commit信息
async function loadCommitsAsync() {
    const filePaths = state.allBlogs.map(blog => blog.path);
    const totalFiles = filePaths.length;
    commitLoadFailed = false;

    // 先用缓存渲染一次，网络慢或限流时时间筛选也能用
    if (applyCommitCache()) {
        renderMonthList();
        renderBlogs();
    }

    if (totalFiles === 0) return;

    // 显示加载状态
    const loadingIndicator = document.createElement('div');
    loadingIndicator.id = 'commit-loading';
    loadingIndicator.className = 'loading';
    loadingIndicator.innerHTML = `<small><i class="fa fa-spinner fa-spin"></i> 正在加载提交信息... (0/${totalFiles})</small>`;
    loadingIndicator.style.padding = '10px';
    loadingIndicator.style.color = '#6b7280';
    loadingIndicator.style.fontSize = '0.9rem';
    dom.blogContainer.insertBefore(loadingIndicator, dom.blogContainer.firstChild);

    let batchResults = [];
    try {
        batchResults = await batchGetFileCommits(
            config.owner,
            config.repo,
            filePaths,
            config.branch,
            getGithubToken(),
            100,
            (processed) => {
                const indicator = document.getElementById('commit-loading');
                if (indicator) {
                    indicator.innerHTML = `<small><i class="fa fa-spinner fa-spin"></i> 正在加载提交信息... (${processed}/${totalFiles})</small>`;
                }
            }
        );
    } catch (error) {
        console.warn('批量获取提交信息失败:', error);
        commitLoadFailed = true;
    }

    // 处理commit结果
    let successCount = 0;
    (batchResults || []).forEach(item => {
        if (!item.error && item.commits.length > 0) {
            const commit = item.commits[0];
            applyCommitInfo(item.path, {
                sha: commit.sha,
                date: new Date(commit.commit.committer.date),
                author: commit.commit.committer.name || commit.author?.login || '未知',
                message: commit.commit.message.split('\n')[0]
            });
            successCount += 1;
        } else {
            console.warn('获取commit失败:', item.path, item.error);
        }
    });

    if (successCount > 0) {
        writeCommitCache();
    } else {
        commitLoadFailed = true;
    }

    // 移除加载指示器，重新渲染
    const indicator = document.getElementById('commit-loading');
    if (indicator) {
        indicator.remove();
    }
    renderTags();
    renderMonthList();
    renderBlogs();
    updateCommitFailureHint();
}

function updateCommitFailureHint() {
    const el = document.getElementById('commit-failure-hint');
    if (!commitLoadFailed || state.globalCommitMap.size > 0) {
        if (el) el.remove();
        return;
    }
    if (el) return;
    const hint = document.createElement('div');
    hint.id = 'commit-failure-hint';
    hint.style.cssText = 'padding:8px 10px;margin:6px 0;border-radius:6px;background:#fef3c7;color:#92400e;font-size:12px;';
    hint.textContent = '提交信息暂时无法获取（GitHub API 限流或网络异常），时间筛选不可用；博客列表仍可正常浏览。';
    dom.blogContainer.insertBefore(hint, dom.blogContainer.firstChild);
}

// 渲染标签云（支持多选，选中多个标签时取并集）
export function renderTags() {
    if (!dom.tagsContainer) return;

    // 清理已不存在的标签，避免文章改标签后筛选永远为空
    Array.from(state.selectedTags).forEach(tag => {
        if (!state.allTags.has(tag)) state.selectedTags.delete(tag);
    });

    dom.tagsContainer.innerHTML = '';

    const allTagEl = document.createElement('span');
    allTagEl.className = 'tag' + (state.selectedTags.size === 0 ? ' active' : '');
    allTagEl.textContent = '全部';
    allTagEl.addEventListener('click', () => {
        state.selectedTags.clear();
        renderTags();
        renderBlogs();
    });
    dom.tagsContainer.appendChild(allTagEl);

    Array.from(state.allTags).forEach(tag => {
        const tagEl = document.createElement('span');
        tagEl.className = 'tag' + (state.selectedTags.has(tag) ? ' active' : '');
        tagEl.textContent = tag;
        tagEl.title = '点击切换筛选';

        tagEl.addEventListener('click', () => {
            if (state.selectedTags.has(tag)) {
                state.selectedTags.delete(tag);
            } else {
                state.selectedTags.add(tag);
            }
            renderTags();
            renderBlogs();
        });

        dom.tagsContainer.appendChild(tagEl);
    });
}

// 渲染博客卡片
export function renderBlogs() {
    if (!dom.blogContainer) return;

    dom.blogContainer.innerHTML = '';

    // 先排除主页隐藏的文章，再应用标签过滤（多选：命中任一选中标签即可，与月份多选保持一致）
    let filteredBlogs = state.allBlogs.filter(blog => !blog.hidden);
    filteredBlogs = state.selectedTags.size > 0
        ? filteredBlogs.filter(blog => (blog.tags || []).some(tag => state.selectedTags.has(tag)))
        : filteredBlogs;

    // 应用月份过滤
    if (state.selectedMonths.size > 0) {
        filteredBlogs = filteredBlogs.filter(blog => {
            if (!blog.lastModified) return false;
            const monthKey = getMonthKey(blog.lastModified);
            return state.selectedMonths.has(monthKey);
        });
    }

    // 应用日期范围过滤
    if (dom.dateStart.value || dom.dateEnd.value) {
        filteredBlogs = filteredBlogs.filter(blog => {
            if (!blog.lastModified) return false;
            const blogDate = new Date(blog.lastModified);
            const blogMonth = getMonthKey(blogDate);

            if (dom.dateStart.value && blogMonth < dom.dateStart.value) {
                return false;
            }
            if (dom.dateEnd.value && blogMonth > dom.dateEnd.value) {
                return false;
            }
            return true;
        });
    }

    if (filteredBlogs.length === 0) {
        dom.noResultsEl.style.display = 'block';
        return;
    } else {
        dom.noResultsEl.style.display = 'none';
    }

    const blogsByCategory = {};
    filteredBlogs.forEach(blog => {
        if (!blogsByCategory[blog.group]) {
            blogsByCategory[blog.group] = [];
        }
        blogsByCategory[blog.group].push(blog);
    });

    Object.keys(blogsByCategory).forEach(categoryName => {
        const categorySection = document.createElement('section');
        categorySection.className = 'category-section';

        const categoryHeader = document.createElement('h2');
        categoryHeader.className = 'category-title';
        categoryHeader.textContent = categoryName;
        categorySection.appendChild(categoryHeader);

        const cardsContainer = document.createElement('div');
        cardsContainer.className = 'cards-container';

        blogsByCategory[categoryName].forEach(article => {
            cardsContainer.appendChild(createBlogCard(article));
        });

        categorySection.appendChild(cardsContainer);
        dom.blogContainer.appendChild(categorySection);
    });
}

// 获取月份键 (格式: YYYY-MM)
function getMonthKey(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 渲染月份列表
export function renderMonthList() {
    if (!dom.monthList) return;

    console.log('渲染月份列表，allBlogs数量:', state.allBlogs.length);
    console.log('allBlogs:', state.allBlogs);

    // 统计每个月的博客数量（主页隐藏的文章不计入月份筛选）
    const monthStats = new Map();
    state.allBlogs.forEach(blog => {
        if (blog.hidden) return;
        if (blog.lastModified) {
            const monthKey = getMonthKey(blog.lastModified);
            monthStats.set(monthKey, (monthStats.get(monthKey) || 0) + 1);
        } else {
            console.warn('博客没有lastModified:', blog.title, blog.path);
        }
    });

    console.log('月份统计:', monthStats);

    // 按月份降序排序
    const sortedMonths = Array.from(monthStats.keys()).sort((a, b) => b.localeCompare(a));

    dom.monthList.innerHTML = '';

    if (sortedMonths.length === 0) {
        dom.monthList.innerHTML = commitLoadFailed
            ? '<div style="color: #9ca3af; font-size: 0.9rem; padding: 0.5rem;">提交信息获取失败，时间筛选暂不可用</div>'
            : '<div style="color: #9ca3af; font-size: 0.9rem; padding: 0.5rem;">暂无数据</div>';
        return;
    }

    sortedMonths.forEach(month => {
        const monthItem = document.createElement('div');
        monthItem.className = 'month-item';
        if (state.selectedMonths.has(month)) {
            monthItem.classList.add('active');
        }

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'month-checkbox';
        checkbox.checked = state.selectedMonths.has(month);
        checkbox.addEventListener('change', (e) => {
            if (e.target.checked) {
                state.selectedMonths.add(month);
            } else {
                state.selectedMonths.delete(month);
            }
            renderMonthList();
            renderBlogs();
        });

        const label = document.createElement('span');
        label.className = 'month-label';
        label.textContent = formatMonth(month);

        const count = document.createElement('span');
        count.className = 'month-count';
        count.textContent = monthStats.get(month);

        monthItem.appendChild(checkbox);
        monthItem.appendChild(label);
        monthItem.appendChild(count);

        // 点击整行切换选择
        monthItem.addEventListener('click', (e) => {
            if (e.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event('change'));
            }
        });

        dom.monthList.appendChild(monthItem);
    });
}

// 格式化月份显示
function formatMonth(month) {
    const [year, monthNum] = month.split('-');
    return `${year}年${parseInt(monthNum)}月`;
}

// 截断文本工具函数
function truncateText(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
}

// 检查文本是否适合一行显示
function isTextTooLong(text, maxLength) {
    if (!text) return false;
    return text.length > maxLength;
}

// 创建博客卡片
function createBlogCard(article) {
    const card = document.createElement('div');
    card.className = 'blog-card';

    const cardTitle = document.createElement('h3');
    cardTitle.className = 'card-title';
    cardTitle.textContent = article.title;
    card.appendChild(cardTitle);

    const cardTags = document.createElement('div');
    cardTags.className = 'card-tags';
    article.tags.forEach(tag => {
        const tagSpan = document.createElement('span');
        tagSpan.className = 'card-tag';
        tagSpan.textContent = tag;
        cardTags.appendChild(tagSpan);
    });
    card.appendChild(cardTags);

    // 卡片底部信息区：三行显示
    const cardFooter = document.createElement('div');
    cardFooter.className = 'card-footer';

    // 第1行：更新人
    const committerRow = document.createElement('div');
    committerRow.className = 'footer-row';
    const committerLabel = document.createElement('span');
    committerLabel.className = 'footer-label';
    committerLabel.textContent = '更新人:';
    const committerValue = document.createElement('span');
    committerValue.className = 'footer-value';
    committerValue.textContent = article.committer || '未知';
    committerRow.appendChild(committerLabel);
    committerRow.appendChild(committerValue);
    cardFooter.appendChild(committerRow);

    // 第2行：更新时间
    const timeRow = document.createElement('div');
    timeRow.className = 'footer-row';
    const timeLabel = document.createElement('span');
    timeLabel.className = 'footer-label';
    timeLabel.textContent = '更新时间:';
    const timeValue = document.createElement('span');
    timeValue.className = 'footer-value';
    timeValue.textContent = article.lastModified
        ? article.lastModified.toLocaleString()
        : '暂无';
    timeRow.appendChild(timeLabel);
    timeRow.appendChild(timeValue);
    cardFooter.appendChild(timeRow);

    // 第3行：更新commit信息（仅显示一行，过长则忽略）
    if (article.commitMessage && article.commitMessage.length <= 60) {
        const messageRow = document.createElement('div');
        messageRow.className = 'footer-row';
        const messageLabel = document.createElement('span');
        messageLabel.className = 'footer-label';
        messageLabel.textContent = 'commit:';
        const messageValue = document.createElement('span');
        messageValue.className = 'footer-value commit-msg';
        messageValue.textContent = article.commitMessage;
        messageRow.appendChild(messageLabel);
        messageRow.appendChild(messageValue);
        cardFooter.appendChild(messageRow);
    }

    card.appendChild(cardFooter);

    // 点击卡片进入查看模式（uuid 为主，title 兼容旧链接）
    card.addEventListener('click', () => {
        const params = new URLSearchParams({ opera: 'blog-show' });
        if (article.uuid || article.blog_uuid) {
            params.set('uuid', String(article.uuid ?? article.blog_uuid));
        } else {
            params.set('blog', article.title);
        }
        window.location.href = `?${params.toString()}`;
    });

    return card;
}
