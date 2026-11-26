// 全站共享的可变状态。拆分模块后只在这里声明一次，
// 其它模块通过 state.xxx 读写（不要解构 state，否则会拿到快照、丢失引用）。

const DEFAULT_FAVICON = 'assets/images/favicon.svg';

export const config = {
    // 本地开发时使用默认值，生产环境从 hostname 获取
    owner: window.location.hostname.includes('.github.io') ? window.location.hostname.split('.github.io')[0] : 'hugill-8121',
    repo: window.location.hostname.includes('.github.io') ? window.location.hostname : 'hugill-8121.github.io',
    branch: 'main'
};

export const state = {
    // 首页数据
    allBlogs: [],
    allTags: new Set(),
    blogConfigData: null,   // 首页加载过一次的配置，编辑页分组/新建目录复用，避免重复拉取
    currentBlog: null,
    selectedTags: new Set(), // 标签云多选：命中任一选中标签即可
    selectedMonths: new Set(),
    globalCommitMap: new Map(), // 全局 commit 信息缓存 {path: commitInfo}
    blogContentCache: new Map(), // 文章正文缓存：首次进入并发预取一次

    // 编辑区
    openTabs: [],
    activeTabId: null,
    currentEditFile: null,
    editedContents: new Map(),   // 标签页当前内容 {tabId: content}
    originalContents: new Map(), // 标签页打开时的原始内容 {tabId: content}
    dirtyTabs: new Set(),        // 有未保存修改的标签页
    editorTags: [],

    // 待提交队列（延迟提交模型：先登记，保存文章或点“提交资源”时一次提交）
    pendingResourceFiles: new Map(),   // key: 仓库路径, value: { name, content(Base64) }
    pendingResourceFolders: new Map(), // key: 仓库路径, value: { name }
    pendingResourceMoves: new Map(),   // key: 原路径, value: { path, sha, size }
    pendingResourceDeletes: new Map(), // key: 远端路径, value: { name, size, sha }
    pendingVisibility: new Map(),      // key: 文章路径, value: 目标 hidden

    // 仓库树 / 资源栏
    resourceTreeLoaded: false,
    resourceRemotePaths: [],       // [{ path, type }]，一次递归取树后的缓存
    blogFolderPaths: [],           // blog 目录下已有的子文件夹（来自同一次取树）
    resourceUploadTarget: 'media', // 资源上传目标文件夹
    repoTreeState: { items: null, loadedAt: 0 },
    resourceDragState: null,       // { path, pending, moved }

    siteFavicon: DEFAULT_FAVICON,  // 站点图标，loadBlogSettings 读到 web_icon 后更新
    siteProfile: null,             // 底部个人介绍栏内容（blog-config.json 的 profile 字段）
};
