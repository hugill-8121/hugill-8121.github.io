// 登录态：校验 Token、登录/登出 UI、Token 失效降级为匿名浏览。

import { state } from './state.js';
import { dom } from './dom.js';
import { getGithubToken, safeClearToken, setFaviconToAvatar, setPageFavicon, showToast } from './utils.js';
import { renderResourceTree } from '../views/resource-tree.js';
import { getUserInfo, isAuthError } from '../../lib/github-api.js';

// Token 失效：清掉本地缓存，降级为匿名读取（公开仓库只读无需 Token）
export function handleAuthFailure(message) {
    safeClearToken();
    updateLoginState(false);
    showToast(message || 'GitHub Token 已失效，已切换为匿名浏览；保存/上传等写操作需要重新登录。', true);
}

// 检查登录状态：先拿 Token 校验一次，失效则自动降级为匿名浏览
export async function checkLoginStatus() {
    const token = getGithubToken();
    if (!token) {
        applyLoggedOutUI();
        return false;
    }
    try {
        const user = await getUserInfo(token);
        dom.githubTokenInput.value = token;
        applyLoggedInUI(user);
        return true;
    } catch (err) {
        if (isAuthError(err)) {
            handleAuthFailure('本地保存的 GitHub Token 已失效（Bad credentials），已切换为匿名浏览；保存/上传请重新登录。');
        } else {
            console.warn('校验 Token 失败:', err);
        }
        return false;
    }
}

export function applyLoggedInUI(user) {
    dom.loginItem.style.display = 'none';
    dom.loginForm.style.display = 'none';
    dom.logoutItem.classList.remove('disabled');
    dom.refreshItem.classList.remove('disabled');
    dom.apiStatusItem.classList.remove('disabled');
    if (user) {
        dom.usernameDisplay.textContent = user.login;
        dom.usernameDisplay.style.display = 'inline';
        dom.avatarImg.src = user.avatar_url;
        dom.avatarImg.style.display = 'block';
        dom.defaultAvatar.style.display = 'none';
        // 标签页图标换成登录用户的头像
        setFaviconToAvatar(user.avatar_url);
    }
}

function applyLoggedOutUI() {
    dom.githubTokenInput.value = '';
    dom.loginItem.style.display = 'flex';
    dom.logoutItem.classList.add('disabled');
    dom.refreshItem.classList.add('disabled');
    dom.apiStatusItem.classList.remove('disabled'); // 未登录也能查询匿名限额
    dom.usernameDisplay.style.display = 'none';
    dom.usernameDisplay.textContent = '';
    dom.avatarImg.src = '';
    dom.avatarImg.style.display = 'none';
    dom.defaultAvatar.style.display = 'block';
    // 退出登录后标签页图标回到站点图标
    setPageFavicon(state.siteFavicon);
}

// 更新登录状态
export function updateLoginState(isLoggedIn, options = {}) {
    const refreshTree = options.refreshTree !== false;
    if (isLoggedIn) {
        applyLoggedInUI(null);
        getUserInfo(getGithubToken())
            .then(user => applyLoggedInUI(user))
            .catch(err => {
                if (isAuthError(err)) handleAuthFailure();
                else console.error('获取用户信息失败:', err);
            });
    } else {
        safeClearToken();
        applyLoggedOutUI();
        // 退出后资源树降级为匿名只读（公开仓库无需 Token 也能浏览）
        state.resourceTreeLoaded = false;
        if (refreshTree) renderResourceTree();
    }
}
