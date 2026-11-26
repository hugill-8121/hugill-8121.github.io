// 页面入口：只负责启动编排，业务逻辑都在同目录下的各个模块里。
// index.html 只保留 <script type="module" src="./assets/js/app/main.js">。

import { config, state } from './state.js';
import { dom } from './dom.js';
import { getUrlParams, setPageFavicon } from './utils.js';
import { checkLoginStatus } from './auth.js';
import { initBlog, loadBlogSettings } from './list.js';
import { showBlogByIdentity, showFreshBlogFromUrl } from './show.js';
import { refreshResourceUploadFolders } from './resource-queue.js';
import { bindNavEvents } from './events-nav.js';
import { bindEditorEvents } from './events-editor.js';
import { bindResourceEvents } from './events-resource.js';

console.log('GitHub 配置:', config);

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    // 先挂上站点图标，配置加载后按 web_icon 更新，登录校验成功后再换成用户头像
    setPageFavicon(state.siteFavicon);
    try {
        await loadBlogSettings();
        await checkLoginStatus();
        await initBlog();

        const params = getUrlParams();
        if (params.opera === 'blog-show' && params.fresh === '1' && params.path) {
            // 刚保存的文章会在新标签页以 fresh=1 打开：Pages 重新构建有延迟，
            // 这里用 URL 里的元信息 + GitHub API 读最新正文，不依赖静态文件
            await showFreshBlogFromUrl();
        } else if (params.opera === 'blog-show' && (params.blog || params.uuid)) {
            // 如果 URL 参数指定了博客，进入博客详情页
            await showBlogByIdentity({ title: params.blog, uuid: params.uuid });
        }

        bindNavEvents();
        bindEditorEvents();
        bindResourceEvents();
        refreshResourceUploadFolders();
    } catch (error) {
        console.error('初始化失败:', error);
        dom.loadingEl.innerHTML = `<p style="color: red;">加载失败: ${error.message}</p>`;
    }
});
