/**
 * 博客工具函数
 * 包含容器切换、Markdown 渲染等通用功能
 */

// 容器切换函数
export function switchToList(dom) {
    dom.containers.list.classList.add('container-active');
    dom.containers.list.classList.remove('container-hidden');
    dom.containers.show.classList.add('container-hidden');
    dom.containers.show.classList.remove('container-active');
    dom.containers.edit.classList.add('container-hidden');
    dom.containers.edit.classList.remove('container-active');
}

export function switchToShow(blog, dom) {
    dom.containers.list.classList.add('container-hidden');
    dom.containers.list.classList.remove('container-active');
    dom.containers.show.classList.add('container-active');
    dom.containers.show.classList.remove('container-hidden');
    dom.containers.edit.classList.add('container-hidden');
    dom.containers.edit.classList.remove('container-active');

    // 隐藏左侧时间过滤器
    const sidebarLeft = document.querySelector('.sidebar-left');
    if (sidebarLeft) sidebarLeft.style.display = 'none';
}

// 加载博客内容
export function loadBlogContent(blog, dom, renderMarkdownFunc) {
    // 显示加载状态
    dom.showLoading.style.display = 'block';
    dom.showContent.style.display = 'none';
    dom.showError.style.display = 'none';

    // 设置标题和标签
    dom.showTitle.textContent = blog.title;
    dom.showTags.innerHTML = '';
    (blog.tags || []).forEach(tag => {
        const tagElement = document.createElement('span');
        tagElement.className = 'tag';
        tagElement.textContent = tag;
        dom.showTags.appendChild(tagElement);
    });

    // 加载并渲染内容
    fetch(blog.path)
        .then(res => {
            if (!res.ok) throw new Error(`加载失败: ${res.statusText}`);
            return res.text();
        })
        .then(markdown => {
            const html = renderMarkdownFunc(markdown);
            dom.showContent.innerHTML = html;

            // 代码高亮
            if (window.Prism) {
                Prism.highlightAll();
            }

            // 渲染数学公式并等待完成后显示内容
            const showContent = () => {
                dom.showLoading.style.display = 'none';
                dom.showContent.style.display = 'block';
            };

            if (window.MathJax) {
                const renderMath = () => {
                    if (window.MathJax.typesetPromise) {
                        return window.MathJax.typesetPromise([dom.showContent])
                            .then(() => {
                                showContent();
                            })
                            .catch(err => {
                                console.warn('MathJax渲染警告:', err);
                                showContent(); // 即使渲染失败也显示内容
                            });
                    }
                    showContent();
                    return Promise.resolve();
                };

                if (window.MathJax.startup && window.MathJax.startup.promise) {
                    window.MathJax.startup.promise
                        .then(renderMath)
                        .catch(err => {
                            console.warn('MathJax初始化警告:', err);
                            showContent();
                        });
                } else if (window.MathJax.typesetPromise) {
                    // 如果 startup 不存在但 typesetPromise 存在，延迟后使用
                    setTimeout(() => {
                        renderMath();
                    }, 100);
                } else {
                    showContent();
                }
            } else {
                showContent();
            }
        })
        .catch(err => {
            console.error('加载博客内容失败:', err);
            dom.showLoading.style.display = 'none';
            dom.showError.textContent = `加载失败: ${err.message}`;
            dom.showError.style.display = 'block';
        });
}

/**
 * Markdown 渲染：先处理 ~~~~ 围栏代码块，再交给 showdown，
 * 最后用 DOMPurify 清洗，避免文章内容注入脚本（存储型 XSS）。
 * @param {string} markdownContent
 * @returns {string}
 */
export function renderMarkdown(markdownContent) {
    // 处理代码块
    let processedContent = String(markdownContent ?? '')
        .replace(/~~~~\{(.*?)\}\n([\s\S]*?)~~~~/g, (match, lang, code) => {
            return `<pre><code class="language-${escapeHtml(lang.trim())}">${escapeHtml(code)}</code></pre>`;
        })
        .replace(/~~~~\n([\s\S]*?)~~~~/g, (match, code) => {
            return `<pre><code>${escapeHtml(code)}</code></pre>`;
        });

    // 使用showdown转换为HTML
    const converter = new showdown.Converter({
        tables: true,
        tasklists: true,
        strikethrough: true,
        ghCodeBlocks: true
    });
    const html = converter.makeHtml(processedContent);

    if (window.DOMPurify) {
        return window.DOMPurify.sanitize(html, {
            ADD_ATTR: ['target', 'rel'],
            ADD_TAGS: ['iframe'] // 允许嵌入视频等，属性仍会被清洗
        });
    }

    console.warn('DOMPurify 未加载，Markdown 输出未经清洗');
    return html;
}

/**
 * HTML 转义
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
