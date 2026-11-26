// 顶部导航、登录菜单、API 限额弹窗、时间筛选等事件绑定。

import { state } from './state.js';
import { dom } from './dom.js';
import { getGithubToken, safeSetStorage, showToast } from './utils.js';
import { applyLoggedInUI, handleAuthFailure, updateLoginState } from './auth.js';
import { initBlog, renderBlogs, renderMonthList } from './list.js';
import { openFileInTab, openNewBlogMode } from './editor.js';
import { createBlogFolder } from './file-tree.js';
import { renderResourceTree } from './resource-tree.js';
import { getRateLimit, getUserInfo, getUserInfoWithMeta, isAuthError, sanitizeToken } from '../github-api.js';

// 隐藏右键菜单
document.addEventListener('click', () => {
    if (dom.fileContextMenu) {
        dom.fileContextMenu.style.display = 'none';
    }
    if (dom.resourceContextMenu) {
        dom.resourceContextMenu.style.display = 'none';
    }
});

export function bindNavEvents() {
    // 容器切换事件
    dom.backToList.addEventListener('click', () => {
        // 修改URL
        window.history.pushState({}, '', window.location.pathname);
        // 切换到列表容器，显示左侧时间过滤器
        dom.containers.list.classList.add('container-active');
        dom.containers.list.classList.remove('container-hidden');
        dom.containers.show.classList.add('container-hidden');
        dom.containers.show.classList.remove('container-active');
        dom.containers.edit.classList.add('container-hidden');
        dom.containers.edit.classList.remove('container-active');
        // 显示左侧时间过滤器
        document.querySelector('.sidebar-left').style.display = 'block';
    });
    dom.editCurrentBlog.addEventListener('click', () => {
        if (state.currentBlog) openFileInTab(state.currentBlog);
    });
    // 登录相关事件
    dom.avatarBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.loginMenu.classList.toggle('show');
    });

    document.addEventListener('click', () => {
        dom.loginMenu.classList.remove('show');
    });

    dom.loginItem.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.loginForm.style.display = dom.loginForm.style.display === 'none' ? 'block' : 'none';
    });

    // 防止登录表单点击时关闭菜单
    dom.loginForm.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    dom.logoutItem.addEventListener('click', () => {
        updateLoginState(false);
    });

    dom.refreshItem.addEventListener('click', async () => {
        dom.refreshItem.classList.add('disabled');
        await initBlog();
        dom.refreshItem.classList.remove('disabled');
        dom.loginMenu.classList.remove('show');
    });

    dom.apiStatusItem.addEventListener('click', async () => {
        try {
            let token = getGithubToken();
            let loginName = '未登录（匿名限额）';
            let scopesText = '匿名请求（无 Token）';

            if (token) {
                try {
                    const { user, headers } = await getUserInfoWithMeta(token);
                    loginName = user.login;
                    const scopes = String(headers['x-oauth-scopes'] || '').trim();
                    scopesText = scopes || '空（细粒度 Token 请在 GitHub 设置中查看）';
                } catch (error) {
                    if (!isAuthError(error)) throw error;
                    handleAuthFailure('GitHub Token 已失效（Bad credentials），已切换为匿名查询限额。');
                    token = '';
                }
            }

            const rateLimit = await getRateLimit(token);

            document.getElementById('modal-user-login').textContent = loginName;
            document.getElementById('modal-oauth-scopes').textContent = scopesText;
            document.getElementById('modal-core-remaining').textContent = rateLimit.resources.core.remaining;
            document.getElementById('modal-core-limit').textContent = rateLimit.resources.core.limit;
            document.getElementById('modal-core-reset').textContent = new Date(rateLimit.resources.core.reset * 1000).toLocaleString();
            document.getElementById('modal-search-remaining').textContent = rateLimit.resources.search.remaining;
            document.getElementById('modal-search-limit').textContent = rateLimit.resources.search.limit;
            document.getElementById('modal-search-reset').textContent = new Date(rateLimit.resources.search.reset * 1000).toLocaleString();
            document.getElementById('modal-graphql-remaining').textContent = rateLimit.resources.graphql.remaining;
            document.getElementById('modal-graphql-limit').textContent = rateLimit.resources.graphql.limit;

            dom.apiStatusModal.style.display = 'flex';
        } catch (error) {
            alert('获取API状态失败: ' + error.message);
        }
    });

    dom.submitLoginBtn.addEventListener('click', async () => {
        const token = sanitizeToken(dom.githubTokenInput.value);
        if (!token) {
            dom.githubTokenInput.focus();
            return;
        }

        dom.submitLoginBtn.disabled = true;
        try {
            // 先校验再落库，避免把带换行/失效的 Token 存进 localStorage 后到处 401
            const user = await getUserInfo(token);
            safeSetStorage('github-token', token);
            dom.githubTokenInput.value = token;
            applyLoggedInUI(user);
            dom.loginMenu.classList.remove('show');
            state.resourceTreeLoaded = false;
            renderResourceTree();
            showToast(`已登录：${user.login}`);
        } catch (error) {
            const message = isAuthError(error)
                ? 'Token 无效或已失效（Bad credentials），请确认复制完整且未带空格/换行'
                : `校验 Token 失败: ${error.message}`;
            alert(message);
        } finally {
            dom.submitLoginBtn.disabled = false;
        }
    });

    // 新增blog事件
    dom.addBlogItem.addEventListener('click', (e) => {
        e.stopPropagation();
        const token = getGithubToken();
        if (!token) {
            alert('请先登录后再新增blog');
            return;
        }
        // 打开新增模式
        openNewBlogMode();
        dom.loginMenu.classList.remove('show');
    });

    // 时间过滤器事件
    dom.applyDateFilter.addEventListener('click', () => {
        renderBlogs();
    });

    dom.resetDateFilter.addEventListener('click', () => {
        dom.dateStart.value = '';
        dom.dateEnd.value = '';
        state.selectedMonths.clear();
        renderMonthList();
        renderBlogs();
    });

    // 关闭模态框
    dom.closeModalBtn.addEventListener('click', () => {
        dom.apiStatusModal.style.display = 'none';
    });

    // 点击弹窗背景关闭
    dom.apiStatusModal.addEventListener('click', (e) => {
        if (e.target === dom.apiStatusModal) {
            dom.apiStatusModal.style.display = 'none';
        }
    });

    // ESC键关闭弹窗
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dom.apiStatusModal.style.display === 'flex') {
            dom.apiStatusModal.style.display = 'none';
        }
    });
    // 左侧文件栏：在 blog 根目录下新建文件夹
    dom.newBlogFolderBtn.addEventListener('click', () => {
        createBlogFolder();
    });
}
